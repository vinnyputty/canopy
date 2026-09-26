import type {
  CanopyAPI,
  EditOptions,
  Issue,
  IssuePatch,
  Status,
  TabState,
  TreeSnapshot,
} from '../shared/types';
import { reconcileSnapshot } from './tree';
import type { StatusPath } from './status-paths';

type Fields = Partial<
  Pick<Issue, 'summary' | 'priority' | 'assignee' | 'status' | 'labels'>
>;
type Change = {
  key: string;
  fields?: Fields;
  anchor?: string;
  position?: 'before' | 'after';
};
type Entry = {
  id: number;
  token?: symbol;
  connectionId: string;
  change: Change;
  before?: Issue;
  order?: string[];
  parentKey?: string;
  statusPath?: Status[];
  undoUnavailable?: boolean;
};
class UndoUnavailable extends Error {}

type Completed = { revision: number; connectionId: string; change: Change };
export type MutationView = {
  snapshots: Record<string, TreeSnapshot>;
  confirmedSnapshots: Record<string, TreeSnapshot>;
  saving: Set<string>;
  undoLabel?: string;
  undoBusy: boolean;
};

export function applyChange(
  snapshot: TreeSnapshot,
  change: Change,
): TreeSnapshot {
  if (change.fields)
    return {
      ...snapshot,
      issues: snapshot.issues.map((issue) =>
        issue.key === change.key ? { ...issue, ...change.fields } : issue,
      ),
    };
  const moving = snapshot.issues.find((issue) => issue.key === change.key);
  const anchor = snapshot.issues.find((issue) => issue.key === change.anchor);
  if (
    !moving ||
    !anchor ||
    !moving.parentKey ||
    moving.parentKey !== anchor.parentKey
  )
    return snapshot;
  const issues = snapshot.issues.filter((issue) => issue.key !== moving.key);
  issues.splice(
    issues.indexOf(anchor) + (change.position === 'after' ? 1 : 0),
    0,
    moving,
  );
  return { ...snapshot, issues };
}

function optimisticFields(
  patch: IssuePatch,
  options?: Partial<EditOptions>,
): Fields {
  const fields: Fields = {};
  if (patch.summary !== undefined) fields.summary = patch.summary;
  if (patch.priorityId !== undefined) {
    const priority = options?.priorities?.find(
      (value) => value.id === patch.priorityId,
    );
    if (priority) fields.priority = priority;
  }
  if (patch.assigneeId !== undefined) {
    const assignee = options?.assignees?.find(
      (value) => value.id === patch.assigneeId,
    );
    if (patch.assigneeId === null || assignee)
      fields.assignee = assignee ?? null;
  }
  if (patch.transitionId !== undefined) {
    const transition = options?.transitions?.find(
      (value) => value.id === patch.transitionId,
    );
    if (transition?.to && !transition.requiresFields)
      fields.status = transition.to;
  }
  return fields;
}

// Confirmed snapshots and replayable pending changes keep rollback local to a write.
// Field writes share an issue queue; ranks share a connection queue.
export class Mutations {
  revision = 0;
  private bases: Record<string, TreeSnapshot> = {};
  private tabs = new Map<string, TabState>();
  private entries: Entry[] = [];
  private completed: Completed[] = [];
  private history: Entry[] = [];
  canUndo(connectionId: string, key: string, token?: symbol) {
    const entry = [...this.history]
      .reverse()
      .find(
        (value) =>
          value.connectionId === connectionId && value.change.key === key,
      );
    return Boolean(
      entry?.before &&
      (!token || entry.token === token) &&
      (!entry.change.fields ||
        !('priority' in entry.change.fields) ||
        entry.before.priority),
    );
  }
  private queues = new Map<string, Promise<void>>();
  private checkingUndo = false;
  private undoingConnection: string | null = null;
  private refreshes = new Map<number, number>();
  private rendered: Record<string, TreeSnapshot> = {};
  private created = new Map<string, { issue: Issue; at: number }>();
  constructor(
    private api: Pick<
      CanopyAPI,
      | 'update'
      | 'rank'
      | 'tree'
      | 'priorities'
      | 'transitions'
      | 'validateAssignee'
    >,
    private changed: (view: MutationView) => void,
    private error: (message: string) => void,
    private confirmedEdit?: (
      connectionId: string,
      issue: Issue,
      fields: string[],
    ) => void,
  ) {}

