import type { Workspace } from '../shared/types';

// Offsets are UI state only. Overlay them before navigation and persistence,
// without forcing the rich issue tree to render on every native scroll event.
export function withScrollPositions(
  workspace: Workspace,
  positions: ReadonlyMap<string, number>,
): Workspace {
  const apply = (tabs: Workspace['tabs']) =>
    tabs.map((tab) =>
      positions.has(tab.id)
        ? { ...tab, scrollTop: positions.get(tab.id)! }
        : tab,
    );
  return {
    ...workspace,
    tabs: apply(workspace.tabs),
    closedTabs: workspace.closedTabs
      ? apply(workspace.closedTabs)
      : workspace.closedTabs,
  };
}
