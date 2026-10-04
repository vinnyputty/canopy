import type {
  IssueRelationships,
  TreeFilters,
  TreeSnapshot,
} from '../../shared/types';
import { buildIssueTree, filterTree, indexTree } from '../../renderer/tree';

export type Edge = {
  from: string;
  to: string;
  kind: 'blocker' | 'hierarchy' | 'related';
  unknown: boolean;
  cycle: boolean;
};
export type FixtureDate = {
  key: string;
  date: string;
  field: 'due' | 'milestone';
  source: 'fixture';
  reliable: boolean;
};

/** Keep ancestor context exactly as the current tree does. Filtered endpoints stay explicit. */
export function planningGraph(
  snapshot: TreeSnapshot,
  relationships: IssueRelationships[],
  filters: TreeFilters,
  hideDone: boolean,
) {
  const tree = filterTree(
    buildIssueTree(snapshot.issues, snapshot.rootKey),
    '',
    filters,
    hideDone,
  );
  const nodes = indexTree(tree);
  const edges: Edge[] = [];
  const unknown: string[] = [];
  const add = (
    from: string,
    to: string,
    kind: Edge['kind'],
    uncertain = false,
  ) => {
    if (!nodes.has(from) && !nodes.has(to)) return;
    const existing = edges.find(
      (edge) => edge.from === from && edge.to === to && edge.kind === kind,
    );
    const missing = uncertain || !nodes.has(from) || !nodes.has(to);
    if (existing) existing.unknown ||= missing;
    else edges.push({ from, to, kind, unknown: missing, cycle: false });
  };
  for (const issue of snapshot.issues)
    if (issue.parentKey) add(issue.parentKey, issue.key, 'hierarchy');
  for (const graph of relationships) {
    if (!nodes.has(graph.key)) continue;
    for (const group of graph.groups) {
      if (group.state !== 'visible')
        unknown.push(
          `${graph.key} ${group.kind}: ${group.reason ?? group.state}`,
        );
      for (const item of group.items) {
        const kind =
          group.kind === 'parent' || group.kind === 'children'
            ? 'hierarchy'
            : group.kind === 'related'
              ? 'related'
              : 'blocker';
        const reverse = group.kind === 'blockers' || group.kind === 'parent';
        add(
          reverse ? item.key : graph.key,
          reverse ? graph.key : item.key,
          kind,
          item.access !== 'available',
        );
      }
    }
  }
  for (const edge of edges) {
    if (edge.kind === 'related' || edge.unknown) continue;
    const seen = new Set<string>();
    const reaches = (key: string): boolean => {
      if (key === edge.from) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return edges.some(
        (next) =>
          next.kind === edge.kind &&
          !next.unknown &&
          next.from === key &&
          reaches(next.to),
      );
    };
    edge.cycle = reaches(edge.to);
  }
  return { tree, nodes, edges, unknown };
}

/** Synthetic scheduling evidence only. Current provider adapters expose no planning dates. */
export function fixtureMilestones(
  dates: FixtureDate[],
  visible: ReadonlySet<string>,
) {
  return dates
    .filter(
      (item) =>
        item.source === 'fixture' &&
        item.reliable &&
        visible.has(item.key) &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        Number.isFinite(Date.parse(item.date)) &&
        new Date(item.date).toISOString().slice(0, 10) === item.date,
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}
