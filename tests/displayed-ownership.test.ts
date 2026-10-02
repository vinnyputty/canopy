import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { relationshipChangedKeys } from '../src/renderer/relationships';
import { Mutations } from '../src/renderer/mutations';
import { RootRefreshGate } from '../src/renderer/refresh';
import { buildIssueTree, type IssueNode } from '../src/renderer/tree';
import { retainEditingOrder } from '../src/renderer/edit-navigation';
import { markRootSeen, unseenChanges } from '../src/renderer/seen';
import type {
  CanopyAPI,
  Issue,
  TabState,
  TreeSnapshot,
} from '../src/shared/types';

// Run the actual App initializer, owner supplier, release callback and display
// effect with production Mutations/gate/tree code. Hook setters only capture
// published state; this is source execution, not mounted React/native evidence.
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
function find(predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  function walk(node: ts.Node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.ok(found);
  return found;
}
const initializer = (
  find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === '[mutations]',
  ) as ts.VariableDeclaration
).initializer!;
const displayEffect = (
  find(
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0].getText(ast).includes('displayedTrees.current.set'),
  ) as ts.CallExpression
).arguments[0];
const protection = (
  find(
    (n) =>
      ts.isVariableDeclaration(n) &&
      n.name.getText(ast) === 'protectedSnapshotIds',
  ) as ts.VariableDeclaration
).initializer!;
const rootIdentity = find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'refreshRootKey',
);
function execute(node: ts.Node, context: object) {
  return vm.runInNewContext(
    ts.transpileModule(`(${node.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}
const key = execute(rootIdentity, {}) as (tab: TabState) => string;
const tab = (id: string): TabState => ({
  id,
  rootKey: `T-${id}`,
  connectionId: id,
  expanded: [],
  hideDone: true,
  scrollTop: 321,
  selectedKey: `T-${id}`,
  focusKey: `T-${id}`,
});
const snapshot = (id: string, summary: string): TreeSnapshot => ({
  rootKey: `T-${id}`,
  issues: [
    {
      id,
      key: `T-${id}`,
      summary,
      type: 'Task',
      priority: null,
      assignee: null,
      status: { id: 'open', name: 'Open', category: 'new' },
      links: [],
    },
  ],
  fetchedAt: 1,
  warnings: [],
});
const bytes = (value: object) => Buffer.byteLength(JSON.stringify(value));
const a = tab('a'),
  b = tab('b');
const old = snapshot('a', '界'.repeat(1000)),
  next = snapshot('a', 'short'),
  other = snapshot('b', '界'.repeat(1000));
const boundary = bytes(old) + 2 * bytes(next) + 10;
function app(budget: number, api: Partial<CanopyAPI> = {}) {
  const displayedTrees = { current: new Map<string, IssueNode | null>() };
  const gate = new RootRefreshGate<TreeSnapshot>();
  const tabsRef = { current: [a, b, tab('c')] };
  let snapshots: Record<string, TreeSnapshot> = {},
    confirmed: Record<string, TreeSnapshot> = {},
    evicted = new Set<string>();
  const context = {
    useState: (initialize: () => Mutations) => [initialize()],
    Mutations,
    window: { canopy: api },
    tabsRef,
    relationshipChangedKeys,
    relationshipConfirmedSnapshots: {
      current: {} as Record<string, TreeSnapshot>,
    },
    invalidateRelationships: () => {},
    rootRefreshes: { current: gate },
    refreshRootKey: key,
    displayedTrees,
    setSnapshotEvictions: (value: Set<string>) => {
      evicted = value;
    },
    setSnapshots: (value: Record<string, TreeSnapshot>) => {
      snapshots = value;
    },
    setConfirmedSnapshots: (value: Record<string, TreeSnapshot>) => {
      confirmed = value;
    },
    setSaving: () => {},
    setUndoState: () => {},
    setErrors: () => {},
    setWorkspace: () => {},
  };
  const [mutations] = execute(initializer, context) as [Mutations];
  Reflect.set(mutations, 'snapshotBudget', budget);
  const sizes = () =>
    Reflect.get(mutations, 'snapshotSizes') as Map<string, number>;
  const display = (
    target: TabState,
    tree = buildIssueTree(snapshots[target.id].issues, target.rootKey),
  ) => {
    execute(displayEffect, {
      activeTab: target,
      shownTree: tree,
      displayedTrees,
    })();
    return tree;
  };
  const receive = async (target: TabState, snapshot: TreeSnapshot) => {
    const load = gate.load(key(target), true, false, async () => snapshot);
    assert.ok('promise' in load);
    mutations.receive(target, await load.promise, mutations.revision);
    const normalized = mutations.confirmedSnapshot(target.id);
    if (normalized) gate.replaceSnapshot(key(target), normalized);
  };
  return {
    mutations,
    gate,
    displayedTrees,
    display,
    receive,
    sizes,
    relationshipConfirmed: () => context.relationshipConfirmedSnapshots.current,
    snapshots: () => snapshots,
    confirmed: () => confirmed,
    evicted: () => evicted,
  };
}

test('actual App admission releases an inactive distinct displayed owner under the reviewed UTF8 boundary', async () => {
  const state = app(boundary);
  const navigation = JSON.stringify(a);
  const seen = markRootSeen(old);
  await state.receive(a, old);
  const graph = state.display(a)!;
  assert.equal(graph.issue, old.issues[0]);
  await state.receive(a, next);
  assert.notEqual(graph.issue, state.confirmed().a.issues[0]);
  await state.receive(b, other);
  state.display(b);
  assert.ok(state.evicted().has(a.id));
  assert.equal(state.displayedTrees.current.has(a.id), false);
  assert.equal(state.snapshots().a, undefined);
  assert.equal(state.confirmed().a, undefined);
  assert.equal(state.relationshipConfirmed().a, undefined);
  assert.equal(state.relationshipConfirmed(), state.confirmed());
  assert.equal(state.gate.snapshot(key(a)), undefined);
  assert.ok(state.snapshots().b);
  assert.ok(
    [...state.sizes().values()].reduce((total, size) => total + size, 0) <=
      boundary,
  );
  assert.equal(JSON.stringify(a), navigation);
  assert.equal(
    unseenChanges(seen.issues[old.rootKey], next.issues[0]).fields.length,
    1,
  );
});

test('displayed issues that exactly alias any admitted snapshot add no charge or eviction', async () => {
  const state = app(bytes(old) + 1);
  await state.receive(a, old);
  state.display(a);
  state.mutations.protectSnapshots([]); // actual admission with the graph present
  assert.equal(state.sizes().get(a.id), bytes(old));
  assert.equal(state.evicted().size, 0);
  assert.equal(
    state.displayedTrees.current.get(a.id)?.issue,
    state.snapshots().a.issues[0],
  );
  assert.equal(state.gate.snapshot(key(a)), state.confirmed().a);
});

test('actual admission includes old collapsed descendants even when the root issue aliases current data', async () => {
  const before = snapshot('a', 'root');
  before.issues.push({
    ...old.issues[0],
    id: 'child',
    key: 'T-child',
    parentKey: before.rootKey,
  });
  const after = {
    ...before,
    issues: [before.issues[0], { ...before.issues[1], summary: 'short child' }],
  };
  const state = app(bytes(before) + 2 * bytes(after) + 10);
  await state.receive(a, before);
  const graph = state.display(a)!;
  assert.deepEqual(a.expanded, []);
  await state.receive(a, after);
  assert.equal(graph.issue, state.snapshots().a.issues[0]);
  assert.notEqual(graph.children[0].issue, state.snapshots().a.issues[1]);
  await state.receive(b, other);
  state.display(b);
  assert.ok(state.evicted().has(a.id));
  assert.equal(state.displayedTrees.current.has(a.id), false);
  assert.equal(state.gate.snapshot(key(a)), undefined);
});

for (const owner of [
  'active',
  'editor',
  'child',
  'selection',
  'bulk',
  'saved',
] as const) {
  test(`actual App ${owner} protection retains the displayed owner and charges its distinct old issue`, async () => {
    const state = app(boundary);
    const owners = JSON.parse(
      execute(protection, {
        bulkOperations: owner === 'bulk' ? { [a.id]: { id: 'operation' } } : {},
        childParent: owner === 'child' ? { tabId: a.id } : null,
        multiSelection: owner === 'selection' ? { tabId: a.id } : null,
        activeSavedView: owner === 'saved' ? { id: 'view' } : null,
        activeViewSourceIdsRef: { current: [a.id] },
        activeTab: owner === 'active' ? a : null,
        allRefreshTabs: [a, b],
        editor: owner === 'editor' ? { connectionId: a.connectionId } : null,
      }),
    ) as string[];
    state.mutations.protectSnapshots(owners);
    await state.receive(a, old);
    const graph = state.display(a)!;
    await state.receive(a, next);
    assert.equal(state.sizes().get(a.id), 2 * bytes(next) + bytes(graph.issue));
    await state.receive(b, other);
    assert.equal(state.displayedTrees.current.get(a.id), graph);
    assert.equal(state.confirmed().a.issues[0].summary, 'short');
    assert.ok(!state.evicted().has(a.id));
    assert.ok(state.evicted().has(b.id));
    assert.equal(state.gate.snapshot(key(b)), undefined);
    // Removing the owner subjects its graph to the same real admission budget.
    state.mutations.protectSnapshots([]);
    await state.receive(b, other);
    assert.ok(state.evicted().has(a.id));
    assert.equal(state.displayedTrees.current.has(a.id), false);
    assert.equal(state.gate.snapshot(key(a)), undefined);
  });
}

test('pending production write protects and accounts its old displayed data until settlement', async () => {
  let finish!: (issue: Issue) => void;
  const state = app(boundary, {
    update: () =>
      new Promise<Issue>((resolve) => {
        finish = resolve;
      }),
  });
  await state.receive(a, old);
  const graph = state.display(a)!;
  const write = state.mutations.update(a.connectionId, old.rootKey, {
    summary: 'Saved',
  });
  await Promise.resolve();
  await state.receive(a, next);
  await state.receive(b, other);
  assert.equal(state.displayedTrees.current.get(a.id), graph);
  assert.equal(state.snapshots().a.issues[0].summary, 'Saved');
  assert.ok(!state.evicted().has(a.id));
  assert.ok(state.evicted().has(b.id));
  finish({ ...next.issues[0], summary: 'Saved' });
  await write;
  assert.ok(state.evicted().has(a.id));
  assert.equal(state.displayedTrees.current.has(a.id), false);
  assert.equal(state.gate.snapshot(key(a)), undefined);
});

test('protected active editing order consumes the retained graph and updates through the real display effect', async () => {
  const state = app(1);
  state.mutations.protectSnapshots([a.id]);
  const first = snapshot('a', 'root');
  first.issues.push(
    { ...old.issues[0], id: 'one', key: 'T-one', parentKey: first.rootKey },
    { ...next.issues[0], id: 'two', key: 'T-two', parentKey: first.rootKey },
  );
  await state.receive(a, first);
  const displayed = state.display(a)!;
  const second = {
    ...first,
    issues: [
      first.issues[0],
      first.issues[2],
      { ...first.issues[1], summary: 'changed' },
    ],
  };
  await state.receive(a, second);
  assert.equal(state.displayedTrees.current.get(a.id), displayed);
  const ordered = retainEditingOrder(
    buildIssueTree(state.snapshots().a.issues, a.rootKey),
    displayed,
    new Set(['T-one']),
  )!;
  state.display(a, ordered);
  assert.deepEqual(
    ordered.children.map((node) => node.issue.key),
    ['T-one', 'T-two'],
  );
  assert.equal(ordered.children[0].issue.summary, 'changed');
  state.mutations.protectSnapshots([a.id]);
  assert.equal(state.sizes().get(a.id), 2 * bytes(second)); // current displayed issues are aliases again
  assert.ok(!state.evicted().has(a.id));
  assert.equal(state.displayedTrees.current.get(a.id), ordered);
});
