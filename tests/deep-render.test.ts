import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TreeRows } from '../src/renderer/App';
import {
  buildIssueTree,
  expansionKeys,
  filterTree,
  flattenVisible,
  ancestorPath,
  findNode,
  indexTree,
  treeCounts,
  visibleRows,
} from '../src/renderer/tree';
import { sortIssueTree } from '../src/renderer/table-view';
import { retainEditingOrder } from '../src/renderer/edit-navigation';
import {
  activateTab,
  sameRoot,
  visit,
  closeTabs,
} from '../src/renderer/workspace';
import { nextTasks } from '../src/renderer/next-tasks';
import { withScrollPositions } from '../src/renderer/scroll-position';
import type { Issue, Workspace } from '../src/shared/types';

const issue = (i: number): Issue => ({
  id: String(i),
  key: `D-${i}`,
  summary: `Region ${i}`,
  parentKey: i ? `D-${i - 1}` : undefined,
  type: 'Task',
  status: { id: 'open', name: 'Open', category: 'new' },
  priority: null,
  assignee: null,
  links: [],
});
export const rowProps = (
  size: number,
): React.ComponentProps<typeof TreeRows> => {
  const issues = Array.from({ length: size }, (_, i) => issue(i));
  return {
    node: buildIssueTree(issues, issues[0].key)!,
    provider: 'demo',
    columns: ['issue', 'priority', 'assignee', 'status'],
    rankableKeys: new Set(issues.slice(1).map((i) => i.key)),
    rankingEnabled: true,
    depth: 0,
    statusColors: new Map(),
    expanded: new Set(issues.map((i) => i.key)),
    linkedExpanded: new Set(),
    expansionLocked: false,
    counts: treeCounts(buildIssueTree(issues, issues[0].key)!),
    seenIssues: {},
    confirmedIssues: new Map(issues.map((i) => [i.key, i])),
    selectedKey: 'D-1',
    selectedKeys: new Set(),
    suppressFocus: { current: false },
    editor: null,
    options: {},
    saving: new Set(),
    dragKey: null,
    onToggleLinks: () => {},
    onToggle: () => {},
    onSelect: () => {},
    onMultiSelect: () => {},
    onOpenTab: () => {},
    onOpenExternal: () => {},
    onOpenWorkflow: () => {},
    onCopyLink: () => {},
    onPreview: () => {},
    onContextMenu: () => {},
    beginEdit: () => {},
    cancelEdit: () => {},
    changeAssigneeQuery: () => {},
    loadOptions: async () => {},
    updateIssue: async () => {},
    statusPaths: () => ({ routes: [], truncated: false }),
    transitionPath: async () => {},
    advanceEdit: () => {},
    setDragKey: () => {},
    rankBefore: async () => {},
    keyboardRank: () => {},
    focusNeighbor: () => {},
  };
};

test('actual rich React rows render the representative 2001-depth chain with shallow DOM and complete identities', () => {
  const html = renderToStaticMarkup(
    React.createElement(TreeRows, rowProps(2001)),
  );
  assert.equal((html.match(/data-tree-key=/g) ?? []).length, 2001);
  assert.ok(html.includes('aria-level="2001"'));
  assert.ok(html.includes('aria-posinset="1" aria-setsize="1"'));
  assert.ok(html.includes('Actions for D-2000'));
  assert.ok(html.includes('Edit priority for D-2000'));
  assert.ok(!html.includes('role="group"'));
});

