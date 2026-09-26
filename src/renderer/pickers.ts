import type { CanopyAPI, Choice, EditOptions, Issue } from '../shared/types';
import { statusPaths } from './status-paths';

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
> &
  Partial<Pick<CanopyAPI, 'workflowGraph'>>;
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
  private issueTypes = new Map<string, string>();
  private pendingStatuses = new Map<string, Promise<void>>();
  private statusChoiceContexts = new Map<string, string>();
  private freshStatuses = new Set<string>();
  private statusTrees = new Map<
    string,
    Map<string, EditOptions['transitions']>
  >();
  private pendingTreeStatuses = new Map<string, Promise<void>>();
  private workflowGraphAttempted = new Set<string>();
  private verifiedTreeStatuses = new Set<string>();
  constructor(
    private api: API,
    private changed: (values: Record<string, PickerOptions>) => void,
  ) {}
  private scoped(connection: string, key: string) {
    return `${connection}:${key}`;
  }
  private typeKey(issue: Issue) {
    return issue.projectId && issue.typeId
      ? JSON.stringify([issue.projectId, issue.typeId])
      : issue.type;
  }
  paths(connection: string, rootKey: string, issue: Issue) {
    const root = JSON.stringify([connection, rootKey]);
    const type = this.typeKey(issue);
    const graph: Record<string, EditOptions['transitions']> = {};
    for (const [pair, choices] of this.statusTrees.get(root) ?? []) {
      const [choiceType, status] = JSON.parse(pair) as [string, string];
      if (choiceType === type) graph[status] = choices;
    }
    const direct = this.values[this.scoped(connection, issue.key)]?.transitions;
    return direct ? statusPaths(issue.status, direct, graph) : [];
  }
  private async loadPathGraph(
    connection: string,
    rootKey: string,
    issue: Issue,
  ) {
    if (!issue.projectId || !issue.typeId || !this.api.workflowGraph) return;
    const root = JSON.stringify([connection, rootKey]);
    let tree = this.statusTrees.get(root);
    if (!tree) {
      tree = new Map();
      this.statusTrees.set(root, tree);
    }
    const type = this.typeKey(issue);
    const scope = JSON.stringify([root, type]);
    if (this.workflowGraphAttempted.has(scope)) return;
    this.workflowGraphAttempted.add(scope);
    try {
      const graph = await this.api.workflowGraph(
        connection,
        issue.projectId,
        issue.typeId,
      );
      if (!graph || this.statusTrees.get(root) !== tree) return;
      for (const [status, choices] of Object.entries(graph)) {
        const pair = JSON.stringify([type, status]);
        const existing = tree.get(pair) ?? [];
        const ids = new Set(existing.map((choice) => choice.id));
        const merged = [...existing];
        for (const choice of choices)
          if (!ids.has(choice.id)) {
            merged.push(choice);
            ids.add(choice.id);
          }
        tree.set(pair, merged);
      }
      this.changed({ ...this.values });
    } catch {
      this.workflowGraphAttempted.delete(scope);
    }
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
    this.issueTypes.clear();
    this.pendingStatuses.clear();
    this.statusChoiceContexts.clear();
    this.freshStatuses.clear();
    this.statusTrees.clear();
    this.pendingTreeStatuses.clear();
    this.workflowGraphAttempted.clear();
    this.verifiedTreeStatuses.clear();
    this.changed(this.values);
  }
  async prime(connection: string, rootKey: string, issues: Issue[]) {
    this.observe(connection, issues);
    const root = JSON.stringify([connection, rootKey]);
    let tree = this.statusTrees.get(root);
    if (!tree) {
      tree = new Map();
      this.statusTrees.set(root, tree);
    }
    const workflowTypes = new Map<string, Issue>();
    for (const issue of issues)
      if (issue.projectId && issue.typeId)
        workflowTypes.set(this.typeKey(issue), issue);
    await Promise.all(
      [...workflowTypes.values()].map((issue) =>
        this.loadPathGraph(connection, rootKey, issue),
      ),
    );
    const representatives = new Map<string, string>();
    for (const issue of issues)
      if (issue.status.id) {
        const pair = JSON.stringify([this.typeKey(issue), issue.status.id]);
        if (!representatives.has(pair)) representatives.set(pair, issue.key);
      }
    await Promise.all(
      [...representatives].map(async ([pair, key]) => {
        const scope = JSON.stringify([root, pair]);
        if (this.verifiedTreeStatuses.has(scope)) return;
        let pending = this.pendingTreeStatuses.get(scope);
        if (!pending) {
          pending = this.api.transitions(connection, key).then(
            (choices) => {
              if (this.statusTrees.get(root) === tree) {
                tree!.set(pair, choices);
                this.verifiedTreeStatuses.add(scope);
              }
            },
            () => {
              // A failed prefetch falls back to the issue's normal load.
            },
          );
          this.pendingTreeStatuses.set(scope, pending);
          void pending.finally(() => {
            if (this.pendingTreeStatuses.get(scope) === pending)
              this.pendingTreeStatuses.delete(scope);
          });
        }
        await pending;
      }),
    );
  }
  observe(connection: string, issues: Issue[]) {
    for (const issue of issues) {
      const scope = this.scoped(connection, issue.key);
      const previous = this.statuses.get(scope);
      this.statuses.set(scope, issue.status.id);
      this.issueTypes.set(scope, this.typeKey(issue));
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
    this.statusChoiceContexts.delete(scope);
    for (const field of ['priority', 'assignee', 'status'] as const)
      this.sequence(scope, field);
    const values = { ...this.values };
    delete values[scope];
    this.values = values;
    this.changed(values);
  }
  revalidateStatus(connection: string, key: string) {
    this.invalidate(connection, key);
    this.freshStatuses.add(this.scoped(connection, key));
  }
  clearStatusChoices(connection: string, issues: Issue[]) {
    for (const issue of issues) {
      const scope = this.scoped(connection, issue.key);
      this.sequence(scope, 'status');
      this.pendingStatuses.delete(scope);
      this.statusChoiceContexts.delete(scope);
      if (this.values[scope])
        this.set(scope, { transitions: undefined, status: undefined });
    }
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
  async open(
    connection: string,
    key: string,
    field: PickerField,
    rootKey?: string,
    assumeMatchingStatusTransitions = false,
    issue?: Issue,
  ) {
    if (field === 'status') {
      if (rootKey && issue) void this.loadPathGraph(connection, rootKey, issue);
      const scope = this.scoped(connection, key);
      const previous = this.values[scope];
      const fresh =
        this.freshStatuses.has(scope) || Boolean(previous?.status?.error);
      const status = issue?.status.id ?? this.statuses.get(scope);
      const type = issue ? this.typeKey(issue) : this.issueTypes.get(scope);
      const context = JSON.stringify([rootKey, type, status]);
      if (
        previous?.transitions &&
        !fresh &&
        (!this.statusChoiceContexts.has(scope) ||
          this.statusChoiceContexts.get(scope) === context)
      )
        return;
      if (rootKey && assumeMatchingStatusTransitions && !fresh) {
        const root = JSON.stringify([connection, rootKey]);
        const pair = JSON.stringify([type, status]);
        const shared = this.statusTrees.get(root)?.get(pair);
        if (
          shared &&
          (shared.length ||
            this.verifiedTreeStatuses.has(JSON.stringify([root, pair])))
        ) {
          this.set(scope, { transitions: shared, status: {} });
          this.statusChoiceContexts.set(scope, context);
          return;
        }
      }
      const pending = this.pendingStatuses.get(scope);
      if (pending) return pending;
      const load = this.load(connection, key, field, '', false, fresh);
      this.pendingStatuses.set(scope, load);
      try {
        await load;
      } finally {
        if (this.pendingStatuses.get(scope) === load) {
          this.pendingStatuses.delete(scope);
          if (!this.values[scope]?.status?.error) {
            this.freshStatuses.delete(scope);
            if (this.values[scope]?.transitions)
              this.statusChoiceContexts.set(scope, context);
          }
        }
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
        this.statusChoiceContexts.delete(scope);
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
      this.statusChoiceContexts.delete(scope);
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
