import type {
  Issue,
  IssueRelationships,
  TabState,
  TreeSnapshot,
} from '../shared/types';
import { ancestorPath, buildIssueTree } from './tree';
import { issueRelationships } from '../shared/relationships';

export function relationshipBlockers(
  issue: Issue,
  graph?: IssueRelationships,
  known: Map<string, Issue> = new Map(),
) {
  const group = (graph ?? issueRelationships(issue)).groups.find(
    (value) => value.kind === 'blockers',
  );
  const incoming = group?.items ?? [];
  const status = (key: string, fallback?: Issue['status']['category']) => {
    // A fresh graph is authoritative even when its target status is missing.
    if (graph) return fallback;
    const target = known.get(key);
    return (
      fallback ??
      (target && !target.unavailableFields?.includes('status')
        ? target.status.category
        : undefined)
    );
  };
  const active = incoming.filter((link) => {
    const category = status(link.key, link.statusCategory);
    return category !== undefined && category !== 'done';
  });
  const incomplete =
    group?.state !== 'visible' ||
    incoming.some(
      (link) => status(link.key, link.statusCategory) === undefined,
    );
  return {
    blocker: active.length
      ? ('blocked' as const)
      : incomplete
        ? ('unknown' as const)
        : ('clear' as const),
    blockers: active.map((link) => link.key),
    blockerDetails: incoming
      .filter((link) => status(link.key, link.statusCategory) !== 'done')
      .map((link) => ({
        ...link,
        statusCategory: status(link.key, link.statusCategory),
      })),
    blockerReason: group?.reason,
    incomplete,
  };
}

/** Select an owning hierarchy only within the same authenticated provider connection. */
export function relationshipDestination(
  connectionId: string,
  key: string,
  tabs: TabState[],
  snapshots: Record<string, TreeSnapshot>,
  activeId?: string | null,
): TabState | null {
  const candidates = [...tabs].sort(
    (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
  );
  for (const tab of candidates) {
    if (tab.connectionId !== connectionId) continue;
    const snapshot = snapshots[tab.id];
    const path = snapshot
      ? ancestorPath(buildIssueTree(snapshot.issues, tab.rootKey), key)
      : [];
    if (!path.length && tab.rootKey !== key) continue;
    return {
      ...tab,
      selectedKey: key,
      focusKey: undefined,
      expanded: [
        ...new Set([...tab.expanded, ...path.map((node) => node.issue.key)]),
      ],
      scrollTop: 0,
    };
  }
  return null;
}