test('deep production filtering, counts, sorting, editor order and navigation retain every ancestor without recursive stack exhaustion', () => {
  const size = 20001,
    issues = Array.from({ length: size }, (_, i) => issue(i));
  const tree = buildIssueTree(issues, issues[0].key)!;
  const filtered = filterTree(tree, `Region ${size - 1}`, {}, true)!;
  assert.equal(indexTree(filtered).size, size);
  assert.equal(ancestorPath(filtered, issues.at(-1)!.key).length, size);
  assert.equal(findNode(filtered, issues.at(-1)!.key)?.issue, issues.at(-1));
  assert.equal(treeCounts(filtered).get(issues[0].key)?.descendants, size - 1);
  const expanded = new Set(expansionKeys(filtered));
  assert.equal(flattenVisible(filtered, expanded).length, size);
  const sorted = sortIssueTree(filtered, {
    column: 'issue',
    direction: 'desc',
  });
  const retained = retainEditingOrder(sorted, tree, expanded)!;
  assert.equal(findNode(retained, issues.at(-1)!.key)?.issue, issues.at(-1));
  assert.equal(visibleRows(retained, expanded).at(-1)?.depth, size - 1);
  assert.equal(expansionKeys(tree, 2).length, 2);
});

test('actual App skips the closed Next Tasks pane and still builds deep open task ancestry and rank paths', () => {
  const tasks = expression(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'tasks',
  ) as ts.VariableDeclaration;
  const callback = (tasks.initializer as ts.CallExpression).arguments[0];
  let called = false;
  const closed = run(callback, {
    snapshot: {},
    nextTaskOpen: false,
    nextTasks: () => {
      called = true;
      return [];
    },
  });
  assert.equal(closed().length, 0);
  assert.equal(called, false);
  const issues = Array.from({ length: 2001 }, (_, i) => issue(i));
  const output = nextTasks(
    { rootKey: issues[0].key, issues, fetchedAt: 1, warnings: [] },
    'jira',
    'rank',
  );
  assert.equal(output.length, issues.length);
  assert.equal(output.at(-1)?.parents.length, 2000);
  assert.equal(output.at(-1)?.rankPath.length, 2000);
  assert.equal(output.at(-1)?.parents[0], issues[0]);
});

test('flat row projection preserves filtered sibling positions, collapse, pinned draft and linked-row controls', () => {
  const props = rowProps(3);
  props.node.children.push({
    issue: {
      ...issue(3),
      parentKey: 'D-0',
      status: { id: 'done', name: 'Done', category: 'done' },
    },
    children: [],
  });
  props.node.children.push({
    issue: { ...issue(4), parentKey: 'D-0' },
    children: [],
  });
  const filtered = filterTree(
    props.node,
    '',
    {},
    true,
    undefined,
    undefined,
    new Set(['D-3']),
  )!;
  const rows = visibleRows(filtered, new Set(['D-0']));
  assert.deepEqual(
    rows.map((r) => [r.node.issue.key, r.depth, r.position, r.siblings]),
    [
      ['D-0', 0, 1, 1],
      ['D-1', 1, 1, 3],
      ['D-3', 1, 2, 3],
      ['D-4', 1, 3, 3],
    ],
  );
  assert.deepEqual(
    visibleRows(filtered, new Set()).map((r) => r.node.issue.key),
    ['D-0'],
  );
  props.node.issue.links = [
    {
      relationship: 'relates to',
      key: 'OTHER-1',
      summary: 'Linked work',
      statusCategory: 'new',
    },
  ];
  props.linkedExpanded.add('D-0');
  const html = renderToStaticMarkup(React.createElement(TreeRows, props));
  assert.ok(html.includes('OTHER-1'));
  assert.ok(html.includes('aria-selected="true"'));
});

