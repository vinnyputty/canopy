import type {
  Issue,
  IssueRelationships,
  TabState,
  TreeSnapshot,
} from '../shared/types';
import { ancestorPath, buildIssueTree } from './tree';
import { issueRelationships } from '../shared/relationships';

/** Compare confirmed tree evidence, excluding polling timestamps and optimistic fields. */
export function relationshipChangedKeys(
  previous: TreeSnapshot | undefined,
  next: TreeSnapshot,
): Set<string> {
  const before = new Map(previous?.issues.map((issue) => [issue.key, issue]));
  const after = new Map(next.issues.map((issue) => [issue.key, issue]));
  const signature = (issue: Issue | undefined) =>
    issue &&
    JSON.stringify([
      issue.id,
      issue.summary,
      issue.parentKey,
      issue.status.id,
      issue.status.name,
      issue.status.category,
      issue.linksAvailable === true,
      issue.links
        .map((link) =>
          JSON.stringify([
            link.key,
            link.summary,
            link.relationship,
            link.direction,
            link.statusCategory,
          ]),
        )
        .sort(),
      issue.unavailableFields
        ?.filter((field) =>
          ['summary', 'parent', 'status', 'links'].includes(field),
        )
        .sort() ?? [],
    ]);
  const changed = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key);
    const current = after.get(key);
    if (signature(old) !== signature(current)) changed.add(key);
    if (!old || !current || old.parentKey !== current.parentKey) {
      if (old?.parentKey) changed.add(old.parentKey);
      if (current?.parentKey) changed.add(current.parentKey);
    }
  }
  if (
    JSON.stringify([...(previous?.warnings ?? [])].sort()) !==
    JSON.stringify([...next.warnings].sort())
  )
    for (const key of new Set([...before.keys(), ...after.keys()]))
      changed.add(key);
  return changed;
}

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
    if (
      target &&
      (target.unavailableFields?.includes('status') ||
        (fallback !== undefined && fallback !== target.status.category))
    )
      return undefined;
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
