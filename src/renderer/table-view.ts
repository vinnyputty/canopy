import type {
  Issue,
  RootView,
  TabState,
  TableColumn,
  TableSort,
  TreeSnapshot,
  Workspace,
} from '../shared/types';
import type { IssueNode } from './tree';
import { COLUMN_BOUNDS } from '../shared/views';

export const COLUMN_LABELS: Record<TableColumn, string> = {
  issue: 'Issue',
  priority: 'Priority',
  assignee: 'Assignee',
  status: 'Status',
};
export const DEFAULT_VIEW: RootView = {
  columns: ['issue', 'priority', 'assignee', 'status'],
  widths: { issue: 480, priority: 104, assignee: 165, status: 128 },
  sort: { column: 'rank', direction: 'asc' },
  textSize: 'medium',
  spacing: 'compact',
  hideDone: true,
  assumeMatchingStatusTransitions: true,
  filters: {},
};
export function viewKey(tab: Pick<TabState, 'connectionId' | 'rootKey'>) {
  return JSON.stringify([tab.connectionId, tab.rootKey.toUpperCase()]);
}
export function columnBounds(column: TableColumn) {
  return COLUMN_BOUNDS[column];
}
export function clampWidth(column: TableColumn, width: number) {
  const [min, max] = columnBounds(column);
  return Math.min(max, Math.max(min, Math.round(width)));
}
export function rootView(
  workspace: Workspace,
  tab: Pick<TabState, 'connectionId' | 'rootKey'>,
): RootView {
  return (
    workspace.rootViews?.[viewKey(tab)] ??
    workspace.viewDefaults?.[tab.connectionId] ??
    DEFAULT_VIEW
  );
}
export function setRootView(
  workspace: Workspace,
  tab: TabState,
  patch: Partial<RootView>,
): Workspace {
  const next = { ...rootView(workspace, tab), ...patch };
  return syncViews({
    ...workspace,
    rootViews: { ...workspace.rootViews, [viewKey(tab)]: next },
  });
}
function syncViews(workspace: Workspace): Workspace {
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) => {
      const view = rootView(workspace, tab);
      return { ...tab, view, hideDone: view.hideDone, filters: view.filters };
    }),
  };
}
export function resetRootView(workspace: Workspace, tab: TabState): Workspace {
  const rootViews = { ...workspace.rootViews };
  delete rootViews[viewKey(tab)];
  return syncViews({ ...workspace, rootViews });
}
export function defaultRootView(
  workspace: Workspace,
  tab: TabState,
): Workspace {
  return syncViews({
    ...workspace,
    viewDefaults: {
      ...workspace.viewDefaults,
      [tab.connectionId]: structuredClone(rootView(workspace, tab)),
    },
  });
}
export function migrateViews(workspace: Workspace): Workspace {
  if (workspace.rootViews) return syncViews(workspace);
  const rootViews: Record<string, RootView> = {};
  const latest = new Map(
    [...[...(workspace.closedTabs ?? [])].reverse(), ...workspace.tabs].map(
      (tab) => [viewKey(tab), tab],
    ),
  );
  for (const tab of latest.values()) {
    if (tab.view || !tab.hideDone || Object.keys(tab.filters ?? {}).length)
      rootViews[viewKey(tab)] = tab.view ?? {
        ...DEFAULT_VIEW,
        hideDone: tab.hideDone,
        filters: tab.filters ?? {},
      };
  }
  return syncViews({ ...workspace, rootViews });
}
export function tableStyle(view: RootView) {
  return {
    '--table-columns': [
      ...view.columns.map((column) =>
        column === 'issue'
          ? `minmax(${view.widths.issue}px, 1fr)`
          : `${view.widths[column]}px`,
      ),
      '62px',
    ].join(' '),
    '--table-width': `${view.columns.reduce((sum, column) => sum + view.widths[column], 62)}px`,
    '--tree-font-size': `${{ small: 11, medium: 13, large: 15 }[view.textSize]}px`,
    '--row-height': `${view.spacing === 'compact' ? 30 : 40}px`,
  };
}
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
export function sortIssueTree(
  node: IssueNode,
  sort: TableSort,
  priorityOrder?: string[],
): IssueNode {
  if (sort.column === 'rank' || (sort.column === 'priority' && !priorityOrder))
    return node;
  const value = (issue: Issue): string | number | null => {
    switch (sort.column) {
      case 'issue':
        return issue.summary;
      case 'priority': {
        if (!issue.priority) return null;
        const index = priorityOrder!.indexOf(issue.priority.id);
        return index < 0 ? null : index;
      }
      case 'assignee':
        return issue.assignee?.name ?? null;
      case 'status':
        return issue.status.name;
      default:
        return null;
    }
  };
  return {
    ...node,
    children: node.children
      .map((child) => sortIssueTree(child, sort, priorityOrder))
      .sort((a, b) => {
        const av = value(a.issue),
          bv = value(b.issue);
        if (av === null && bv !== null) return 1;
        if (bv === null && av !== null) return -1;
        const order =
          av === null || bv === null
            ? 0
            : typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : collator.compare(String(av), String(bv));
        return (
          order * (sort.direction === 'asc' ? 1 : -1) ||
          collator.compare(a.issue.key, b.issue.key)
        );
      }),
  };
}
export function canRank(
  snapshot: TreeSnapshot | undefined,
  sort: TableSort,
  key: string,
) {
  return (
    sort.column === 'rank' &&
    snapshot?.ranking?.state === 'supported' &&
    snapshot.ranking.issueKeys.includes(key) &&
    key !== snapshot.rootKey
  );
}
export function priorityRepresentatives(issues: Issue[]) {
  const representatives = new Map<string, string>();
  for (const issue of issues)
    if (issue.priority && !representatives.has(issue.priority.id))
      representatives.set(issue.priority.id, issue.key);
  return [...representatives].sort(([a], [b]) => collator.compare(a, b));
}
