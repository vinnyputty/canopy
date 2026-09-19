import type { RootReference, TabState, Workspace } from '../shared/types';
import { rootView, setRootView } from './table-view';

export const sameRoot = (a: RootReference, b: RootReference) =>
  a.connectionId === b.connectionId && a.rootKey === b.rootKey;

export function rememberRoot(
  workspace: Workspace,
  root: RootReference,
): Workspace {
  return {
    ...workspace,
    recentRoots: [
      {
        connectionId: root.connectionId,
        rootKey: root.rootKey,
        summary: root.summary,
      },
      ...(workspace.recentRoots ?? []).filter((item) => !sameRoot(item, root)),
    ].slice(0, 20),
  };
}

export function activateTab(
  workspace: Workspace,
  tab: TabState,
  restoreView = true,
): Workspace {
  const existing = workspace.tabs.find((item) => sameRoot(item, tab));
  const restored = { ...tab, id: existing?.id ?? tab.id };
  const next = rememberRoot(
    {
      ...workspace,
      tabs: existing
        ? workspace.tabs.map((item) =>
            item.id === existing.id ? restored : item,
          )
        : [...workspace.tabs, restored],
      activeTabId: restored.id,
    },
    restored,
  );
  if (restoreView)
    return setRootView(
      next,
      restored,
      tab.view ?? {
        ...rootView(workspace, tab),
        hideDone: tab.hideDone,
        filters: tab.filters ?? {},
      },
    );
  const view = rootView(next, restored);
  return {
    ...next,
    tabs: next.tabs.map((item) =>
      item.id === restored.id
        ? { ...item, view, hideDone: view.hideDone, filters: view.filters }
        : item,
    ),
  };
}

export function closeTabs(workspace: Workspace, ids: string[]): Workspace {
  const removed = workspace.tabs.filter((tab) => ids.includes(tab.id));
  if (!removed.length) return workspace;
  const index = workspace.tabs.findIndex(
    (tab) => tab.id === workspace.activeTabId,
  );
  const tabs = workspace.tabs.filter((tab) => !ids.includes(tab.id));
  return {
    ...workspace,
    tabs,
    closedTabs: [...removed.reverse(), ...(workspace.closedTabs ?? [])].slice(
      0,
      20,
    ),
    activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId)
      ? workspace.activeTabId
      : (tabs[Math.min(index, tabs.length - 1)]?.id ?? null),
  };
}

export function reopenTab(workspace: Workspace): Workspace {
  const [tab, ...closedTabs] = workspace.closedTabs ?? [];
  return tab ? activateTab({ ...workspace, closedTabs }, tab) : workspace;
}

export function reorderTab(
  workspace: Workspace,
  source: string,
  target: string,
): Workspace {
  const tabs = [...workspace.tabs];
  const from = tabs.findIndex((tab) => tab.id === source);
  const to = tabs.findIndex((tab) => tab.id === target);
  if (from < 0 || to < 0 || from === to) return workspace;
  tabs.splice(to, 0, tabs.splice(from, 1)[0]);
  return { ...workspace, tabs };
}

export function togglePinned(
  workspace: Workspace,
  root: RootReference,
): Workspace {
  const pinned = workspace.pinnedRoots ?? [];
  return {
    ...workspace,
    pinnedRoots: pinned.some((item) => sameRoot(item, root))
      ? pinned.filter((item) => !sameRoot(item, root))
      : [
          ...pinned,
          {
            connectionId: root.connectionId,
            rootKey: root.rootKey,
            summary: root.summary,
          },
        ],
  };
}

export function removeConnection(workspace: Workspace, id: string): Workspace {
  const keep = (root: RootReference) => root.connectionId !== id;
  const tabs = workspace.tabs.filter(keep);
  const viewDefaults = { ...workspace.viewDefaults };
  delete viewDefaults[id];
  const rootViews = Object.fromEntries(
    Object.entries(workspace.rootViews ?? {}).filter(([key]) => {
      try {
        return JSON.parse(key)[0] !== id;
      } catch {
        return true;
      }
    }),
  );
  return {
    ...workspace,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId)
      ? workspace.activeTabId
      : (tabs[0]?.id ?? null),
    pinnedRoots: workspace.pinnedRoots?.filter(keep),
    recentRoots: workspace.recentRoots?.filter(keep),
    closedTabs: workspace.closedTabs?.filter(keep),
    viewDefaults,
    rootViews,
  };
}

export type Navigation = { back: TabState[]; forward: TabState[] };
export function visit(
  history: Navigation,
  from: TabState | undefined,
  to: TabState,
): Navigation {
  return !from || sameRoot(from, to)
    ? history
    : { back: [...history.back, from].slice(-100), forward: [] };
}
export function travel(
  history: Navigation,
  current: TabState | undefined,
  direction: 'back' | 'forward',
): { history: Navigation; tab?: TabState } {
  const source = history[direction];
  const tab = source.at(-1);
  if (!tab) return { history };
  const other = direction === 'back' ? 'forward' : 'back';
  return {
    tab,
    history: {
      ...history,
      [direction]: source.slice(0, -1),
      [other]: current
        ? [...history[other], current].slice(-100)
        : history[other],
    },
  };
}
