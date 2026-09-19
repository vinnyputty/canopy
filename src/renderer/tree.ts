import type { Issue, TreeSnapshot, TreeFilters } from '../shared/types';

export type IssueNode = { issue: Issue; children: IssueNode[] };

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  commandPalette: 'Meta+K',
  quickOpen: 'Meta+P',
  findInTree: 'Meta+F',
  newTab: 'Meta+T',
  closeTab: 'Meta+W',
  reopenTab: 'Meta+Shift+T',
  refresh: 'Meta+R',
  expandAll: 'Meta+Shift+E',
  collapseAll: 'Meta+Shift+C',
  shortcuts: 'Meta+/',
  toggleSidebar: 'Meta+B',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
  selectTab1: 'Meta+1',
  selectTab2: 'Meta+2',
  selectTab3: 'Meta+3',
  selectTab4: 'Meta+4',
  selectTab5: 'Meta+5',
  selectTab6: 'Meta+6',
  selectTab7: 'Meta+7',
  selectTab8: 'Meta+8',
  selectTab9: 'Meta+9',
};

export function defaultShortcuts(
  platform = typeof navigator === 'undefined' ? 'Mac' : navigator.platform,
): Record<string, string> {
  if (/mac/i.test(platform)) return { ...DEFAULT_SHORTCUTS };
  return Object.fromEntries(
    Object.entries(DEFAULT_SHORTCUTS).map(([command, shortcut]) => [
      command,
      shortcut.replace('Meta', 'Ctrl'),
    ]),
  );
}

export const SHORTCUT_LABELS: Record<string, string> = {
  commandPalette: 'Show command palette',
  quickOpen: 'Open issue',
  findInTree: 'Find in tree',
  newTab: 'Open issue in new tab',
  closeTab: 'Close active tab',
  reopenTab: 'Reopen closed tab',
  refresh: 'Refresh tree',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  shortcuts: 'Keyboard shortcuts',
  toggleSidebar: 'Toggle sidebar',
  nextTab: 'Next tab',
  previousTab: 'Previous tab',
  selectTab1: 'Select tab 1',
  selectTab2: 'Select tab 2',
  selectTab3: 'Select tab 3',
  selectTab4: 'Select tab 4',
  selectTab5: 'Select tab 5',
  selectTab6: 'Select tab 6',
  selectTab7: 'Select tab 7',
  selectTab8: 'Select tab 8',
  selectTab9: 'Select tab 9',
};

export function buildIssueTree(
  issues: Issue[],
  rootKey: string,
): IssueNode | null {
  const nodes = new Map(
    issues.map((issue) => [issue.key, { issue, children: [] as IssueNode[] }]),
  );
  for (const node of nodes.values()) {
    if (node.issue.parentKey && nodes.has(node.issue.parentKey)) {
      let ancestor: Issue | undefined = nodes.get(node.issue.parentKey)?.issue;
      const visited = new Set<string>();
      let cyclic = false;
      while (ancestor && !visited.has(ancestor.key)) {
        if (ancestor.key === node.issue.key) {
          cyclic = true;
          break;
        }
        visited.add(ancestor.key);
        ancestor = ancestor.parentKey
          ? nodes.get(ancestor.parentKey)?.issue
          : undefined;
      }
      if (!cyclic) nodes.get(node.issue.parentKey)!.children.push(node);
    }
  }
  return nodes.get(rootKey) ?? null;
}

export function visibleTree(
  node: IssueNode,
  hideDone: boolean,
  keepKey?: string,
): IssueNode | null {
  const children = node.children
    .map((child) => visibleTree(child, hideDone, keepKey))
    .filter((child): child is IssueNode => child !== null);
  if (
    hideDone &&
    node.issue.key !== keepKey &&
    node.issue.status.category === 'done' &&
    children.length === 0
  )
    return null;
  return children === node.children ? node : { issue: node.issue, children };
}

export function flattenVisible(
  node: IssueNode | null,
  expanded: ReadonlySet<string>,
): IssueNode[] {
  if (!node) return [];
  const output: IssueNode[] = [];
  const visited = new Set<string>();
  const visit = (current: IssueNode) => {
    if (visited.has(current.issue.key)) return;
    visited.add(current.issue.key);
    output.push(current);
    if (expanded.has(current.issue.key)) current.children.forEach(visit);
  };
  visit(node);
  return output;
}

