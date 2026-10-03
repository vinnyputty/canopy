import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarWork } from '../src/renderer/SidebarWork';
import { emptySidebarSession } from '../src/renderer/sidebar-organization';
import ts from 'typescript';
import { Mutations, type MutationView } from '../src/renderer/mutations';
import { RootRefreshGate, RefreshSchedule } from '../src/renderer/refresh';
import { markRootSeen, unseenChanges } from '../src/renderer/seen';
import type {
  CanopyAPI,
  Issue,
  TabState,
  TreeSnapshot,
} from '../src/shared/types';

// Execute unchanged production callbacks with controlled refs/transport, not a
// parallel model of App. These checks do not claim mounted React acceptance.
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
function expression(name: string) {
  let found: ts.Expression | undefined;
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      found = node.initializer;
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.ok(found, name);
  return found;
}
function execute(node: ts.Node, context: object) {
  return vm.runInNewContext(
    ts.transpileModule(`(${node.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}
function callback(name: string, context: object) {
  return execute((expression(name) as ts.CallExpression).arguments[0], context);
}
const ref = <T>(current: T) => ({ current });
const tab = (id: string, rootKey = 'T-0'): TabState => ({
  id,
  rootKey,
  connectionId: 'c',
  expanded: [],
  hideDone: true,
  scrollTop: 0,
});
const rootKey = (t: TabState) => JSON.stringify([t.connectionId, t.rootKey]);
const issue = (i: number, summary = `Issue ${i}`): Issue => ({
  id: String(i),
  key: `T-${i}`,
  summary,
  type: 'Task',
  parentKey: i ? 'T-0' : undefined,
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
});
const snap = (issues: Issue[], partial = false): TreeSnapshot => ({
  rootKey: 'T-0',
  issues,
  fetchedAt: 1,
  warnings: [],
  ...(partial ? { incomplete: { reason: 'Offline', calls: 2 } } : {}),
});
function refreshContext(tabs: TabState[]) {
  const calls: string[] = [];
  const gate = new RootRefreshGate<TreeSnapshot>();
  const schedule = new RefreshSchedule();
  schedule.sync(
    tabs.map((t) => t.id),
    tabs[0]?.id ?? null,
    Date.now(),
  );
  const mutations = new Mutations(
    {} as CanopyAPI,
    () => {},
    () => {},
  );
  const context = {
    tabsRef: ref(tabs),
    manualRelationshipRefreshes: ref(new Set<string>()),
    invalidateRelationships: () => {},
    forcedRefreshes: ref(new Set<string>()),
    cancelledTrees: ref(new Set<string>()),
    refreshRootKey: rootKey,
    mutations,
    activeIdRef: ref(tabs[0]?.id),
    activeViewSourceIdsRef: ref([]),
    navigator: { onLine: true },
    demoMode: false,
    refreshBlocked: ref<() => boolean>(() => false),
    deferredRefreshes: ref(new Set<string>()),
    cooldowns: ref<Record<string, number>>({}),
    refreshSchedule: ref(schedule),
    rootRefreshes: ref(gate),
    snapshotsRef: ref({}),
    crypto: { randomUUID: () => String(calls.length + 1) },
    treeRequests: ref(new Map()),
    treeMounted: ref(true),
    window: {
      canopy: {
        tree: async (_c: string, _r: string, id: string) => {
          calls.push(id);
          return snap([issue(0)]);
        },
        syncStatus: async () => ({ retryAt: null }),
        cancelTree: async () => {},
      },
    },
    refreshSequences: ref({}),
    runningExplicitRefreshes: ref(new Map()),
    setRefreshing: () => {},
    setLoading: () => {},
    setCooldownTimes: () => {},
    connectionsRef: ref([]),
    pickers: {},
    workspaceRef: ref({ seenRoots: {} }),
    setWorkspace: () => {},
    seenRootKey: () => '',
    boundRoots: (v: unknown) => v,
    seedOrExtend: () => {},
    setConnectionErrors: () => {},
    setErrors: () => {},
  };
  return { context, calls, refresh: callback('refreshTab', context) };
}

test('App cancellation survives automatic cooldown/forced freshness; user Retry restarts', async () => {
  const a = tab('a');
  const { context, calls, refresh } = refreshContext([a]);
  context.cancelledTrees.current.add(rootKey(a));
  context.forcedRefreshes.current.add(a.id);
  context.cooldowns.current.c = Date.now() - 1;
  execute(expression('tick'), {
    ...context,
    Date,
    setSyncNow: () => {},
    refreshTab: refresh,
  })();
  await Promise.resolve();
  await refresh(a, true, true); // workflow freshness is explicit but not Retry
  assert.equal(calls.length, 0);
  assert.ok(context.cancelledTrees.current.has(rootKey(a)));
  await refresh(a, true, true, true, true);
  assert.equal(calls.length, 1);
  assert.equal(context.cancelledTrees.current.has(rootKey(a)), false);
});

function forgetContext(tabs: TabState[], sources: TabState[] = []) {
  const cancelled = new Set([rootKey(tabs[0])]);
  const aborted: string[] = [];
  let view!: MutationView;
  const mutations = new Mutations(
    {} as CanopyAPI,
    (v) => {
      view = v;
    },
    () => {},
  );
  mutations.protectSnapshots(tabs.map((t) => t.id));
  mutations.receive(
    tabs[0],
    snap([issue(0), issue(1, 'Remote change')], true),
    0,
  );
  const gate = new RootRefreshGate<TreeSnapshot>();
  const context = {
    workspaceRef: ref({ tabs }),
    tabsRef: ref(tabs),
    sourceTabsRef: ref(sources),
    refreshRootKey: rootKey,
    sameRoot: (a: TabState, b: TabState) => rootKey(a) === rootKey(b),
    rootRefreshes: ref(gate),
    cancelTree: (t: TabState) => aborted.push(t.id),
    cancelledTrees: ref(cancelled),
    mutations,
    displayedTrees: ref(new Map()),
    attemptedLoads: ref(new Set()),
    refreshSequences: ref({}),
    refreshSchedule: ref(new RefreshSchedule()),
    deferredRefreshes: ref(new Set()),
    manualRelationshipRefreshes: ref(new Set()),
    forcedRefreshes: ref(new Set()),
    runningExplicitRefreshes: ref(new Map()),
    setLoading: () => {},
    setRefreshing: () => {},
    setConnectionErrors: () => {},
    setErrors: () => {},
  };
  return {
    context,
    aborted,
    forget: callback('forgetTabs', context),
    view: () => view,
  };
}
test('App closing duplicate consumer preserves root cancellation and normalized snapshot', () => {
  const a = tab('a'),
    b = tab('b');
  const f = forgetContext([a, b]);
  f.forget(['a']);
  assert.deepEqual(f.aborted, []);
  assert.ok(f.context.cancelledTrees.current.has(rootKey(b)));
  assert.equal(f.view().confirmedSnapshots.b.issues.length, 2);
  assert.ok(f.view().confirmedSnapshots.b.incomplete);
  assert.equal(f.view().snapshots.a, undefined);
});
test('App real-to-saved consumer handoff retains read ownership, partial descendants and unread', () => {
  const real = tab('real'),
    virtual = tab('saved-view:c/T-0');
  const f = forgetContext([real], [virtual]);
  const seen = markRootSeen(snap([issue(0), issue(1)]));
  f.forget(['real']);
  assert.deepEqual(f.aborted, []);
  assert.equal(f.context.tabsRef.current[0].id, virtual.id);
  assert.ok(f.context.cancelledTrees.current.has(rootKey(real)));
  const retained = f.view().confirmedSnapshots[virtual.id];
  assert.equal(retained.issues.length, 2);
  assert.ok(retained.incomplete);
  assert.equal(
    unseenChanges(seen.issues['T-1'], retained.issues[1]).fields.length,
    1,
  );
});

for (const action of ['forget', 'invalidateQueued', 'clear'] as const) {
  test(`gate ${action} prevents queued provider dispatch`, async () => {
    const gate = new RootRefreshGate<TreeSnapshot>();
    let finish!: (s: TreeSnapshot) => void;
    let calls = 0;
    const first = gate.load('root', false, true, () => {
      calls++;
      return new Promise<TreeSnapshot>((r) => {
        finish = r;
      });
    });
    const second = gate.load('root', true, true, async () => {
      calls++;
      return snap([issue(0)]);
    });
    assert.ok('promise' in first && 'promise' in second);
    if (action === 'clear') gate.clear();
    else gate[action]('root');
    const rejection = assert.rejects(
      second.promise,
      /cancelled before dispatch/,
    );
    finish(snap([issue(0)], true));
    await first.promise;
    await rejection;
    assert.equal(calls, 1);
    if (action === 'invalidateQueued')
      assert.ok(gate.isCurrent('root', first.generation));
    else assert.equal(gate.snapshot('root'), undefined);
  });
}
test('App validates actual surviving consumers again at queued dispatch', async () => {
  const a = tab('a'),
    b = tab('b');
  const { context, refresh, calls } = refreshContext([a, b]);
  let finish!: (s: TreeSnapshot) => void;
  context.window.canopy.tree = (_c, _r, id) => {
    calls.push(id);
    if (calls.length > 1) return Promise.resolve(snap([issue(0)], true));
    return new Promise<TreeSnapshot>((r) => {
      finish = r;
    });
  };
  const first = refresh(a),
    second = refresh(b, false, true);
  context.tabsRef.current = [];
  finish(snap([issue(0)], true));
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
});
test('App progress lifecycle cleanup aborts transports and invalidates queued work', async () => {
  const { context } = refreshContext([tab('a')]);
  let unsubscribed = false,
    aborted = 0;
  const listeners = new Map<string, () => void>();
  context.treeRequests.current.set(rootKey(tab('a')), {
    id: 'request',
    epoch: 0,
  });
  const effectContext = {
    ...context,
    window: {
      addEventListener: (name: string, listener: () => void) =>
        listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
      canopy: {
        onTreeProgress: () => () => {
          unsubscribed = true;
        },
        cancelTree: () => {
          aborted++;
        },
      },
    },
  };
  let effect!: ts.ArrowFunction;
  function walk(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0].getText(ast).includes('window.canopy.onTreeProgress')
    )
      effect = n.arguments[0] as ts.ArrowFunction;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  const gate = context.rootRefreshes.current;
  let finish!: (s: TreeSnapshot) => void;
  const first = gate.load(
    'root',
    false,
    true,
    () =>
      new Promise<TreeSnapshot>((r) => {
        finish = r;
      }),
  );
  const queued = gate.load('root', true, true, async () => {
    throw new Error('orphan transport');
  });
  assert.ok('promise' in first && 'promise' in queued);
  const rejection = assert.rejects(queued.promise, /cancelled before dispatch/);
  const cleanup = execute(effect, effectContext)();
  assert.ok(listeners.has('beforeunload'));
  listeners.get('beforeunload')!();
  cleanup();
  assert.equal(listeners.size, 0);
  assert.equal(context.treeMounted.current, false);
  assert.equal(unsubscribed, true);
  assert.equal(aborted, 1);
  finish(snap([issue(0)], true));
  await first.promise;
  await rejection;
});
test('new consumer merges retained normalized partial instead of dropping known unread descendant', async () => {
  const gate = new RootRefreshGate<TreeSnapshot>(() => 100);
  let view!: MutationView;
  const mutations = new Mutations(
    {} as CanopyAPI,
    (v) => {
      view = v;
    },
    () => {},
  );
  const virtual = tab('saved-view:root'),
    real = tab('real');
  const full = snap([issue(0), issue(1, 'Remote')]);
  const first = gate.load('root', false, true, async () => full);
  assert.ok('promise' in first);
  mutations.receive(virtual, await first.promise, 0);
  const partial = gate.load('root', true, false, async () =>
    snap([issue(0)], true),
  );
  assert.ok('promise' in partial);
  mutations.receive(virtual, await partial.promise, 0);
  const newConsumer = gate.load('root', false, true, () => {
    throw new Error('extra transport');
  });
  assert.ok('promise' in newConsumer);
  mutations.receive(real, await newConsumer.promise, 0);
  mutations.forget(virtual.id);
  assert.equal(view.snapshots.real.issues.length, 2);
  assert.ok(view.snapshots.real.incomplete);
  assert.equal(
    unseenChanges(
      markRootSeen(snap([issue(0), issue(1)])).issues['T-1'],
      view.snapshots.real.issues[1],
    ).fields.length,
    1,
  );
});
test('budget charges distinct rendered/confirmed records and releases both owners', () => {
  const snapshot = snap([issue(0, '界'.repeat(1000))]);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  let view!: MutationView;
  const mutations = new Mutations(
    {} as CanopyAPI,
    (v) => {
      view = v;
    },
    () => {},
    undefined,
    bytes + 5,
  );
  mutations.receive(tab('a'), snapshot, 0);
  assert.ok(view.snapshots.a); // exact base/render alias fits
  mutations.receive(tab('a'), structuredClone(snapshot), 0);
  assert.ok(view.evicted.has('a'));
  assert.equal(view.snapshots.a, undefined);
  assert.equal(view.confirmedSnapshots.a, undefined);
});
test('budget includes distinct raw gate owner; eviction releases gate, exact alias fits', async () => {
  const snapshot = snap([issue(0)]);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  const gate = new RootRefreshGate<TreeSnapshot>(() => 100);
  let view!: MutationView;
  const mutations = new Mutations(
    {} as CanopyAPI,
    (v) => {
      view = v;
      for (const id of v.evicted) gate.releaseSnapshot(id);
    },
    () => {},
    undefined,
    bytes + 5,
    (t) => [gate.snapshot(t.id)],
  );
  const load = gate.load('a', false, true, async () => snapshot);
  assert.ok('promise' in load);
  mutations.receive(tab('a'), await load.promise, 0);
  assert.ok(view.snapshots.a);
  const separate = gate.load('a', true, false, async () =>
    structuredClone(snapshot),
  );
  assert.ok('promise' in separate);
  await separate.promise;
  mutations.protectSnapshots([]);
  assert.ok(view.evicted.has('a'));
  assert.equal(gate.snapshot('a'), undefined);
  assert.equal(view.snapshots.a, undefined);
});

test('desktop audit saved-view selector matches actual main #83 accessible name', () => {
  const props = {
    workspace: {
      tabs: [tab('a')],
      activeTabId: 'a',
      savedViews: [
        {
          id: 'large-roots',
          name: 'Large roots',
          roots: [tab('a')],
          connectionIds: [],
          filters: {},
          sort: {},
        },
      ],
    },
    connections: [{ id: 'c', provider: 'jira', name: 'Fake' }],
    session: emptySidebarSession(),
    onOrganize: () => {},
    onOpen: () => {},
    onSelectTab: () => {},
    onSelectView: () => {},
    onCreateView: () => {},
    onOpenPicker: () => {},
  } as unknown as React.ComponentProps<typeof SidebarWork>;
  const markup = renderToStaticMarkup(React.createElement(SidebarWork, props));
  const driver = readFileSync(
    new URL('../tools/perf-desktop.mjs', import.meta.url),
    'utf8',
  );
  const name = driver.match(/name: '(.*Large roots)'/)?.[1];
  assert.ok(name);
  assert.ok(
    markup.includes(`aria-label="${name}"`),
    'Driver selects the actual accessible button',
  );
});

test('App user cancellation invalidates a queued refresh while retaining active partial result', async () => {
  const a = tab('a'),
    b = tab('b');
  const { context, calls, refresh } = refreshContext([a, b]);
  let finish!: (snapshot: TreeSnapshot) => void;
  let aborts = 0;
  context.window.canopy.cancelTree = async () => {
    aborts++;
  };
  context.window.canopy.tree = (_c, _r, id) => {
    calls.push(id);
    if (calls.length > 1) return Promise.resolve(snap([issue(0)]));
    return new Promise<TreeSnapshot>((resolve) => {
      finish = resolve;
    });
  };
  const first = refresh(a),
    queued = refresh(b, false, true);
  callback('cancelTree', context)(a);
  finish(snap([issue(0), issue(1)], true));
  await Promise.all([first, queued]);
  assert.equal(aborts, 1);
  assert.equal(calls.length, 1);
  assert.ok(context.cancelledTrees.current.has(rootKey(a)));
  assert.equal(context.mutations.confirmedSnapshot(a.id)?.issues.length, 2);
  assert.ok(context.mutations.confirmedSnapshot(a.id)?.incomplete);
});
test('App virtual-to-real cleanup transfers known partial snapshot before releasing virtual owner', () => {
  const virtual = tab('saved-view:root'),
    real = tab('real');
  const f = forgetContext([virtual], [virtual]);
  f.context.tabsRef.current = [real];
  let effect!: ts.ArrowFunction;
  function walk(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0].getText(ast).includes('previousVirtualTabs.current')
    )
      effect = n.arguments[0] as ts.ArrowFunction;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  execute(effect, {
    ...f.context,
    allRefreshTabs: [real],
    previousVirtualTabs: ref(new Map([[virtual.id, virtual]])),
    forgetTabs: f.forget,
  })();
  assert.deepEqual(f.aborted, []);
  assert.equal(f.view().confirmedSnapshots[real.id]?.issues.length, 2);
  assert.ok(f.view().confirmedSnapshots[real.id]?.incomplete);
  assert.equal(f.view().confirmedSnapshots[virtual.id], undefined);
  assert.ok(f.context.cancelledTrees.current.has(rootKey(real)));
});

test('App releases an undelivered gate response held behind a write and retains confirmed offline tree', async () => {
  const a = tab('a');
  const { context, refresh } = refreshContext([a]);
  context.mutations.receive(a, snap([issue(0), issue(1)]), 0);
  let finish!: (snapshot: TreeSnapshot) => void;
  context.window.canopy.tree = () =>
    new Promise<TreeSnapshot>((resolve) => {
      finish = resolve;
    });
  const pending = refresh(a);
  context.refreshBlocked.current = () => true;
  finish(snap([issue(0)], true));
  await pending;
  const roots = (
    context.rootRefreshes.current as unknown as {
      roots: Map<string, { snapshot?: TreeSnapshot }>;
    }
  ).roots;
  assert.equal(roots.get(rootKey(a))?.snapshot, undefined);
  assert.equal(context.mutations.confirmedSnapshot(a.id)?.issues.length, 2);
  assert.ok(context.deferredRefreshes.current.has(a.id));
});

test('App gate caches the normalized partial for a later consumer even after the previous owner leaves', async () => {
  const virtual = tab('saved-view:root');
  const { context, refresh, calls } = refreshContext([virtual]);
  context.window.canopy.tree = async (_c, _r, id) => {
    calls.push(id);
    return calls.length === 1
      ? snap([issue(0), issue(1, 'Remote')])
      : snap([issue(0)], true);
  };
  await refresh(virtual);
  await refresh(virtual, true, true);
  const roots = (
    context.rootRefreshes.current as unknown as {
      roots: Map<string, { snapshot?: TreeSnapshot }>;
    }
  ).roots;
  assert.equal(roots.get(rootKey(virtual))?.snapshot?.issues.length, 2);
  context.mutations.forget(virtual.id);
  const load = context.rootRefreshes.current.load(
    rootKey(virtual),
    false,
    true,
    () => {
      throw new Error('Unexpected provider read');
    },
  );
  assert.ok('promise' in load);
  const retained = await load.promise;
  assert.ok(retained.incomplete);
  assert.equal(retained.issues.length, 2);
  assert.equal(
    unseenChanges(
      markRootSeen(snap([issue(0), issue(1)])).issues['T-1'],
      retained.issues[1],
    ).fields.length,
    1,
  );
  assert.equal(calls.length, 2);
});

test('main renderer navigation/destruction aborts reads when unload cancellation IPC cannot arrive', () => {
  const mainSource = readFileSync(
    new URL('../src/main/app.ts', import.meta.url),
    'utf8',
  );
  const mainAst = ts.createSourceFile(
    'app.ts',
    mainSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const trees = new Map([
    ['one', new AbortController()],
    ['two', new AbortController()],
  ]);
  const controllers = [...trees.values()];
  const search = new AbortController();
  const searches = new Map([['search', search]]);
  let updateCancellations = 0;
  const updates = {
    cancel: () => {
      updateCancellations++;
    },
  };
  const listener = (event: string) => {
    let found!: ts.Expression;
    function walk(n: ts.Node) {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(mainAst) === 'created.webContents.on' &&
        ts.isStringLiteral(n.arguments[0]) &&
        n.arguments[0].text === event
      )
        found = n.arguments[1];
      ts.forEachChild(n, walk);
    }
    walk(mainAst);
    assert.ok(found, event);
    return vm.runInNewContext(
      ts.transpileModule(`(${found.getText(mainAst)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      { trees, searches, updates, clearRelationshipRequests: () => {} },
    );
  };
  const navigation = listener('did-start-navigation');
  navigation({ isMainFrame: false, isSameDocument: false });
  navigation({ isMainFrame: true, isSameDocument: true });
  assert.ok(controllers.every((c) => !c.signal.aborted));
  navigation({ isMainFrame: true, isSameDocument: false });
  assert.ok(controllers.every((c) => c.signal.aborted));
  assert.equal(trees.size, 0);
  const next = new AbortController();
  trees.set('new-renderer', next);
  assert.equal(updateCancellations, 0);
  listener('destroyed')();
  assert.equal(updateCancellations, 1);
  assert.equal(next.signal.aborted, true);
  assert.equal(search.signal.aborted, true);
  assert.equal(trees.size, 0);
  assert.equal(searches.size, 0);
});
