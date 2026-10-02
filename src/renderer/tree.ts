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
  // A parent graph has at most one outgoing edge per issue. Classify each
  // path once; only members of a cycle lose their parent edge.
  const classified = new Set<string>();
  const cyclic = new Set<string>();
  for (const key of nodes.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = key;
    while (current && nodes.has(current) && !classified.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        for (const member of path.slice(position)) cyclic.add(member);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = nodes.get(current)!.issue.parentKey;
    }
    for (const member of path) classified.add(member);
  }
  for (const node of nodes.values()) {
    if (node.issue.parentKey && !cyclic.has(node.issue.key))
      nodes.get(node.issue.parentKey)?.children.push(node);
  }
  return nodes.get(rootKey) ?? null;
}

/** Postorder transforms keep deep provider hierarchies off the JS call stack. */
export function mapIssueTree(
  root: IssueNode,
  transform: (node: IssueNode, children: IssueNode[]) => IssueNode | null,
): IssueNode | null {
  const pending: IssueNode[] = [root],
    order: IssueNode[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    order.push(node);
    for (const child of node.children) pending.push(child);
  }
  const results = new Map<IssueNode, IssueNode | null>();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    results.set(
      node,
      transform(
        node,
        node.children
          .map((child) => results.get(child)!)
          .filter((child): child is IssueNode => child !== null),
      ),
    );
  }
  return results.get(root)!;
}

export function visibleTree(
  node: IssueNode,
  hideDone: boolean,
  keepKey?: string,
): IssueNode | null {
  return mapIssueTree(node, (current, children) =>
    hideDone &&
    current.issue.key !== keepKey &&
    current.issue.status.category === 'done' &&
    !children.length
      ? null
      : { issue: current.issue, children },
  );
}

export function flattenVisible(
  node: IssueNode | null,
  expanded: ReadonlySet<string>,
): IssueNode[] {
  if (!node) return [];
  const output: IssueNode[] = [],
    pending = [node];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.issue.key)) continue;
    visited.add(current.issue.key);
    output.push(current);
    if (expanded.has(current.issue.key))
      for (let i = current.children.length - 1; i >= 0; i--)
        pending.push(current.children[i]);
  }
  return output;
}

export function visibleRows(node: IssueNode, expanded: ReadonlySet<string>) {
  const output: {
    node: IssueNode;
    depth: number;
    position: number;
    siblings: number;
  }[] = [];
  const pending = [{ node, depth: 0, position: 1, siblings: 1 }];
  while (pending.length) {
    const row = pending.pop()!;
    output.push(row);
    if (expanded.has(row.node.issue.key))
      for (let i = row.node.children.length - 1; i >= 0; i--)
        pending.push({
          node: row.node.children[i],
          depth: row.depth + 1,
          position: i + 1,
          siblings: row.node.children.length,
        });
  }
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
  const github = trimmed.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/i);
  if (github) return `${github[1].toLowerCase()}#${github[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.origin === 'https://github.com') {
      const match = url.pathname.match(
        /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/i,
      );
      if (match)
        return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
    }
  } catch {}
  const fromUrl = trimmed.match(
    /\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i,
  )?.[1];
  const key = fromUrl ?? trimmed.match(/^([A-Z][A-Z0-9_]*-\d+)$/i)?.[1];
  return key?.toUpperCase() ?? null;
}

export function parseGithubRepository(input: string): string | null {
  const trimmed = input.trim();
  const direct = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (direct) return `${direct[1].toLowerCase()}/${direct[2].toLowerCase()}`;
  try {
    const url = new URL(trimmed);
    if (url.origin === 'https://github.com') {
      const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/?$/);
      if (match) return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
  } catch {}
  return null;
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
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.issue.key === key) return current;
    for (let i = current.children.length - 1; i >= 0; i--)
      pending.push(current.children[i]);
  }
  return null;
}
export function ancestorPath(
  node: IssueNode | null,
  key?: string,
): IssueNode[] {
  if (!node || !key) return [];
  const parents = new Map<IssueNode, IssueNode>();
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.issue.key === key) {
      const path = [current];
      let parent = parents.get(current);
      while (parent) {
        path.push(parent);
        parent = parents.get(parent);
      }
      return path.reverse();
    }
    for (let i = current.children.length - 1; i >= 0; i--) {
      parents.set(current.children[i], current);
      pending.push(current.children[i]);
    }
  }
  return [];
}
export function expansionKeys(
  node: IssueNode | null,
  depth = Infinity,
): string[] {
  if (!node || depth <= 0) return [];
  const output: string[] = [],
    pending = [{ node, depth }];
  while (pending.length) {
    const current = pending.pop()!;
    output.push(current.node.issue.key);
    if (current.depth > 1)
      for (let i = current.node.children.length - 1; i >= 0; i--)
        pending.push({
          node: current.node.children[i],
          depth: current.depth - 1,
        });
  }
  return output;
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
  return mapIssueTree(node, (current, children) => {
    const issue = current.issue;
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
  });
}
export function treeCounts(
  node: IssueNode | null,
): Map<string, { open: number; total: number; descendants: number }> {
  const result = new Map<
    string,
    { open: number; total: number; descendants: number }
  >();
  if (node)
    mapIssueTree(node, (current) => {
      result.set(current.issue.key, {
        open: current.children.filter(
          (child) => child.issue.status.category !== 'done',
        ).length,
        total: current.children.length,
        descendants: current.children.reduce(
          (sum, child) => sum + 1 + result.get(child.issue.key)!.descendants,
          0,
        ),
      });
      return current;
    });
  return result;
}
export function childCounts(node: IssueNode) {
  return treeCounts(node).get(node.issue.key)!;
}

export function indexTree(node: IssueNode | null): Map<string, IssueNode> {
  const result = new Map<string, IssueNode>(),
    pending = node ? [node] : [];
  while (pending.length) {
    const current = pending.pop()!;
    result.set(current.issue.key, current);
    for (let i = current.children.length - 1; i >= 0; i--)
      pending.push(current.children[i]);
  }
  return result;
}
