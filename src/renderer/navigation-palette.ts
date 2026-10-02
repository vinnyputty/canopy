import { ancestorPath, buildIssueTree } from './tree';
import type {
  Connection,
  RootReference,
  TabState,
  TreeSnapshot,
  Workspace,
} from '../shared/types';

export type PaletteTarget =
  | { type: 'Open root' | 'Recent root'; root: RootReference }
  | { type: 'Saved view'; viewId: string }
  | { type: 'Connection'; connectionId: string }
  | { type: 'Loaded issue'; tab: TabState; key: string }
  | { type: 'Action'; actionId: string };
export type PaletteEntry = {
  id: string;
  label: string;
  context: string;
  target: PaletteTarget;
  priority: number;
  terms: string;
  key: string;
};

/** Local snapshots only; building or querying this index never contacts a provider. */
export function paletteIndex(
  workspace: Workspace,
  connections: Connection[],
  snapshots: Record<string, TreeSnapshot>,
  actions: { id: string; label: string }[],
  sources: TabState[] = [],
): PaletteEntry[] {
  const names = new Map(
    connections.map((c) => [c.id, `${c.name} · ${c.provider}`]),
  );
  const entries: PaletteEntry[] = [];
  const add = (
    id: string,
    label: string,
    context: string,
    target: PaletteTarget,
    priority: number,
    key = '',
  ) => {
    entries.push({
      id,
      label,
      context,
      target,
      priority,
      key: key.toLowerCase(),
      terms: `${label} ${context} ${target.type}`.toLowerCase(),
    });
  };
  const roots = new Set<string>();
  for (const root of [...workspace.tabs, ...(workspace.recentRoots ?? [])]) {
    if (!names.has(root.connectionId)) continue;
    const identity = JSON.stringify([root.connectionId, root.rootKey]);
    if (roots.has(identity)) continue;
    roots.add(identity);
    const open = 'id' in root;
    add(
      `root:${identity}`,
      `${root.rootKey}${root.summary ? ` · ${root.summary}` : ''}`,
      names.get(root.connectionId)!,
      { type: open ? 'Open root' : 'Recent root', root },
      open ? (root.id === workspace.activeTabId ? 0 : 1) : 2,
      root.rootKey,
    );
  }
  for (const view of workspace.savedViews ?? []) {
    const context = [
      ...view.roots.map(
        (root) =>
          `${root.rootKey} · ${names.get(root.connectionId) ?? 'Unavailable connection'}`,
      ),
      ...view.connectionIds.map(
        (id) =>
          `All configured roots · ${names.get(id) ?? 'Unavailable connection'}`,
      ),
    ].join('; ');
    add(
      `view:${view.id}`,
      view.name,
      `${view.roots.length} explicit roots${context ? ` · ${context}` : ''}`,
      { type: 'Saved view', viewId: view.id },
      3,
    );
  }
  for (const connection of connections) {
    add(
      `connection:${connection.id}`,
      connection.name,
      `${connection.provider} · ${connection.url}${connection.accountName ? ` · ${connection.accountName}` : ''}`,
      { type: 'Connection', connectionId: connection.id },
      4,
    );
  }
  const issues = new Set<string>();
  for (const tab of [...workspace.tabs, ...sources]) {
    const snapshot = snapshots[tab.id];
    if (!snapshot || !names.has(tab.connectionId)) continue;
    const context = `${names.get(tab.connectionId)} · in ${tab.rootKey} · loaded snapshot, may be stale · ${new Date(snapshot.fetchedAt).toISOString()}${snapshot.warnings.length ? ` · ${snapshot.warnings.join('; ')}` : ''}`;
    for (const issue of snapshot.issues) {
      const identity = JSON.stringify([tab.connectionId, issue.key]);
      if (issues.has(identity)) continue;
      issues.add(identity);
      add(
        `issue:${identity}`,
        `${issue.key} · ${issue.summary}`,
        context,
        { type: 'Loaded issue', tab, key: issue.key },
        5,
        issue.key,
      );
    }
  }
  for (const action of actions)
    add(
      `action:${action.id}`,
      action.label,
      'Workspace command',
      { type: 'Action', actionId: action.id },
      6,
    );
  return entries;
}

export function searchPalette(
  entries: PaletteEntry[],
  query: string,
  limit = 80,
): PaletteEntry[] {
  const value = query.trim().toLowerCase();
  const words = value.split(/\s+/).filter(Boolean);
  const score = (entry: PaletteEntry) =>
    !value
      ? 0
      : entry.key === value || entry.label.toLowerCase() === value
        ? 0
        : entry.key.startsWith(value)
          ? 1
          : entry.label.toLowerCase().startsWith(value)
            ? 2
            : entry.label.toLowerCase().includes(value)
              ? 3
              : 4;
  return entries
    .filter((entry) =>
      !value
        ? entry.target.type !== 'Loaded issue'
        : words.every((word) => entry.terms.includes(word)),
    )
    .map((entry, order) => ({ entry, order, score: score(entry) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.priority - b.entry.priority ||
        a.order - b.order,
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function paletteSelection(entries: PaletteEntry[], selectedId?: string) {
  return entries.find((entry) => entry.id === selectedId) ?? entries[0];
}

export function movePaletteSelection(
  entries: PaletteEntry[],
  selectedId: string | undefined,
  direction: number,
) {
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.id === selectedId),
  );
  return entries[Math.max(0, Math.min(entries.length - 1, index + direction))]
    ?.id;
}

/** Reveal a loaded match in its owning hierarchy while preserving the root view. */
export function paletteIssueTab(
  tab: TabState,
  key: string,
  snapshot?: TreeSnapshot,
): TabState {
  const path = snapshot
    ? ancestorPath(buildIssueTree(snapshot.issues, snapshot.rootKey), key).map(
        (node) => node.issue.key,
      )
    : [];
  return {
    ...tab,
    selectedKey: key,
    focusKey: undefined,
    expanded: [...new Set([...tab.expanded, ...path])],
  };
}
