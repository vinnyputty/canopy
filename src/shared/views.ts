import type {
  RootView,
  SavedIssueView,
  TableColumn,
  TabState,
  Workspace,
} from './types';

export const COLUMN_BOUNDS: Record<TableColumn, readonly [number, number]> = {
  issue: [240, 1200],
  priority: [80, 480],
  assignee: [80, 480],
  status: [80, 480],
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function validRootView(value: unknown): value is RootView {
  if (!record(value)) return false;
  const {
    columns,
    widths,
    sort,
    textSize,
    spacing,
    hideDone,
    assumeMatchingStatusTransitions,
    filters,
  } = value;
  return (
    Array.isArray(columns) &&
    columns[0] === 'issue' &&
    columns.every(
      (column) =>
        typeof column === 'string' && Object.hasOwn(COLUMN_BOUNDS, column),
    ) &&
    new Set(columns).size === columns.length &&
    record(widths) &&
    Object.entries(COLUMN_BOUNDS).every(([column, [min, max]]) => {
      const width = widths[column];
      return (
        typeof width === 'number' &&
        Number.isFinite(width) &&
        width >= min &&
        width <= max
      );
    }) &&
    record(sort) &&
    typeof sort.column === 'string' &&
    (sort.column === 'rank' || Object.hasOwn(COLUMN_BOUNDS, sort.column)) &&
    (sort.direction === 'asc' || sort.direction === 'desc') &&
    ['small', 'medium', 'large'].includes(String(textSize)) &&
    ['compact', 'comfortable'].includes(String(spacing)) &&
    typeof hideDone === 'boolean' &&
    typeof assumeMatchingStatusTransitions === 'boolean' &&
    record(filters) &&
    Object.keys(filters).every((key) =>
      ['assignee', 'status', 'priority'].includes(key),
    ) &&
    (filters.assignee === undefined ||
      filters.assignee === 'me' ||
      filters.assignee === 'unassigned') &&
    ['status', 'priority'].every(
      (key) =>
        filters[key] === undefined ||
        (typeof filters[key] === 'string' &&
          filters[key].length > 0 &&
          filters[key].length <= 500),
    )
  );
}
export function validViewMap(
  value: unknown,
): value is Record<string, RootView> {
  return record(value) && Object.values(value).every(validRootView);
}
function restoredRootView(value: unknown): RootView | undefined {
  const candidate =
    record(value) && !Object.hasOwn(value, 'assumeMatchingStatusTransitions')
      ? { ...value, assumeMatchingStatusTransitions: true }
      : value;
  return validRootView(candidate) ? candidate : undefined;
}
export function validSavedViews(value: unknown): value is SavedIssueView[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (view) =>
        record(view) &&
        typeof view.id === 'string' &&
        view.id.length > 0 &&
        view.id.length <= 100 &&
        typeof view.name === 'string' &&
        view.name.trim().length > 0 &&
        view.name.length <= 100 &&
        Array.isArray(view.roots) &&
        view.roots.length <= 1000 &&
        view.roots.every(
          (root: unknown) =>
            record(root) &&
            typeof root.connectionId === 'string' &&
            root.connectionId.length > 0 &&
            root.connectionId.length <= 500 &&
            typeof root.rootKey === 'string' &&
            root.rootKey.length > 0 &&
            root.rootKey.length <= 500 &&
            (root.summary === undefined ||
              (typeof root.summary === 'string' &&
                root.summary.length <= 10000)),
        ) &&
        Array.isArray(view.connectionIds) &&
        view.connectionIds.length <= 100 &&
        view.connectionIds.every(
          (id: unknown) => typeof id === 'string' && id.length <= 500,
        ) &&
        record(view.filters) &&
        ['any', 'me', 'unassigned'].includes(String(view.filters.assignee)) &&
        Array.isArray(view.filters.statuses) &&
        view.filters.statuses.length <= 50 &&
        view.filters.statuses.every(
          (status: unknown) =>
            typeof status === 'string' && status.length <= 100,
        ) &&
        typeof view.filters.priority === 'string' &&
        view.filters.priority.length <= 100 &&
        typeof view.filters.hideDone === 'boolean' &&
        record(view.sort) &&
        ['key', 'summary', 'status', 'priority', 'assignee'].includes(
          String(view.sort.column),
        ) &&
        ['asc', 'desc'].includes(String(view.sort.direction)),
    ) &&
    new Set(value.map((view) => view.id)).size === value.length
  );
}
/** Retain unrelated workspace state when an old or hand-edited view is invalid. */
export function recoverWorkspaceViews(workspace: Workspace): Workspace {
  if (
    !record(workspace) ||
    !Array.isArray(workspace.tabs) ||
    workspace.tabs.some((tab) => !record(tab)) ||
    (workspace.closedTabs !== undefined &&
      (!Array.isArray(workspace.closedTabs) ||
        workspace.closedTabs.some((tab) => !record(tab))))
  )
    throw new Error('Invalid saved workspace.');
  const recover = (value: unknown) =>
    Object.fromEntries(
      Object.entries(record(value) ? value : {}).flatMap(([key, value]) => {
        const view = restoredRootView(value);
        return view ? [[key, view]] : [];
      }),
    ) as Record<string, RootView>;
  const recoverTabs = (tabs: TabState[]) =>
    tabs.some(
      (tab) =>
        tab.view !== undefined && restoredRootView(tab.view) !== tab.view,
    )
      ? tabs.map((tab) => {
          if (tab.view === undefined) return tab;
          const view = restoredRootView(tab.view);
          return view === tab.view ? tab : { ...tab, view };
        })
      : tabs;
  return {
    ...workspace,
    tabs: recoverTabs(workspace.tabs),
    ...(workspace.closedTabs
      ? { closedTabs: recoverTabs(workspace.closedTabs) }
      : {}),
    ...(workspace.rootViews !== undefined
      ? { rootViews: recover(workspace.rootViews) }
      : {}),
    ...(workspace.viewDefaults !== undefined
      ? { viewDefaults: recover(workspace.viewDefaults) }
      : {}),
    ...(workspace.savedViews !== undefined
      ? {
          savedViews: validSavedViews(workspace.savedViews)
            ? workspace.savedViews
            : [],
        }
      : {}),
  };
}