const source = readFileSync(
  new URL('../src/renderer/App.tsx', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'App.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function expression(predicate: (n: ts.Node) => boolean) {
  let result: ts.Node | undefined;
  function visit(n: ts.Node) {
    if (predicate(n)) result = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(result);
  return result;
}
function run(node: ts.Node, context: object) {
  return vm.runInNewContext(
    ts.transpileModule(`(${node.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}
const scroll = expression(
  (n) =>
    ts.isJsxAttribute(n) &&
    n.name.getText(ast) === 'onScroll' &&
    n.getText(ast).includes('pendingScrollRestore'),
) as ts.JsxAttribute;
const scrollHandler = (scroll.initializer as ts.JsxExpression).expression!;
const workspace: Workspace = {
  tabs: [
    {
      id: 'a',
      connectionId: 'a',
      rootKey: 'D-0',
      expanded: [],
      hideDone: true,
      scrollTop: 1,
    },
  ],
  activeTabId: 'a',
  theme: 'system',
  sidebarCollapsed: false,
  shortcuts: {},
};

test('actual App scroll handler keeps immediate navigation/persistence offsets without scheduling rich App state renders', () => {
  const positions = { current: new Map<string, number>() },
    workspaceRef = { current: workspace };
  let renderUpdates = 0,
    saves = 0,
    timer: (() => void) | undefined;
  const handler = run(scrollHandler, {
    snapshot: {},
    pendingScrollRestore: { current: null },
    activeTab: workspace.tabs[0],
    scrollPositions: positions,
    workspaceRef,
    withScrollPositions,
    scrollSaveTimer: { current: undefined },
    setTimeout: (callback: () => void) => {
      timer = callback;
      return 1;
    },
    clearTimeout: () => {
      timer = undefined;
    },
    saveWorkspace: (value: Workspace) => {
      saves++;
      assert.equal(value.tabs[0].scrollTop, 990);
      return Promise.resolve();
    },
    setErrors: () => {},
    updateTab: () => {
      renderUpdates++;
    },
    setWorkspace: () => {
      renderUpdates++;
    },
  });
  for (let i = 0; i < 100; i++)
    handler({ currentTarget: { scrollTop: i * 10 } });
  assert.equal(renderUpdates, 0);
  assert.equal(workspaceRef.current.tabs[0].scrollTop, 990);
  assert.equal(saves, 0);
  assert.ok(timer);
  timer();
  assert.equal(saves, 1);
  const updated = withScrollPositions(
    { ...workspace, closedTabs: workspace.tabs, tabs: [] },
    positions.current,
  );
  assert.equal(updated.closedTabs?.[0].scrollTop, 990);
  assert.equal(workspace.tabs[0].scrollTop, 1);
});

test('actual App scroll restoration guards placeholder events and restores latest offsets during progressive snapshots', () => {
  const handler = run(scrollHandler, {
    snapshot: undefined,
    pendingScrollRestore: { current: 'a' },
    activeTab: workspace.tabs[0],
  });
  assert.doesNotThrow(() => handler({ currentTarget: { scrollTop: 0 } }));
  const restore = expression(
    (n) =>
      ts.isVariableDeclaration(n) && n.name.getText(ast) === 'restoreScroll',
  ) as ts.VariableDeclaration;
  const callback = (restore.initializer as ts.CallExpression).arguments[0];
  const element = { scrollTop: 0 };
  const restoreFn = run(callback, {
    scrollRef: { current: element },
    scrollPositions: { current: new Map([['a', 990]]) },
    setWorkspace: () => {
      throw new Error('No clamping expected');
    },
  });
  restoreFn(workspace.tabs[0]);
  assert.equal(element.scrollTop, 990);
});

test('actual App navigation restores history offsets and preserves a just-scrolled tab through close/reopen state', () => {
  const declaration = expression(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'navigate',
  ) as ts.VariableDeclaration;
  const callback = (declaration.initializer as ts.CallExpression).arguments[0];
  const positions = { current: new Map([['a', 990]]) };
  let state = workspace;
  const refs = { current: withScrollPositions(state, positions.current) };
  const navigate = run(callback, {
    workspaceRef: refs,
    historyRef: { current: { back: [], forward: [] } },
    setHistory: () => {},
    visit,
    sameRoot,
    activateTab,
    pendingScrollRestore: { current: null },
    scrollPositions: positions,
    setWorkspace: (update: (current: Workspace) => Workspace) => {
      state = update(withScrollPositions(state, positions.current));
    },
  });
  navigate({ ...workspace.tabs[0], scrollTop: 42 }, true);
  assert.equal(state.tabs[0].scrollTop, 42);
  assert.equal(positions.current.has('a'), false);
  positions.current.set('a', 700);
  const closed = closeTabs(withScrollPositions(state, positions.current), [
    'a',
  ]);
  assert.equal(closed.closedTabs?.[0].scrollTop, 700);
});