  beginRefresh() {
    const revision = this.revision;
    this.refreshes.set(revision, (this.refreshes.get(revision) ?? 0) + 1);
    return revision;
  }
  endRefresh(revision: number) {
    const count = (this.refreshes.get(revision) ?? 1) - 1;
    if (count) this.refreshes.set(revision, count);
    else this.refreshes.delete(revision);
    this.prune();
  }
  private prune() {
    const oldest = Math.min(...this.refreshes.keys());
    this.completed = this.completed.filter((done) => done.revision > oldest);
  }
  pending(connectionId: string) {
    return (
      this.undoingConnection === connectionId ||
      this.entries.some((entry) => entry.connectionId === connectionId)
    );
  }
  receive(tab: TabState, snapshot: TreeSnapshot, revision: number) {
    this.tabs.set(tab.id, tab);
    for (const [owner, entry] of this.created) {
      if (Date.now() - entry.at > 5 * 60_000) {
        this.created.delete(owner);
        continue;
      }
      if (!owner.startsWith(`${tab.connectionId}:`)) continue;
      const remote = snapshot.issues.find(
        (issue) => issue.key === entry.issue.key,
      );
      if (remote && remote.parentKey !== entry.issue.parentKey) {
        this.created.delete(owner);
        continue;
      }
      if (
        snapshot.issues.some((issue) => issue.key === entry.issue.parentKey) &&
        !snapshot.issues.some((issue) => issue.key === entry.issue.key)
      )
        snapshot = { ...snapshot, issues: [...snapshot.issues, entry.issue] };
    }
    for (const done of this.completed)
      if (done.connectionId === tab.connectionId && done.revision > revision)
        snapshot = applyChange(snapshot, done.change);
    this.bases[tab.id] = snapshot;
    this.publish();
  }
  confirmedSnapshot(id: string) {
    return this.bases[id];
  }
  insertCreated(connectionId: string, issue: Issue) {
    this.created.set(`${connectionId}:${issue.key}`, { issue, at: Date.now() });
    for (const [id, tab] of this.tabs)
      if (
        tab.connectionId === connectionId &&
        this.bases[id]?.issues.some((value) => value.key === issue.parentKey) &&
        !this.bases[id].issues.some((value) => value.key === issue.key)
      )
        this.bases[id] = {
          ...this.bases[id],
          issues: [...this.bases[id].issues, issue],
        };
    this.publish();
  }
  forget(id: string) {
    this.tabs.delete(id);
    delete this.bases[id];
    this.publish();
  }
  private find(connectionId: string, key: string) {
    for (const [id, tab] of this.tabs)
      if (tab.connectionId === connectionId) {
        const issue = this.bases[id]?.issues.find((value) => value.key === key);
        if (issue) return issue;
      }
  }
  private publish() {
    const snapshots: Record<string, TreeSnapshot> = {};
    for (const [id, base] of Object.entries(this.bases)) {
      let snapshot = base;
      for (const entry of this.entries)
        if (entry.connectionId === this.tabs.get(id)?.connectionId)
          snapshot = applyChange(snapshot, entry.change);
      snapshots[id] = reconcileSnapshot(this.rendered[id], snapshot);
    }
    this.rendered = snapshots;
    const last = this.history.at(-1);
    this.changed({
      snapshots,
      confirmedSnapshots: { ...this.bases },
      saving: new Set(
        this.entries.map(
          (entry) => `${entry.connectionId}:${entry.change.key}`,
        ),
      ),
      undoLabel: last
        ? last.statusPath
          ? `Undo status path for ${last.change.key} (may stop partway)`
          : `Undo ${last.change.fields ? 'edit to' : 'reorder of'} ${last.change.key}`
        : undefined,
      undoBusy: this.checkingUndo || this.entries.length > 0,
    });
  }
  private confirm(connectionId: string, change: Change) {
    this.completed.push({ revision: ++this.revision, connectionId, change });
    this.prune();
    for (const [id, tab] of this.tabs)
      if (tab.connectionId === connectionId && this.bases[id])
        this.bases[id] = applyChange(this.bases[id], change);
    if (change.fields) {
      const issue = this.find(connectionId, change.key);
      if (issue)
        this.confirmedEdit?.(connectionId, issue, Object.keys(change.fields));
    }
  }
  acceptConfirmedLabels(connectionId: string, issue: Issue) {
    this.confirm(connectionId, {
      key: issue.key,
      fields: { labels: issue.labels },
    });
    this.publish();
  }
  private enqueue(
    connectionId: string,
    change: Change,
    execute: (entry: Entry) => Promise<Change>,
    record = true,
    token?: symbol,
  ): Promise<boolean> {
    const entry: Entry = { id: ++this.revision, connectionId, change, token };
    this.entries.push(entry);
    this.publish();
    const queueKey = `${connectionId}:${change.fields ? change.key : 'rank'}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const result = previous.then(async () => {
      entry.before = this.find(connectionId, change.key);
      try {
        const confirmed = await execute(entry);
        this.confirm(connectionId, confirmed);
        entry.change = confirmed;
        if (record && !entry.undoUnavailable) this.history.push(entry);
        return true;
      } catch (error) {
        this.revision++;
        this.error(
          `Couldn’t ${change.fields ? 'update' : 'reorder'} ${change.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        this.entries = this.entries.filter((value) => value !== entry);
        this.publish();
      }
    });
    const tail = result.then(() => {});
    this.queues.set(queueKey, tail);
    void tail.then(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return result;
  }
  update(
    connectionId: string,
    key: string,
    patch: IssuePatch,
    options?: Partial<EditOptions>,
    record = true,
    token?: symbol,
    ifCurrent?: (issue?: Issue) => boolean,
  ) {
    return this.enqueue(
      connectionId,
      { key, fields: optimisticFields(patch, options) },
      async (entry) => {
        if (ifCurrent && !ifCurrent(entry.before)) return { key, fields: {} };
        const issue = await this.api.update(connectionId, key, patch);
        const fields: Fields = {};
        if (patch.summary !== undefined) fields.summary = issue.summary;
        if (patch.priorityId !== undefined) fields.priority = issue.priority;
        if (patch.assigneeId !== undefined) fields.assignee = issue.assignee;
        if (patch.transitionId !== undefined) fields.status = issue.status;
        return { key, fields };
      },
      record,
      token,
    );
  }
  discardHistory(token: symbol) {
    this.history = this.history.filter((entry) => entry.token !== token);
    this.publish();
  }
  transitionPath(
    connectionId: string,
    key: string,
    origin: Status,
    path: StatusPath,
  ) {
    return this.enqueue(connectionId, { key, fields: {} }, async (entry) => {
      let current = await this.api.update(connectionId, key, {});
      if (current.status.id !== origin.id)
        throw new Error(
          `Status changed to ${current.status.name}. Refresh the path and try again.`,
        );
      const visited = new Set([origin.id]);
      entry.statusPath = [origin];
      for (const [index, step] of path.steps.entries()) {
        let stepReturned = false;
        try {
          const choices = await this.api.transitions(connectionId, key, true);
          const choice = choices.find((value) => value.id === step.id);
          if (!choice || choice.to?.id !== step.to.id || choice.requiresFields)
            throw new Error(
              `The planned transition to ${step.to.name} changed or now requires fields.`,
            );
          if (visited.has(step.to.id))
            throw new Error('The planned path contains a cycle.');
          current = await this.api.update(connectionId, key, {
            transitionId: step.id,
          });
          stepReturned = true;
          if (current.status.id !== step.to.id)
            throw new Error(
              `Jira returned ${current.status.name} instead of ${step.to.name}.`,
            );
          visited.add(current.status.id);
          entry.statusPath.push(current.status);
        } catch (error) {
          let statusLabel = 'Actual status';
          try {
            current = await this.api.update(connectionId, key, {});
            if (current.status.id !== entry.statusPath.at(-1)?.id) {
              if (stepReturned) entry.statusPath.push(current.status);
              else entry.undoUnavailable = true;
            }
          } catch {
            statusLabel = 'Last confirmed status (fresh read unavailable)';
            entry.undoUnavailable = true;
          }
          const message = `Stopped ${key} after ${index} of ${path.steps.length} planned transitions. ${statusLabel}: ${current.status.name}. ${error instanceof Error ? error.message : String(error)}`;
          if (entry.statusPath.length === 1 && current.status.id === origin.id)
            throw new Error(message);
          this.error(message);
          return { key, fields: { status: current.status } };
        }
      }
      return { key, fields: { status: current.status } };
    });
  }
  rank(
    connectionId: string,
    key: string,
    anchor: string,
    position: 'before' | 'after' = 'before',
    record = true,
    verifiedSnapshot?: TreeSnapshot,
  ) {
    const rankSnapshot = () =>
      verifiedSnapshot ??
      Object.entries(this.bases).find(
        ([id, snapshot]) =>
          this.tabs.get(id)?.connectionId === connectionId &&
          snapshot.issues.some((issue) => issue.key === key) &&
          snapshot.issues.some((issue) => issue.key === anchor),
      )?.[1];
    const allowed = () => {
      const snapshot = rankSnapshot();
      return (
        snapshot?.ranking?.state === 'supported' &&
        snapshot.ranking.issueKeys.includes(key)
      );
    };
    if (!allowed()) {
      this.error(
        `Couldn’t reorder ${key}: Ranking is not available for this issue. Refresh and check its permissions.`,
      );
      return Promise.resolve(false);
    }
    return this.enqueue(
      connectionId,
      { key, anchor, position },
      async (entry) => {
        const moving = this.find(connectionId, key);
        const target = this.find(connectionId, anchor);
        if (!moving?.parentKey || moving.parentKey !== target?.parentKey)
          throw new Error('Issues can only be reordered among siblings.');
        entry.parentKey = moving.parentKey;
        const base = rankSnapshot();
        if (!allowed())
          throw new Error(
            'Ranking is not available for this issue. Refresh and check its permissions.',
          );
        entry.order = base?.issues
          .filter((issue) => issue.parentKey === moving.parentKey)
          .map((issue) => issue.key);
        await this.api.rank(connectionId, key, anchor, position);
        return { key, anchor, position };
      },
      record,
    );
  }
  async undo(
    connectionId?: string,
    key?: string,
    token?: symbol,
  ): Promise<boolean> {
    const entry =
      connectionId && key
        ? [...this.history]
            .reverse()
            .find(
              (value) =>
                value.connectionId === connectionId && value.change.key === key,
            )
        : this.history.at(-1);
    if (
      !entry ||
      (token && entry.token !== token) ||
      this.checkingUndo ||
      this.entries.length
    )
      return false;
    this.checkingUndo = true;
    this.undoingConnection = entry.connectionId;
    this.publish();
    const revision = this.revision;
    const assertCurrent = () => {
      if (revision !== this.revision || this.entries.length)
        throw new Error(
          'Another edit started while checking Jira. Try undo again after it finishes.',
        );
    };
    try {
      const { connectionId, change, before } = entry;
      const fresh = await this.api.tree(
        connectionId,
        entry.parentKey ?? change.key,
      );
      assertCurrent();
      const current = fresh.issues.find((issue) => issue.key === change.key);
      if (!current || !before)
        throw new UndoUnavailable('The issue is no longer available.');
      if (entry.statusPath) {
        const path = entry.statusPath;
        if (current.status.id !== path.at(-1)?.id)
          throw new UndoUnavailable(
            'The status changed in Jira. Refresh and review it before undoing.',
          );
        let actual = current.status;
        let reversed = 0;
        let undoRevision = revision;
        const assertUndoCurrent = () => {
          if (undoRevision !== this.revision || this.entries.length)
            throw new Error(
              'Another edit started during Undo. Review the current status before trying again.',
            );
        };
        try {
          for (let index = path.length - 2; index >= 0; index--) {
            assertUndoCurrent();
            const choices = await this.api.transitions(
              connectionId,
              change.key,
              true,
            );
            assertUndoCurrent();
            const reverse = choices.find(
              (choice) =>
                choice.to?.id === path[index].id && !choice.requiresFields,
            );
            if (!reverse)
              throw new UndoUnavailable(
                `No supported reverse transition from ${actual.name} to ${path[index].name}.`,
              );
            const result = await this.api.update(connectionId, change.key, {
              transitionId: reverse.id,
            });
            actual = result.status;
            this.confirm(connectionId, {
              key: change.key,
              fields: { status: actual },
            });
            undoRevision = this.revision;
            this.publish();
            if (actual.id !== path[index].id)
              throw new Error(
                `Jira returned ${actual.name} instead of ${path[index].name}.`,
              );
            reversed++;
          }
        } catch (error) {
          let statusLabel = 'Actual status';
          try {
            actual = (await this.api.update(connectionId, change.key, {}))
              .status;
            this.confirm(connectionId, {
              key: change.key,
              fields: { status: actual },
            });
          } catch {
            statusLabel = 'Last confirmed status (fresh read unavailable)';
          }
          this.history = this.history.filter((value) => value !== entry);
          this.error(
            `Undo stopped after ${reversed} of ${path.length - 1} reverse transitions. ${statusLabel}: ${actual.name}. ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
        this.history = this.history.filter((value) => value !== entry);
        return true;
      }
      let patch: IssuePatch | undefined;
      let options: EditOptions | undefined;
      let anchor: string | undefined;
      let position: 'before' | 'after' = 'before';
      if (change.fields) {
        for (const field of Object.keys(change.fields) as (keyof Fields)[])
          if (
            JSON.stringify(current[field]) !==
            JSON.stringify(change.fields[field])
          )
            throw new UndoUnavailable(
              'The field changed in Jira. Refresh and review it before editing again.',
            );
        patch = {};
        if ('summary' in change.fields) patch.summary = before.summary;
        if ('assignee' in change.fields)
          patch.assigneeId = before.assignee?.id ?? null;
        if ('priority' in change.fields) {
          if (!before.priority)
            throw new UndoUnavailable(
              'The previous empty priority cannot be restored.',
            );
          patch.priorityId = before.priority.id;
        }
        options = { priorities: [], assignees: [], transitions: [] };
        if ('priority' in change.fields) {
          options.priorities = await this.api.priorities(
            connectionId,
            change.key,
            true,
          );
          assertCurrent();
          if (
            !options.priorities.some(
              (choice) => choice.id === patch!.priorityId,
            )
          )
            throw new UndoUnavailable(
              'The previous priority is no longer available.',
            );
        }
        if ('status' in change.fields) {
          options.transitions = await this.api.transitions(
            connectionId,
            change.key,
            true,
          );
          assertCurrent();
          const reverse = options.transitions.find(
            (value) =>
              value.to?.id === before.status.id && !value.requiresFields,
          );
          if (!reverse)
            throw new UndoUnavailable(
              'The current workflow has no supported transition back.',
            );
          patch.transitionId = reverse.id;
        }
        if ('assignee' in change.fields && before.assignee) {
          const user = await this.api.validateAssignee(
            connectionId,
            change.key,
            before.assignee.id,
            true,
          );
          assertCurrent();
          if (!user)
            throw new UndoUnavailable(
              'The previous assignee is no longer assignable, or Jira’s limited user discovery could not confirm eligibility.',
            );
          options.assignees = [user];
        }
      } else {
        if (fresh.reconcilingRankParents?.includes(entry.parentKey!))
          throw new Error(
            'Jira sibling order is still catching up. Try undo again after a refresh.',
          );
        if (
          fresh.ranking?.state !== 'supported' ||
          !fresh.ranking.issueKeys.includes(change.key)
        )
          throw new UndoUnavailable(
            'Ranking is no longer available for this issue. Refresh and check its permissions.',
          );
        const order = entry.order ?? [];
        const expected = applyChange(
          {
            ...fresh,
            issues: order
              .map((key) => fresh.issues.find((issue) => issue.key === key)!)
              .filter(Boolean),
          },
          change,
        ).issues.map((issue) => issue.key);
        const actual = fresh.issues
          .filter((issue) => issue.parentKey === entry.parentKey)
          .map((issue) => issue.key);
        if (
          actual.length !== order.length ||
          JSON.stringify(expected) !== JSON.stringify(actual) ||
          current.parentKey !== entry.parentKey
        )
          throw new UndoUnavailable(
            'Sibling order changed in Jira. Refresh and review it before reordering again.',
          );
        const index = order.indexOf(change.key);
        anchor = order[index + 1] ?? order[index - 1];
        position = order[index + 1] ? 'before' : 'after';
        if (!anchor)
          throw new UndoUnavailable('The original rank cannot be restored.');
      }
      assertCurrent();
      const success = patch
        ? await this.update(connectionId, change.key, patch, options, false)
        : await this.rank(
            connectionId,
            change.key,
            anchor!,
            position,
            false,
            fresh,
          );
      if (success)
        this.history = this.history.filter((value) => value !== entry);
      return success;
    } catch (error) {
      if (error instanceof UndoUnavailable)
        this.history = this.history.filter((value) => value !== entry);
      this.error(
        `Couldn’t undo: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      this.checkingUndo = false;
      this.undoingConnection = null;
      this.publish();
    }
  }
}
