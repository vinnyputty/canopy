import { migrateViews } from '../renderer/table-view';
import type {
  Connection,
  RootReference,
  RootView,
  TabState,
  Workspace,
} from './types';
import { migrateReading, validRootView, validSavedViews } from './views';
import { validateWorkspace } from './workspace-validation';
import { DEFAULT_SHORTCUTS, shortcutCollisions } from '../renderer/tree';

export const BACKUP_LIMIT = 4_000_000;
export type BackupConnection = Pick<
  Connection,
  'id' | 'name' | 'provider' | 'url'
>;
export type WorkspaceBackup = {
  format: 'canopy-workspace';
  version: 1;
  createdAt: string;
  connections: BackupConnection[];
  workspace: Workspace;
};
export type ImportMode = 'merge' | 'replace';
export type ImportPreview = {
  token: string;
  effects: string[];
  conflicts: string[];
  workspace: Workspace;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: string[]) {
  const input = object(value);
  for (const key of Object.keys(input)) {
    if (
      !allowed.includes(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      throw new Error(`Unsupported backup field: ${key}.`);
  }
  return input;
}
function string(value: unknown, maximum = 500): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error('Invalid backup text.');
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error('Invalid backup list.');
  return value;
}
function root(value: unknown) {
  const input = fields(value, ['connectionId', 'rootKey', 'summary']);
  string(input.connectionId);
  string(input.rootKey);
  if (
    !/^(?:[A-Z][A-Z0-9_]*-\d+|[-\w.]+\/[-\w.]+(?:#\d+)?)$/i.test(input.rootKey)
  )
    throw new Error('Invalid root key.');
  if (
    input.summary !== undefined &&
    (typeof input.summary !== 'string' || input.summary.length > 10000)
  )
    throw new Error('Invalid root summary.');
}
function filters(value: unknown) {
  fields(value, ['assignee', 'status', 'priority']);
}
function view(value: unknown) {
  const input = fields(value, [
    'columns',
    'widths',
    'sort',
    'hideDone',
    'assumeMatchingStatusTransitions',
    'filters',
  ]);
  fields(input.widths, ['issue', 'priority', 'assignee', 'status']);
  fields(input.sort, ['column', 'direction']);
  filters(input.filters);
  if (!validRootView(value)) throw new Error('Invalid backup table view.');
}
function tab(value: unknown) {
  const input = fields(value, [
    'id',
    'connectionId',
    'rootKey',
    'summary',
    'expanded',
    'hideDone',
    'scrollTop',
    'filters',
    'view',
  ]);
  root(
    Object.fromEntries(
      ['connectionId', 'rootKey', 'summary']
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    ),
  );
  // Backups deliberately contain no issue expansion, selection, or scroll history.
  if (list(input.expanded, 0).length || input.scrollTop !== 0)
    throw new Error('Backup contains navigation history.');
  if (input.filters !== undefined) filters(input.filters);
  if (input.view !== undefined) view(input.view);
}
const workspaceFields = [
  'tabs',
  'activeTabId',
  'shortcuts',
  'theme',
  'palette',
  'reading',
  'sidebarCollapsed',
  'sidebarWidth',
  'previewWidth',
  'pinnedRoots',
  'recentRoots',
  'closedTabs',
  'viewDefaults',
  'rootViews',
  'savedViews',
  'activeSavedViewId',
];
export function validateBackupWorkspace(value: unknown): Workspace {
  const input = fields(value, workspaceFields);
  list(input.tabs, 100).forEach(tab);
  if (input.closedTabs !== undefined) list(input.closedTabs, 20).forEach(tab);
  for (const key of ['pinnedRoots', 'recentRoots'])
    if (input[key] !== undefined) list(input[key], 1000).forEach(root);
  if (input.reading !== undefined)
    fields(input.reading, ['textSize', 'spacing']);
  const shortcuts = fields(input.shortcuts, Object.keys(DEFAULT_SHORTCUTS));
  for (const value of Object.values(shortcuts))
    if (typeof value !== 'string' || value.length > 100)
      throw new Error('Invalid shortcut.');
  if (shortcutCollisions(shortcuts as Record<string, string>).size)
    throw new Error('Conflicting keyboard shortcuts.');
  for (const key of ['viewDefaults', 'rootViews'])
    if (input[key] !== undefined) {
      const map = object(input[key]);
      if (Object.keys(map).length > 1000)
        throw new Error('Too many table views.');
      for (const [id, item] of Object.entries(map)) {
        string(id, 1100);
        if (['__proto__', 'constructor', 'prototype'].includes(id))
          throw new Error('Unsafe view identifier.');
        view(item);
      }
    }
  if (input.savedViews !== undefined) {
    for (const item of list(input.savedViews, 100)) {
      const saved = fields(item, [
        'id',
        'name',
        'roots',
        'connectionIds',
        'filters',
        'sort',
      ]);
      list(saved.roots, 1000).forEach(root);
      fields(saved.filters, ['assignee', 'statuses', 'priority', 'hideDone']);
      fields(saved.sort, ['column', 'direction']);
      const savedFilters = object(saved.filters);
      const savedSort = object(saved.sort);
      if (
        typeof savedFilters.assignee !== 'string' ||
        typeof savedSort.column !== 'string' ||
        typeof savedSort.direction !== 'string'
      )
        throw new Error('Invalid saved view enum.');
    }
    if (!validSavedViews(input.savedViews))
      throw new Error('Invalid saved views.');
  }
  input.shortcuts = Object.fromEntries(
    Object.keys(DEFAULT_SHORTCUTS).map((key) => [key, shortcuts[key] ?? '']),
  );
  const result = validateWorkspace(value as Workspace);
  const tabs = [...result.tabs, ...(result.closedTabs ?? [])];
  for (const group of [
    result.tabs,
    result.closedTabs ?? [],
    result.pinnedRoots ?? [],
    result.recentRoots ?? [],
  ])
    if (new Set(group.map(identity)).size !== group.length)
      throw new Error('Duplicate root identities.');
  if (new Set(tabs.map((t) => t.id)).size !== tabs.length)
    throw new Error('Duplicate tab identifiers.');
  if (
    result.activeTabId !== null &&
    !result.tabs.some((t) => t.id === result.activeTabId)
  )
    throw new Error('Invalid active tab.');
  if (
    result.activeSavedViewId !== undefined &&
    result.activeSavedViewId !== null &&
    !result.savedViews?.some((v) => v.id === result.activeSavedViewId)
  )
    throw new Error('Invalid active saved view.');
  return migrateReading(result);
}
export function connectionDescriptor(connection: Connection): BackupConnection {
  const { id, name, provider, url } = connection;
  string(id);
  string(name);
  if (['__proto__', 'constructor', 'prototype'].includes(id))
    throw new Error('Unsafe connection identifier.');
  if (!['jira', 'github', 'demo'].includes(provider))
    throw new Error('Unsupported provider.');
  string(url, 2000);
  if (provider === 'demo' && url === 'Local sample workspace')
    return { id, name, provider, url };
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      'Connection URL must be HTTPS without credentials, query, or fragment.',
    );
  return { id, name, provider, url: parsed.href.replace(/\/$/, '') };
}
function portableTab(tab: TabState): TabState {
  const { id, connectionId, rootKey, summary, hideDone, filters, view } = tab;
  return {
    id,
    connectionId,
    rootKey,
    ...(summary !== undefined ? { summary } : {}),
    hideDone,
    ...(filters ? { filters } : {}),
    ...(view ? { view } : {}),
    expanded: [],
    scrollTop: 0,
  };
}
export function createBackup(
  workspace: Workspace,
  connections: Connection[],
  createdAt = new Date().toISOString(),
): WorkspaceBackup {
  const portable = Object.fromEntries(
    workspaceFields
      .filter((k) => Object.hasOwn(workspace, k))
      .map((k) => [k, workspace[k as keyof Workspace]]),
  ) as Workspace;
  portable.tabs = workspace.tabs.map(portableTab);
  if (workspace.closedTabs)
    portable.closedTabs = workspace.closedTabs.map(portableTab);
  const backup: WorkspaceBackup = {
    format: 'canopy-workspace',
    version: 1,
    createdAt,
    connections: connections
      .filter((c) => referencedConnections(portable).has(c.id))
      .map(connectionDescriptor),
    workspace: portable,
  };
  return parseBackup(JSON.stringify(backup));
}
export function parseBackup(contents: string): WorkspaceBackup {
  if (
    typeof contents !== 'string' ||
    new TextEncoder().encode(contents).length > BACKUP_LIMIT
  )
    throw new Error('Backup exceeds 4 MB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Backup is not complete JSON.');
  }
  const input = fields(parsed, [
    'format',
    'version',
    'createdAt',
    'connections',
    'workspace',
  ]);
  if (input.format !== 'canopy-workspace' || input.version !== 1)
    throw new Error('Unsupported backup format or version.');
  string(input.createdAt, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt) ||
    !Number.isFinite(Date.parse(input.createdAt))
  )
    throw new Error('Invalid backup timestamp.');
  const connections = list(input.connections, 100).map((item) => {
    fields(item, ['id', 'name', 'provider', 'url']);
    return connectionDescriptor(item as Connection);
  });
  if (new Set(connections.map((c) => c.id)).size !== connections.length)
    throw new Error('Duplicate connection identifiers.');
  const workspace = validateBackupWorkspace(input.workspace);
  const ids = new Set(connections.map((c) => c.id));
  for (const id of referencedConnections(workspace))
    if (!ids.has(id))
      throw new Error(
        `Missing connection descriptor: ${id}. Reconnect before exporting.`,
      );
  return {
    format: 'canopy-workspace',
    version: 1,
    createdAt: input.createdAt,
    connections,
    workspace,
  };
}
function referencedConnections(workspace: Workspace): Set<string> {
  const ids = new Set(
    [
      ...workspace.tabs,
      ...(workspace.closedTabs ?? []),
      ...(workspace.pinnedRoots ?? []),
      ...(workspace.recentRoots ?? []),
      ...(workspace.savedViews ?? []).flatMap((v) => v.roots),
    ].map((r) => r.connectionId),
  );
  for (const view of workspace.savedViews ?? [])
    view.connectionIds.forEach((id) => ids.add(id));
  Object.keys(workspace.viewDefaults ?? {}).forEach((id) => ids.add(id));
  const rootIdentities = new Set<string>();
  for (const key of Object.keys(workspace.rootViews ?? {})) {
    let tuple: unknown;
    try {
      tuple = JSON.parse(key);
    } catch {
      throw new Error('Invalid root view identity.');
    }
    if (!Array.isArray(tuple) || tuple.length !== 2)
      throw new Error('Invalid root view identity.');
    root({ connectionId: tuple[0], rootKey: tuple[1] });
    const normalized = JSON.stringify([tuple[0], tuple[1].toLowerCase()]);
    if (rootIdentities.has(normalized))
      throw new Error('Duplicate root view identities.');
    rootIdentities.add(normalized);
    ids.add(tuple[0]);
  }
  return ids;
}
const identity = (root: RootReference) =>
  JSON.stringify([root.connectionId, root.rootKey.toLowerCase()]);
