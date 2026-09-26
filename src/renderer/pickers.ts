import type { CanopyAPI, Choice, EditOptions, Issue } from '../shared/types';

export type PickerField = 'priority' | 'assignee' | 'status';
export type FieldLoad = {
  loading?: boolean;
  validating?: boolean;
  error?: string;
};
export type PickerOptions = Partial<EditOptions> & {
  priority?: FieldLoad;
  assignee?: FieldLoad;
  status?: FieldLoad;
  query?: string;
  assigneeResultQuery?: string;
  nextStartAt?: number;
};
type API = Pick<
  CanopyAPI,
  | 'priorities'
  | 'transitions'
  | 'cachedUsers'
  | 'assignees'
  | 'validateAssignee'
>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const merge = (users: Choice[], added: Choice[]) => [
  ...new Map([...users, ...added].map((user) => [user.id, user])).values(),
];

// Sequence guards keep independent fields and obsolete connection/query results apart.
export class Pickers {
  values: Record<string, PickerOptions> = {};
  private sequences = new Map<string, number>();
  private statuses = new Map<string, string>();
  private pendingStatuses = new Map<string, Promise<void>>();
  constructor(
    private api: API,
    private changed: (values: Record<string, PickerOptions>) => void,
  ) {}
  private scoped(connection: string, key: string) {
    return `${connection}:${key}`;
  }
  private set(scope: string, patch: Partial<PickerOptions>) {
    this.values = {
      ...this.values,
      [scope]: { ...this.values[scope], ...patch },
    };
    this.changed(this.values);
  }
  private sequence(scope: string, field: PickerField) {
    const id = `${scope}:${field}`;
    const sequence = (this.sequences.get(id) ?? 0) + 1;
    this.sequences.set(id, sequence);
    return () => this.sequences.get(id) === sequence;
  }
  clear() {
    this.values = {};
    for (const [key, value] of this.sequences)
      this.sequences.set(key, value + 1);
    this.statuses.clear();
    this.pendingStatuses.clear();
    this.changed(this.values);
  }
  observe(connection: string, issues: Issue[]) {
    for (const issue of issues) {
      const scope = this.scoped(connection, issue.key);
      const previous = this.statuses.get(scope);
      this.statuses.set(scope, issue.status.id);
      if (previous !== undefined && previous !== issue.status.id) {
        const errors = Object.fromEntries(
          (['priority', 'assignee', 'status'] as const).flatMap((field) =>
            this.values[scope]?.[field]?.error
              ? [[field, this.values[scope][field]]]
              : [],
          ),
        );
        this.invalidate(connection, issue.key);
        if (Object.keys(errors).length) this.set(scope, errors);
      }
    }
  }
  invalidate(connection: string, key: string) {
    const scope = this.scoped(connection, key);
    this.pendingStatuses.delete(scope);
    for (const field of ['priority', 'assignee', 'status'] as const)
      this.sequence(scope, field);
    const values = { ...this.values };
    delete values[scope];
    this.values = values;
    this.changed(values);
  }
  close(connection: string, key: string, field: PickerField) {
    if (field !== 'assignee') return;
    const scope = this.scoped(connection, key);
    this.sequence(scope, field);
    this.set(scope, {
      assignees: undefined,
      assignee: undefined,
      query: undefined,
      assigneeResultQuery: undefined,
      nextStartAt: undefined,
    });
  }
  changeQuery(connection: string, key: string, query: string) {
    const scope = this.scoped(connection, key);
    this.sequence(scope, 'assignee');
    this.set(scope, { query, nextStartAt: 0, assignee: { loading: true } });
  }
  async open(connection: string, key: string, field: PickerField) {
    if (field === 'status') {
      const scope = this.scoped(connection, key);
      const previous = this.values[scope];
      if (previous?.transitions && !previous.status?.error) return;
      const pending = this.pendingStatuses.get(scope);
      if (pending) return pending;
      const load = this.load(
        connection,
        key,
        field,
        '',
        false,
        Boolean(previous?.status?.error),
      );
      this.pendingStatuses.set(scope, load);
      try {
        await load;
      } finally {
        if (this.pendingStatuses.get(scope) === load)
          this.pendingStatuses.delete(scope);
      }
      return;
    }
    if (field !== 'assignee') return this.load(connection, key, field);
    const scope = this.scoped(connection, key);
    const current = this.sequence(scope, field);
    this.set(scope, {
      assignee: { loading: true },
      query: '',
      assigneeResultQuery: undefined,
      assignees: undefined,
      nextStartAt: 0,
    });
    try {
      const users = await this.api.cachedUsers(connection);
      if (!current()) return;
      this.set(scope, { assignees: users, assignee: {} });
      if (!users.length) await this.load(connection, key, field, '', false);
    } catch (error) {
      if (current()) this.set(scope, { assignee: { error: message(error) } });
    }
  }
  async load(
    connection: string,
    key: string,
    field: PickerField,
    query = '',
    more = false,
    refresh = false,
  ) {
    const scope = this.scoped(connection, key);
    const previous = this.values[scope];
    if (
      more &&
      (previous?.assignee?.loading || previous?.nextStartAt === undefined)
    )
      return;
    const startAt = more ? previous!.nextStartAt! : 0;
    const current = this.sequence(scope, field);
    this.set(scope, {
      [field]: { loading: true },
      ...(field === 'assignee'
        ? {
            query,
            assignees:
              more || previous?.query === query
                ? previous?.assignees
                : undefined,
          }
        : {}),
    });
    try {
      if (field === 'priority') {
        const priorities = await this.api.priorities(connection, key, refresh);
        if (current()) this.set(scope, { priorities, priority: {} });
      } else if (field === 'status') {
        const transitions = await this.api.transitions(
          connection,
          key,
          refresh,
        );
        if (current()) this.set(scope, { transitions, status: {} });
      } else {
        const page = await this.api.assignees(
          connection,
          key,
          query,
          startAt,
          refresh,
        );
        if (current())
          this.set(scope, {
            assignees: merge(
              more ? (previous?.assignees ?? []) : [],
              page.users,
            ),
            assigneeResultQuery: query,
            nextStartAt: page.nextStartAt,
            assignee: {},
          });
      }
    } catch (error) {
      if (current()) this.set(scope, { [field]: { error: message(error) } });
    }
  }
  async validate(
    connection: string,
    key: string,
    accountId: string,
  ): Promise<boolean> {
    const scope = this.scoped(connection, key);
    const current = this.sequence(scope, 'assignee');
    this.set(scope, { assignee: { loading: true, validating: true } });
    try {
      const user = await this.api.validateAssignee(
        connection,
        key,
        accountId,
        true,
      );
      if (!current()) return false;
      if (!user)
        throw new Error(
          'Jira could not confirm this person is assignable to this issue. Search discovery is limited to the first 1,000 users.',
        );
      this.set(scope, {
        assignees: merge(this.values[scope]?.assignees ?? [], [user]),
        assignee: {},
      });
      return true;
    } catch (error) {
      if (current()) this.set(scope, { assignee: { error: message(error) } });
      return false;
    }
  }
  rejected(connection: string, key: string, field: PickerField) {
    const scope = this.scoped(connection, key);
    if (field === 'status') {
      this.sequence(scope, field);
      this.pendingStatuses.delete(scope);
    }
    this.set(scope, {
      ...(field === 'status' ? { transitions: undefined } : {}),
      [field]: {
        error:
          'This selection was rejected. Retry to refresh the available choices.',
      },
    });
  }
}
