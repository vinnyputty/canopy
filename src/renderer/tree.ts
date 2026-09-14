import type { Issue, TreeSnapshot } from '../shared/types';

export type IssueNode = { issue: Issue; children: IssueNode[] };

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  commandPalette: 'Meta+K',
  quickOpen: 'Meta+P',
  newTab: 'Meta+T',
  closeTab: 'Meta+W',
  refresh: 'Meta+R',
  expandAll: 'Meta+Shift+E',
  collapseAll: 'Meta+Shift+C',
  shortcuts: 'Meta+/',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
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
  newTab: 'Open issue in new tab',
  closeTab: 'Close active tab',
  refresh: 'Refresh tree',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  shortcuts: 'Keyboard shortcuts',
  nextTab: 'Next tab',
  previousTab: 'Previous tab',
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
): IssueNode | null {
  const children = node.children
    .map((child) => visibleTree(child, hideDone))
    .filter((child): child is IssueNode => child !== null);
  if (
    hideDone &&
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
