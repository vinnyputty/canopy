import type { Workspace } from './types';
import {
  validSavedViews,
  validViewMap,
  validRootView,
  validReading,
} from './views';
function text(value: unknown, limit = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('Invalid input.');
  return value.trim();
}
export function validateWorkspace(value: Workspace) {
  if (
    !value ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 100 ||
    !['system', 'light', 'dark'].includes(value.theme) ||
    (value.palette !== undefined &&
      !['default', 'ocean', 'forest'].includes(value.palette)) ||
    typeof value.sidebarCollapsed !== 'boolean' ||
    typeof value.shortcuts !== 'object' ||
    !value.shortcuts
  )
    throw new Error('Invalid workspace.');
  if (
    (value.rootViews !== undefined && !validViewMap(value.rootViews)) ||
    (value.viewDefaults !== undefined && !validViewMap(value.viewDefaults))
  )
    throw new Error('Invalid table view.');
  if (value.reading !== undefined && !validReading(value.reading))
    throw new Error('Invalid reading settings.');
  if (value.savedViews !== undefined && !validSavedViews(value.savedViews))
    throw new Error('Invalid saved issue view.');
  for (const [name, minimum, maximum] of [
    ['sidebarWidth', 180, 400],
    ['previewWidth', 300, 720],
  ] as const) {
    if (
      value[name] !== undefined &&
      (!Number.isFinite(value[name]) ||
        value[name]! < minimum ||
        value[name]! > maximum)
    )
      throw new Error('Invalid pane width.');
  }
  for (const roots of [value.pinnedRoots, value.recentRoots]) {
    if (roots !== undefined && (!Array.isArray(roots) || roots.length > 1000))
      throw new Error('Invalid saved roots.');
    for (const root of roots ?? []) {
      text(root.connectionId);
      if (
        typeof root.rootKey !== 'string' ||
        (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(root.rootKey) &&
          !/^[-\w.]+\/[-\w.]+#\d+$/i.test(root.rootKey) &&
          !/^[-\w.]+\/[-\w.]+$/i.test(root.rootKey))
      )
        throw new Error('Invalid root key.');
      if (
        root.summary !== undefined &&
        (typeof root.summary !== 'string' || root.summary.length > 10000)
      )
        throw new Error('Invalid root summary.');
    }
  }
  if (
    value.closedTabs !== undefined &&
    (!Array.isArray(value.closedTabs) || value.closedTabs.length > 20)
  )
    throw new Error('Invalid closed tabs.');
  for (const tab of [...value.tabs, ...(value.closedTabs ?? [])]) {
    if (tab.view !== undefined && !validRootView(tab.view))
      throw new Error('Invalid saved table view.');
    if (
      tab.linkedExpanded !== undefined &&
      (!Array.isArray(tab.linkedExpanded) ||
        tab.linkedExpanded.length > 100_000 ||
        !tab.linkedExpanded.every(
          (key) => typeof key === 'string' && key.length < 500,
        ))
    )
      throw new Error('Invalid linked expansion state.');
    text(tab.id);
    text(tab.connectionId);
    if (
      typeof tab.rootKey !== 'string' ||
      (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(tab.rootKey) &&
        !/^[-\w.]+\/[-\w.]+#\d+$/i.test(tab.rootKey) &&
        !/^[-\w.]+\/[-\w.]+$/i.test(tab.rootKey))
    )
      throw new Error('Invalid root key.');
    if (
      !Array.isArray(tab.expanded) ||
      tab.expanded.length > 100_000 ||
      !tab.expanded.every((k) => typeof k === 'string' && k.length < 500) ||
      typeof tab.hideDone !== 'boolean' ||
      !Number.isFinite(tab.scrollTop)
    )
      throw new Error('Invalid tab state.');
    if (
      tab.focusKey !== undefined &&
      !/^[A-Z][A-Z0-9_]*-\d+$/i.test(tab.focusKey) &&
      !/^[-\w.]+\/[-\w.]+#\d+$/i.test(tab.focusKey) &&
      !/^[-\w.]+\/[-\w.]+$/i.test(tab.focusKey)
    )
      throw new Error('Invalid focus key.');
    if (tab.filters !== undefined) {
      if (
        !tab.filters ||
        typeof tab.filters !== 'object' ||
        Array.isArray(tab.filters)
      )
        throw new Error('Invalid filters.');
      if (
        tab.filters.assignee !== undefined &&
        !['me', 'unassigned'].includes(tab.filters.assignee)
      )
        throw new Error('Invalid assignee filter.');
      if (tab.filters.status !== undefined) text(tab.filters.status);
      if (tab.filters.priority !== undefined) text(tab.filters.priority);
    }
  }
  if (JSON.stringify(value).length > 4_000_000)
    throw new Error('Workspace is too large to save.');
  if (value.seenRoots !== undefined) {
    if (
      !value.seenRoots ||
      typeof value.seenRoots !== 'object' ||
      Array.isArray(value.seenRoots) ||
      Object.keys(value.seenRoots).length > 12
    )
      throw new Error('Invalid last-seen roots.');
    for (const root of Object.values(value.seenRoots)) {
      if (
        !root ||
        !Number.isSafeInteger(root.touchedAt) ||
        !root.issues ||
        typeof root.issues !== 'object' ||
        Array.isArray(root.issues) ||
        Object.keys(root.issues).length > 1000
      )
        throw new Error('Invalid last-seen root.');
      for (const issue of Object.values(root.issues)) {
        if (
          !issue ||
          !Number.isSafeInteger(issue.seenAt) ||
          !issue.fields ||
          typeof issue.fields !== 'object' ||
          Array.isArray(issue.fields)
        )
          throw new Error('Invalid last-seen issue.');
      }
    }
  }
  return value;
}