export function planImport(
  backup: WorkspaceBackup,
  current: Workspace,
  connections: Connection[],
  mapping: Record<string, string>,
  mode: ImportMode,
): Omit<ImportPreview, 'token'> {
  if (!['merge', 'replace'].includes(mode))
    throw new Error('Invalid import mode.');
  fields(
    mapping,
    backup.connections.map((c) => c.id),
  );
  const used = new Set<string>();
  for (const source of backup.connections) {
    const target = connections.find((c) => c.id === mapping[source.id]);
    if (!target)
      throw new Error(`Reconnect and map ${source.name} before importing.`);
    const descriptor = connectionDescriptor(target);
    if (
      source.provider !== descriptor.provider ||
      source.url !== descriptor.url
    )
      throw new Error(
        'Mapped connection must have the same provider and server URL.',
      );
    if (used.has(target.id))
      throw new Error('Each source needs a distinct destination connection.');
    used.add(target.id);
  }
  const remap = <T extends RootReference>(r: T): T => ({
    ...r,
    connectionId: mapping[r.connectionId],
  });
  const incoming = structuredClone(backup.workspace);
  incoming.tabs = incoming.tabs.map(remap);
  incoming.closedTabs = incoming.closedTabs?.map(remap);
  incoming.pinnedRoots = incoming.pinnedRoots?.map(remap);
  incoming.recentRoots = incoming.recentRoots?.map(remap);
  incoming.savedViews = incoming.savedViews?.map((v) => ({
    ...v,
    roots: v.roots.map(remap),
    connectionIds: v.connectionIds.map((id) => mapping[id]),
  }));
  incoming.viewDefaults = Object.fromEntries(
    Object.entries(incoming.viewDefaults ?? {}).map(([id, v]) => [
      mapping[id],
      v,
    ]),
  );
  incoming.rootViews = Object.fromEntries(
    Object.entries(incoming.rootViews ?? {}).map(([key, v]) => {
      const [id, rootKey] = JSON.parse(key);
      return [JSON.stringify([mapping[id], rootKey.toUpperCase()]), v];
    }),
  );
  const conflicts: string[] = [];
  const combine = <T>(
    local: T[],
    imported: T[],
    key: (item: T) => string,
    label: string,
    maximum: number,
  ): T[] => {
    const result = [...local];
    const keys = new Set(local.map(key));
    for (const item of imported) {
      const id = key(item);
      if (keys.has(id)) conflicts.push(`${label}: ${id} — keep existing`);
      else {
        result.push(item);
        keys.add(id);
      }
    }
    if (result.length > maximum)
      throw new Error(
        `Merged ${label} exceed the workspace limit; use replace or reduce the workspace.`,
      );
    return result;
  };
  let result: Workspace;
  if (mode === 'replace') {
    result = {
      ...incoming,
      ...(current.seenRoots ? { seenRoots: current.seenRoots } : {}),
    };
    conflicts.push(
      'Replace removes existing roots, favorites, saved views, appearance, and shortcuts from workspace.json.',
    );
  } else {
    const ids = new Set(
      [...current.tabs, ...(current.closedTabs ?? [])].map((t) => t.id),
    );
    const reidentify = (t: TabState) => {
      let id = t.id;
      while (ids.has(id)) id = `import-${id}`;
      ids.add(id);
      return { ...t, id };
    };
    const mergeMap = (
      local: Record<string, RootView> = {},
      imported: Record<string, RootView> = {},
      label: string,
    ) => {
      for (const key of Object.keys(imported))
        if (Object.hasOwn(local, key))
          conflicts.push(`${label}: ${key} — keep existing`);
      return { ...imported, ...local };
    };
    const saved = [...(current.savedViews ?? [])];
    for (const v of incoming.savedViews ?? []) {
      if (
        saved.some(
          (existing) => existing.id === v.id || existing.name === v.name,
        )
      )
        conflicts.push(`Saved view: ${v.name} (${v.id}) — keep existing`);
      else saved.push(v);
    }
    result = {
      ...current,
      tabs: combine(
        current.tabs,
        incoming.tabs.map(reidentify),
        identity,
        'Open root',
        100,
      ),
      closedTabs: combine(
        current.closedTabs ?? [],
        (incoming.closedTabs ?? []).map(reidentify),
        identity,
        'Closed root',
        20,
      ),
      pinnedRoots: combine(
        current.pinnedRoots ?? [],
        incoming.pinnedRoots ?? [],
        identity,
        'Favorite',
        1000,
      ),
      recentRoots: combine(
        current.recentRoots ?? [],
        incoming.recentRoots ?? [],
        identity,
        'Recent root',
        1000,
      ),
      savedViews: saved,
      viewDefaults: mergeMap(
        current.viewDefaults,
        incoming.viewDefaults,
        'Connection view',
      ),
      rootViews: mergeMap(current.rootViews, incoming.rootViews, 'Root view'),
    };
  }
  result = migrateViews({
    palette: 'default',
    sidebarWidth: 220,
    previewWidth: 420,
    savedViews: [],
    ...result,
  });
  validateWorkspace(result);
  return {
    workspace: result,
    conflicts,
    effects: [
      `${mode === 'merge' ? 'Keep existing appearance, reading, shortcuts, selection, and conflicting entries; add non-conflicting entries.' : 'Use backup appearance, reading, shortcuts, and selection.'}`,
      `Result: ${result.tabs.length} open roots, ${result.pinnedRoots?.length ?? 0} favorites, ${result.savedViews?.length ?? 0} saved views, ${result.closedTabs?.length ?? 0} closed roots, ${result.recentRoots?.length ?? 0} recent roots.`,
      'Credentials, provider connections, issue caches, and existing seen baselines are preserved. Imported roots fetch fresh data through the mapped account.',
    ],
  };
}
