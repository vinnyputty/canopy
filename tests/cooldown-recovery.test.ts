import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Mutations, type MutationView } from '../src/renderer/mutations';
import { ControlledDemoProvider } from './fixtures/controlled';
import type { CanopyAPI, TabState, TreeSnapshot } from '../src/shared/types';

// Read pinned Playwright's actual injected clock export; this loads no browser,
// Playwright runtime or Electron. Use its real Date and interval implementation.
const require = createRequire(import.meta.url);
const playwright = createRequire(require.resolve('@playwright/test'));
const core = createRequire(playwright.resolve('playwright'));
const bundle = readFileSync(
  join(
    dirname(core.resolve('playwright-core/package.json')),
    'lib/coreBundle.js',
  ),
  'utf8',
);
const encoded = bundle
  .split('\n')
  .find((line) => line.trim().startsWith('source = '));
assert.ok(encoded);
const clockSource = vm.runInNewContext(`${encoded}\nsource;`) as string;
const app = ts.createSourceFile(
  'App.tsx',
  readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function expression(name: string) {
  let found: ts.Expression | undefined;
  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.name.getText(app) === name)
      found = n.initializer;
    ts.forEachChild(n, visit);
  }
  visit(app);
  assert.ok(found, name);
  return found;
}
const ref = <T>(current: T) => ({ current });
const rootKey = (tab: TabState) =>
  JSON.stringify([tab.connectionId, tab.rootKey.toLowerCase()]);
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const epoch = 1_700_000_000_000;
  const a: TabState = {
    id: 'a',
    connectionId: 'demo',
    rootKey: 'CAN-200',
    expanded: [],
    hideDone: true,
    scrollTop: 0,
  };
  const b: TabState = { ...a, id: 'b', rootKey: 'CAN-100' };
  const provider = new ControlledDemoProvider();
  let view!: MutationView,
    errors: Record<string, string> = {},
    syncNow = epoch;
  let blocked = false;
  const snapshotsRef = ref<Record<string, TreeSnapshot>>({});
  const mutations = new Mutations(
    {
      update: (
        _id: string,
        key: string,
        patch: Parameters<ControlledDemoProvider['update']>[1],
      ) => provider.update(key, patch),
    } as CanopyAPI,
    (next) => {
      view = next;
      snapshotsRef.current = next.snapshots;
    },
    () => {},
  );
  const flights: Promise<void>[] = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
    module: { exports: {} },
    exports: {},
    mutations,
    snapshotsRef,
    tabsRef: ref([a, b]),
    rootRefreshKey: rootKey,
    refreshRootKey: rootKey,
    activeIdRef: ref(a.id),
    activeViewSourceIdsRef: ref<string[]>([]),
    navigator: { onLine: true },
    demoMode: false,
    refreshBlocked: ref(() => blocked || mutations.pending(a.connectionId)),
    forcedRefreshes: ref(new Set<string>()),
    deferredRefreshes: ref(new Set<string>()),
    cancelledTrees: ref(new Set<string>()),
    manualRelationshipRefreshes: ref(new Set<string>()),
    invalidateRelationships: () => {},
    treeMounted: ref(true),
    treeRequests: ref(new Map()),
    refreshSequences: ref({}),
    runningExplicitRefreshes: ref(new Map()),
    crypto: { randomUUID: () => String(provider.calls.length) },
    cooldowns: ref<Record<string, number>>({}),
    setCooldownTimes: () => {},
    setSyncNow: (now: number) => {
      syncNow = now;
    },
    setRefreshing: () => {},
    setLoading: () => {},
    connectionsRef: ref([]),
    pickers: {},
    workspaceRef: ref({ seenRoots: {} }),
    setWorkspace: () => {},
    seenRootKey: () => '',
    boundRoots: (v: unknown) => v,
    seedOrExtend: () => {},
    setConnectionErrors: () => {},
    setErrors: (update: (prior: typeof errors) => typeof errors) => {
      errors = update(errors);
    },
  });
  vm.runInContext(clockSource, context);
  vm.runInContext(
    `clock = module.exports.install()(globalThis, {toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']}).clock; clock.install(${epoch});`,
    context,
  );
  vm.runInContext(
    ts.transpileModule(
      readFileSync(
        new URL('../src/renderer/refresh.ts', import.meta.url),
        'utf8',
      ),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    context,
  );
  vm.runInContext(
    'rootRefreshes = {current: new exports.RootRefreshGate()}; refreshSchedule = {current: new exports.RefreshSchedule()};',
    context,
  );
  const window = {
    canopy: {
      tree: async (_id: string, key: string) => provider.tree(key),
      syncStatus: async () => ({ retryAt: provider.retryAt }),
    },
    setInterval: context.setInterval,
  };
  context.window = window;
  context.refreshSchedule.current.sync([a.id, b.id], a.id, epoch);
  const refresh = vm.runInContext(
    ts.transpileModule(
      `(${(expression('refreshTab') as ts.CallExpression).arguments[0].getText(app)})`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  ) as (
    tab: TabState,
    quiet?: boolean,
    explicit?: boolean,
    userRequested?: boolean,
    retry?: boolean,
  ) => Promise<void>;
  context.refreshTab = (...args: Parameters<typeof refresh>) => {
    const flight = refresh(...args);
    flights.push(flight);
    return flight;
  };
  const tick = vm.runInContext(
    ts.transpileModule(`(${expression('tick').getText(app)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const timer = context.setInterval(tick, 1000);
  const run = async (ms: number) => {
    await context.clock.runFor(ms);
    await drain();
  };
  const settle = async () => {
    await drain();
    await Promise.all(flights.splice(0));
    await drain();
  };
  const calls = (key = a.rootKey) =>
    provider.calls.filter((c) => c.operation === 'tree' && c.key === key)
      .length;
  return {
    a,
    b,
    provider,
    context,
    refresh,
    run,
    settle,
    calls,
    view: () => view,
    errors: () => errors,
    syncNow: () => syncNow,
    now: () => vm.runInContext('Date.now()', context) as number,
    setBlocked: (value: boolean) => {
      blocked = value;
    },
    cleanup: () => {
      context.clearInterval(timer);
      context.clock.uninstall();
    },
  };
}

async function rateLimit(f: ReturnType<typeof fixture>, partial = false) {
  await f.refresh(f.b, false, true);
  await f.refresh(f.a, false, true);
  const original = f.view().snapshots.a;
  f.provider.retryAt = f.now() + 10_000;
  if (partial) {
    f.context.window.canopy.tree = async () => ({
      ...original,
      incomplete: { reason: 'Rate limited', calls: 1 },
    });
    await f.refresh(f.a, true, true);
    f.context.window.canopy.tree = async (_id: string, key: string) =>
      f.provider.tree(key);
  } else {
    f.provider.hold('limited', 'tree', f.a.rootKey);
    const failed = f.refresh(f.a, true, true);
    await drain();
    assert.equal(f.provider.started('limited'), true);
    f.provider.release('limited', 'Jira rate limit reached.');
    await failed;
  }
  await f.settle();
  assert.equal(f.view().snapshots.a.issues.length, original.issues.length);
  assert.equal(f.context.cooldowns.current.demo, f.provider.retryAt);
  return original;
}

for (const partial of [false, true]) {
  test(`actual App and pinned clock recover a recent ${partial ? 'partial' : 'failed'} tree after its ten-second cooldown`, async () => {
    const f = fixture();
    try {
      await rateLimit(f, partial);
      const count = f.calls(),
        background = f.calls(f.b.rootKey);
      await f.refresh(f.a, true, true); // Manual remains blocked before retryAt.
      await f.run(5000);
      assert.equal(f.calls(), count);
      f.provider.hold('recovery', 'tree', f.a.rootKey);
      f.provider.retryAt = null;
      await f.run(6000);

      assert.equal(f.provider.started('recovery'), true);
      assert.equal(f.calls(), count + 1);
      assert.equal(f.calls(f.b.rootKey), background);
      f.provider.release('recovery');
      await f.settle();
      assert.equal(f.view().snapshots.a.incomplete, undefined);
      assert.equal(f.errors().a, undefined);
      const recoveredCalls = f.calls();
      await f.refresh(f.a, true);
      await f.run(29_000);
      assert.equal(f.calls(), recoveredCalls); // Successful recovery restores the minimum.
      await f.run(1000);
      await f.settle();
      assert.equal(f.calls(), recoveredCalls + 1);
    } finally {
      f.cleanup();
    }
  });
}

test('actual App short cooldown recovery retains draft and pending guards until unblocked', async () => {
  const f = fixture();
  try {
    const old = await rateLimit(f);
    const count = f.calls();
    f.setBlocked(true);
    f.provider.retryAt = null;
    await f.run(11_000);
    assert.equal(f.calls(), count);
    assert.equal(f.view().snapshots.a, old);
    assert.ok(f.context.deferredRefreshes.current.has(f.a.id));
    f.setBlocked(false);
    await f.run(1000);
    await f.settle();
    assert.equal(f.calls(), count + 1);
  } finally {
    f.cleanup();
  }
});

test('actual cooldown recovery waits for a real optimistic write and keeps its pending value', async () => {
  const f = fixture();
  try {
    await rateLimit(f);
    const count = f.calls();
    f.provider.hold('pending', 'update', f.a.rootKey);
    const write = f.context.mutations.update('demo', f.a.rootKey, {
      summary: 'Pending cooldown edit',
    });
    await drain();
    assert.equal(f.provider.started('pending'), true);
    assert.equal(f.context.mutations.pending('demo'), true);
    f.provider.retryAt = null;
    await f.run(11_000);
    assert.equal(f.calls(), count);
    assert.equal(
      f.view().snapshots.a.issues[0].summary,
      'Pending cooldown edit',
    );
    f.provider.release('pending');
    assert.equal(await write, true);
    await f.run(1000);
    await f.settle();
    assert.equal(f.calls(), count + 1);
    assert.equal(
      f.view().snapshots.a.issues[0].summary,
      'Pending cooldown edit',
    );
    assert.equal(f.context.mutations.pending('demo'), false);
  } finally {
    f.cleanup();
  }
});

test('actual cooldown keeps offline reads and coalesces focus with an in-flight recovery', async () => {
  const f = fixture();
  try {
    const original = await rateLimit(f);
    const count = f.calls();
    f.context.navigator.onLine = false;
    await f.run(5000);
    assert.equal(f.calls(), count);
    assert.equal(f.view().snapshots.a, original);
    f.context.navigator.onLine = true;
    await f.refresh(f.a, true);
    assert.equal(f.calls(), count);
    f.provider.retryAt = null;
    f.provider.hold('recovery', 'tree', f.a.rootKey);
    await f.run(6000);
    assert.equal(f.provider.started('recovery'), true);
    await f.refresh(f.a, true);
    await f.run(1000);
    assert.equal(f.calls(), count + 1);
    f.provider.release('recovery');
    await f.settle();
    assert.equal(f.errors().a, undefined);
  } finally {
    f.cleanup();
  }
});

test('actual App expired cooldown cannot restart cancellation; user Retry can', async () => {
  const f = fixture();
  try {
    await rateLimit(f);
    const count = f.calls();
    f.context.cancelledTrees.current.add(rootKey(f.a));
    f.provider.retryAt = null;
    await f.run(11_000);
    assert.equal(f.calls(), count);
    await f.refresh(f.a, true, true, true, true);
    await f.settle();
    assert.equal(f.calls(), count + 1);
  } finally {
    f.cleanup();
  }
});

test('actual gate keeps the captured pinned fake Date.now in the same time domain as App ticks', async () => {
  const f = fixture();
  try {
    await f.refresh(f.a, false, true);
    await f.settle();
    const count = f.calls();
    await f.run(29_000);
    assert.equal(f.calls(), count);
    assert.equal(f.now(), 1_700_000_029_000);
    await f.run(1000);
    await f.settle();
    assert.equal(f.calls(), count + 1);
  } finally {
    f.cleanup();
  }
});