function issueEqual(a: Issue, b: Issue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Retains object identity for unchanged issues so background refreshes stay visually quiet. */
export function reconcileSnapshot(
  previous: TreeSnapshot | undefined,
  next: TreeSnapshot,
): TreeSnapshot {
  if (!previous) return next;
  const old = new Map(previous.issues.map((issue) => [issue.key, issue]));
  const issues = next.issues.map((issue) => {
    const prior = old.get(issue.key);
    return prior && issueEqual(prior, issue) ? prior : issue;
  });
  return { ...next, issues };
}

export function parseIssueKey(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(
    /\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i,
  )?.[1];
  const key = fromUrl ?? trimmed.match(/^([A-Z][A-Z0-9_]*-\d+)$/i)?.[1];
  return key?.toUpperCase() ?? null;
}

export function eventShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
): string {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return '';
  const pieces: string[] = [];
  if (event.metaKey) pieces.push('Meta');
  if (event.ctrlKey) pieces.push('Ctrl');
  if (event.altKey) pieces.push('Alt');
  if (event.shiftKey) pieces.push('Shift');
  const key =
    event.key === ' '
      ? 'Space'
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) pieces.push(key);
  return pieces.join('+');
}

export function shortcutCollisions(
  shortcuts: Record<string, string>,
): Map<string, string[]> {
  const byValue = new Map<string, string[]>();
  for (const [command, shortcut] of Object.entries(shortcuts)) {
    if (!shortcut) continue;
    byValue.set(shortcut, [...(byValue.get(shortcut) ?? []), command]);
  }
  return new Map([...byValue].filter(([, commands]) => commands.length > 1));
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: string | undefined,
): boolean {
  return Boolean(shortcut) && eventShortcut(event) === shortcut;
}

export function findNode(
  node: IssueNode | null,
  key?: string,
): IssueNode | null {
  if (!node || !key) return null;
  if (node.issue.key === key) return node;
  for (const child of node.children) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return null;
}
export function ancestorPath(
  node: IssueNode | null,
  key?: string,
): IssueNode[] {
  if (!node || !key) return [];
  if (node.issue.key === key) return [node];
  for (const child of node.children) {
    const path = ancestorPath(child, key);
    if (path.length) return [node, ...path];
  }
  return [];
}
export function expansionKeys(
  node: IssueNode | null,
  depth = Infinity,
): string[] {
  if (!node || depth <= 0) return [];
  return [
    node.issue.key,
    ...node.children.flatMap((child) => expansionKeys(child, depth - 1)),
  ];
}
export function filterTree(
  node: IssueNode | null,
  query: string,
  filters: TreeFilters,
  hideDone: boolean,
  accountId?: string,
  revealKey?: string,
  retainedKeys?: ReadonlySet<string>,
): IssueNode | null {
  if (!node) return null;
  const children = node.children
    .map((child) =>
      filterTree(
        child,
        query,
        filters,
        hideDone,
        accountId,
        revealKey,
        retainedKeys,
      ),
    )
    .filter((child): child is IssueNode => child !== null);
  const issue = node.issue;
  const matches =
    (!hideDone || issue.status.category !== 'done') &&
    (!query.trim() ||
      `${issue.key} ${issue.summary}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())) &&
    (!filters.assignee ||
      (filters.assignee === 'unassigned'
        ? !issue.assignee
        : Boolean(accountId) && issue.assignee?.id === accountId)) &&
    (!filters.status || filters.status === issue.status.id) &&
    (!filters.priority ||
      filters.priority === (issue.priority?.id ?? '__none__'));
  return matches ||
    children.length ||
    issue.key === revealKey ||
    retainedKeys?.has(issue.key)
    ? { issue, children }
    : null;
}
export function childCounts(node: IssueNode): {
  open: number;
  total: number;
  descendants: number;
} {
  return {
    open: node.children.filter(
      (child) => child.issue.status.category !== 'done',
    ).length,
    total: node.children.length,
    descendants: node.children.reduce(
      (count, child) => count + 1 + childCounts(child).descendants,
      0,
    ),
  };
}

export function indexTree(node: IssueNode | null): Map<string, IssueNode> {
  const result = new Map<string, IssueNode>();
  const visit = (current: IssueNode) => {
    result.set(current.issue.key, current);
    current.children.forEach(visit);
  };
  if (node) visit(node);
  return result;
}
