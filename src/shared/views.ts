import type { RootView, TableColumn, TabState, Workspace } from './types';

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
  };
}
