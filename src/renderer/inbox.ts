import type {
  CanopyAPI,
  Connection,
  Issue,
  IssueRelationships,
  TreeSnapshot,
  Workspace,
} from '../shared/types';
import { triageIdentity } from '../shared/triage';
import { nextTasks, type NextTask } from './next-tasks';
import { relationshipBlockers } from './relationships';
import { seenRootKey, unseenChanges } from './seen';
import type { ViewSource } from './saved-views';

export type InboxCandidate = {
  issue: Issue;
  source: ViewSource;
  roots: ViewSource[];
  fetchedAt: number;
  stamp: string;
};
export type InboxItem = InboxCandidate & {
  reasons: string[];
  pinned: boolean;
  snoozedUntil?: number;
  blockerUnknown: boolean;
};
// Poll time updates confirmation display, not the identity of confirmed data.
export const inboxStamp = (_snapshot: TreeSnapshot, issue: Issue) =>
  JSON.stringify(issue);
export type InboxGraph = {
  revision?: number;
  stamp: string;
  graph?: IssueRelationships;
  error?: string;
};
export function inboxCandidates(
  sources: ViewSource[],
  snapshots: Record<string, TreeSnapshot>,
  connections: Connection[],
): InboxCandidate[] {
  const found = new Map<string, InboxCandidate>();
  for (const source of sources) {
    const snapshot = snapshots[source.id];
    const connection = connections.find(
      (item) => item.id === source.connectionId,
    );
    if (!snapshot || !connection) continue;
    for (const issue of snapshot.issues) {
      if (
        connection.provider === 'github' &&
        issue.key === snapshot.rootKey &&
        issue.type === 'Repository'
      )
        continue;
      const id = triageIdentity(source.connectionId, issue.key);
      const previous = found.get(id);
      const roots = [...(previous?.roots ?? []), source];
      const candidate = {
        issue,
        source,
        roots,
        fetchedAt: snapshot.fetchedAt,
        stamp: inboxStamp(snapshot, issue),
      };
      found.set(
        id,
        previous && previous.fetchedAt > snapshot.fetchedAt
          ? { ...previous, roots }
          : candidate,
      );
    }
  }
  return [...found.values()];
}
export function inboxItems(
  candidates: InboxCandidate[],
  workspace: Workspace,
  connections: Connection[],
  snapshots: Record<string, TreeSnapshot>,
  users: Record<string, { id: string }>,
  graphs: Record<string, InboxGraph>,
  now: number,
): InboxItem[] {
  const byIdentity = new Map(
    candidates.map((candidate) => [
      triageIdentity(candidate.source.connectionId, candidate.issue.key),
      candidate,
    ]),
  );
  const tasks = new Map<
    string,
    Map<string, Pick<NextTask, 'blocker' | 'blockers' | 'incomplete'>>
  >();
  for (const source of new Map(
    candidates.map((candidate) => [candidate.source.id, candidate.source]),
  ).values()) {
    const snapshot = snapshots[source.id];
    const connection = connections.find(
      (connection) => connection.id === source.connectionId,
    );
    if (!snapshot || !connection) continue;
    const inspected = Object.fromEntries(
      snapshot.issues.flatMap((issue) => {
        const id = triageIdentity(source.connectionId, issue.key);
        const entry = graphs[id];
        return entry?.graph &&
          entry.graph.key === issue.key &&
          entry.stamp === byIdentity.get(id)?.stamp
          ? [[issue.key, entry.graph]]
          : [];
      }),
    );
    tasks.set(
      source.id,
      new Map(
        nextTasks(
          snapshot,
          connection.provider,
          'blocked',
          undefined,
          false,
          undefined,
          inspected,
        ).map((task) => [task.issue.key, task]),
      ),
    );
    const known = new Map(snapshot.issues.map((issue) => [issue.key, issue]));
    for (const issue of snapshot.issues) {
      if (!tasks.get(source.id)!.has(issue.key))
        tasks
          .get(source.id)!
          .set(
            issue.key,
            relationshipBlockers(
              connection.provider === 'github'
                ? { ...issue, linksAvailable: false }
                : issue,
              inspected[issue.key],
              known,
            ),
          );
    }
  }
  return candidates
    .flatMap((candidate) => {
      const { issue, source } = candidate;
      const preference = workspace.triage?.items.find(
        (item) =>
          item.connectionId === source.connectionId &&
          item.issueKey === issue.key,
      );
      const reasons: string[] = [];
      const changed = candidate.roots.some((root) => {
        const changes = unseenChanges(
          workspace.seenRoots?.[seenRootKey(root.connectionId, root.rootKey)]
            ?.issues[issue.key],
          issue,
        );
        return changes.fields.length > 0 || changes.comments > 0;
      });
      if (changed) reasons.push('Unread changes');
      if (
        issue.status.category !== 'done' &&
        !issue.unavailableFields?.includes('assignee') &&
        users[source.connectionId] &&
        users[source.connectionId].id === issue.assignee?.id
      )
        reasons.push('Assigned to you');
      const task = tasks.get(source.id)?.get(issue.key);
      if (issue.status.category !== 'done' && task?.blocker === 'blocked')
        reasons.push(`Blocked by ${task.blockers.join(', ')}`);
      if (
        !issue.unavailableFields?.includes('status') &&
        workspace.triage?.reviewStatuses[source.connectionId]?.includes(
          issue.status.name,
        )
      )
        reasons.push(`Review: ${issue.status.name}`);
      if (preference?.pinned) reasons.push('Pinned locally');
      if (!reasons.length) return [];
      return [
        {
          ...candidate,
          reasons,
          pinned: preference?.pinned ?? false,
          snoozedUntil:
            preference?.snoozedUntil && preference.snoozedUntil > now
              ? preference.snoozedUntil
              : undefined,
          blockerUnknown:
            task?.blocker === 'unknown' || Boolean(task?.incomplete),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.fetchedAt - a.fetchedAt ||
        a.issue.key.localeCompare(b.issue.key),
    );
}

/** One bounded read at a time; cancellation guards even transports that ignore abort. */
export class InboxInspection {
  private generation = 0;
  // Session-only authority; a manual source refresh is not a target change.
  revision = 0;
  private changedAt = new Map<string, number>();
  private sourceChangedAt = new Map<string, number>();
  current(connectionId: string, key: string, entry: InboxGraph) {
    const revision = entry.revision ?? 0;
    return (
      (this.sourceChangedAt.get(triageIdentity(connectionId, key)) ?? 0) <=
        revision &&
      (entry.graph?.groups.flatMap((group) => group.items) ?? []).every(
        (item) =>
          (this.changedAt.get(triageIdentity(connectionId, item.key)) ?? 0) <=
          revision,
      )
    );
  }
  invalidate(connectionId: string, keys: string[], changed: Set<string>) {
    if (!keys.length && !changed.size) return;
    const sources = new Set(keys);
    const revision = ++this.revision;
    for (const key of keys)
      this.sourceChangedAt.set(triageIdentity(connectionId, key), revision);
    for (const key of changed)
      this.changedAt.set(triageIdentity(connectionId, key), revision);
    const cancelSource =
      this.pending?.connectionId === connectionId &&
      sources.has(this.pending.issueKey);
    if (this.pending?.connectionId === connectionId)
      for (const key of changed) this.pending.changed.add(key);
    this.entries = Object.fromEntries(
      Object.entries(this.entries).filter(([identity, entry]) => {
        const [owner, key] = JSON.parse(identity);
        return owner !== connectionId || this.current(owner, key, entry);
      }),
    );
    if (cancelSource) this.cancel();
    this.publish({ ...this.entries }, this.busy);
  }
  private pending?: {
    connectionId: string;
    issueKey: string;
    stamp: string;
    requestId: string;
    changed: Set<string>;
  };
  private candidates?: Map<string, string>;
  private entries: Record<string, InboxGraph> = {};
  busy = false;
  constructor(
    private api: Pick<
      CanopyAPI,
      'relationships' | 'cancelRelationships' | 'syncStatus'
    >,
    private publish: (
      entries: Record<string, InboxGraph>,
      busy: boolean,
    ) => void,
  ) {}
  cancel() {
    this.generation++;
    if (this.pending)
      void this.api
        .cancelRelationships(this.pending.connectionId, this.pending.requestId)
        .catch(() => {});
    this.pending = undefined;
    this.busy = false;
    this.publish({ ...this.entries }, false);
  }
  reset(candidates: InboxCandidate[], seed: Record<string, InboxGraph> = {}) {
    const next = new Map(
      candidates.map((candidate) => [
        triageIdentity(candidate.source.connectionId, candidate.issue.key),
        candidate.stamp,
      ]),
    );
    const changed = new Map<string, Set<string>>();
    for (const [identity, stamp] of this.candidates ?? []) {
      const [connectionId, key] = JSON.parse(identity);
      if (next.get(identity) !== stamp) {
        const keys = changed.get(connectionId) ?? new Set<string>();
        keys.add(key);
        changed.set(connectionId, keys);
        if (this.pending && connectionId === this.pending.connectionId)
          this.pending.changed.add(key);
      }
    }
    this.candidates = next;
    if (
      this.pending &&
      this.candidates.get(
        triageIdentity(this.pending.connectionId, this.pending.issueKey),
      ) !== this.pending.stamp
    )
      this.cancel();
    this.entries = Object.fromEntries(
      candidates.flatMap((candidate) => {
        const id = triageIdentity(
          candidate.source.connectionId,
          candidate.issue.key,
        );
        const entry =
          this.entries[id]?.stamp === candidate.stamp
            ? this.entries[id]
            : seed[id]?.stamp === candidate.stamp
              ? seed[id]
              : undefined;
        const targetChanged = entry?.graph?.groups.some((group) =>
          group.items.some((link) =>
            changed.get(candidate.source.connectionId)?.has(link.key),
          ),
        );
        return entry &&
          this.current(
            candidate.source.connectionId,
            candidate.issue.key,
            entry,
          ) &&
          !targetChanged &&
          (!entry.graph || entry.graph.key === candidate.issue.key)
          ? [[id, entry]]
          : [];
      }),
    );
    this.publish({ ...this.entries }, this.busy);
  }
  async load(candidates: InboxCandidate[], retry = false) {
    if (this.busy) return;
    this.candidates = new Map(
      candidates.map((candidate) => [
        triageIdentity(candidate.source.connectionId, candidate.issue.key),
        candidate.stamp,
      ]),
    );
    const generation = this.generation;
    const selected = candidates
      .filter((candidate) => {
        if (candidate.issue.status.category === 'done') return false;
        const entry =
          this.entries[
            triageIdentity(candidate.source.connectionId, candidate.issue.key)
          ];
        const blockers = entry?.graph?.groups.find(
          (group) => group.kind === 'blockers',
        );
        const partial =
          blockers?.state !== 'visible' ||
          blockers.items.some((item) => item.statusCategory === undefined);
        return (
          !entry ||
          entry.stamp !== candidate.stamp ||
          (retry && (entry.error || partial))
        );
      })
      .slice(0, 20);
    this.busy = true;
    this.publish({ ...this.entries }, true);
    const throttled = new Map<string, string>();
    for (const candidate of selected) {
      const { connectionId } = candidate.source;
      const id = triageIdentity(connectionId, candidate.issue.key);
      if (this.candidates && this.candidates.get(id) !== candidate.stamp)
        continue;
      const requestId = globalThis.crypto.randomUUID();
      this.pending = {
        connectionId,
        issueKey: candidate.issue.key,
        stamp: candidate.stamp,
        requestId,
        changed: new Set(),
      };
      const previous = () =>
        this.entries[id]?.stamp === candidate.stamp
          ? this.entries[id]
          : undefined;
      try {
        if (throttled.has(connectionId)) {
          this.entries[id] = {
            ...previous(),
            revision: this.revision,
            stamp: candidate.stamp,
            error: throttled.get(connectionId),
          };
          this.publish({ ...this.entries }, true);
          continue;
        }
        const status = await this.api.syncStatus(connectionId);
        if (generation !== this.generation) return;
        if (status.retryAt && status.retryAt > Date.now()) {
          this.entries[id] = {
            ...previous(),
            revision: this.revision,
            stamp: candidate.stamp,
            error: `Rate limited until ${new Date(status.retryAt).toLocaleString()}. Retry after this time.`,
          };
          throttled.set(connectionId, this.entries[id].error!);
          // Do not spend the rest of the page on a throttled connection.
          this.publish({ ...this.entries }, true);
          continue;
        }
        const graph = await this.api.relationships(
          connectionId,
          candidate.issue.key,
          requestId,
        );
        if (generation !== this.generation) return;
        if (graph.key !== candidate.issue.key) throw new Error('Wrong issue');
        const changed = this.pending?.changed ?? new Set<string>();
        this.entries[id] = {
          revision: this.revision,
          stamp: candidate.stamp,
          graph: {
            ...graph,
            groups: graph.groups.map((group) =>
              group.items.some((link) => changed.has(link.key))
                ? {
                    ...group,
                    state:
                      group.state === 'unavailable' ? 'unavailable' : 'partial',
                    problem: 'invalid',
                    reason:
                      'Target data changed while relationships were loading. Inspect again for current results.',
                    items: group.items.map((link) =>
                      changed.has(link.key)
                        ? {
                            ...link,
                            statusCategory: undefined,
                            access:
                              link.access === 'outside-connection'
                                ? 'outside-connection'
                                : 'unknown',
                          }
                        : link,
                    ),
                  }
                : group,
            ),
          },
        };
      } catch {
        if (generation !== this.generation) return;
        this.entries[id] = {
          ...previous(),
          revision: this.revision,
          stamp: candidate.stamp,
          error: 'Blockers could not be inspected. Retry.',
        };
      }
      this.publish({ ...this.entries }, true);
    }
    if (generation !== this.generation) return;
    this.pending = undefined;
    this.busy = false;
    this.publish({ ...this.entries }, false);
  }
}
