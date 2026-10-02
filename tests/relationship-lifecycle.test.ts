import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { issueWorkBrief } from '../src/renderer/copy-issue';
import {
  relationshipBlockers,
  relationshipChangedKeys,
} from '../src/renderer/relationships';
import { DemoProvider } from '../src/main/demo-provider';
import { RootRefreshGate, RefreshSchedule } from '../src/renderer/refresh';
import { Mutations } from '../src/renderer/mutations';
import {
  issueRelationships,
  relationshipFailure,
  relationshipKinds,
} from '../src/shared/relationships';
import type {
  Issue,
  IssueRelationships,
  TreeSnapshot,
  TabState,
} from '../src/shared/types';

const issue = (key: string, parentKey?: string): Issue => ({
  id: key,
  key,
  parentKey,
  summary: key,
  type: 'Task',
  priority: null,
  assignee: null,
  links: [],
  status: { id: 'open', name: 'Open', category: 'new' },
});
const graph = (key: string): IssueRelationships => ({
  key,
  groups: relationshipKinds.map((kind) => ({
    kind,
    state: 'visible',
    items: [],
  })),
});
const parsed = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
const nodes = (source: ts.SourceFile, match: (node: ts.Node) => boolean) => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};
const js = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

function mainRequests() {
  const source = parsed('../src/main/app.ts');
  const names = new Set([
    'searches',
    'relationshipRequests',
    'cancelRelationships',
    'clearRelationshipRequests',
  ]);
  const declarations = nodes(
    source,
    (n) => ts.isVariableDeclaration(n) && names.has(n.name.getText(source)),
  )
    .map((n) => `const ${n.getText(source)};`)
    .join('\n');
  const handler = nodes(
    source,
    (n) =>
      ts.isPropertyAssignment(n) && n.name.getText(source) === 'relationships',
  )[0] as ts.PropertyAssignment;
  const events = nodes(
    source,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(source) === 'created.webContents.on' &&
      /^(?:'destroyed'|'did-start-navigation'|'render-process-gone')$/.test(
        n.arguments[0].getText(source),
      ),
  )
    .map((n) => `${n.getText(source)};`)
    .join('\n');
  const pending: { signal: AbortSignal; release: () => void }[] = [];
  const webContents = new EventEmitter();
  let updateCancellations = 0;
  const context = {
    AbortController,
    relationshipKinds,
    relationshipFailure,
    issueRelationships,
    updates: { cancel: () => updateCancellations++ },
    text: (v: string) => v,
    normalized: (_id: string, key: string) => key,
    provider: () => ({
      relationships: (key: string, signal: AbortSignal) =>
        new Promise<IssueRelationships>((resolve) =>
          pending.push({ signal, release: () => resolve(graph(key)) }),
        ),
    }),
    created: { webContents },
    api: {} as {
      request: (
        id: string,
        key: string,
        request: string,
      ) => Promise<IssueRelationships>;
      count: () => number;
    },
  };
  runInNewContext(
    js(
      `${declarations}\n${events}\nglobalThis.api = { request: ${handler.initializer.getText(source)}, count: () => relationshipRequests.size };`,
    ),
    context,
  );
  return {
    ...context.api,
    pending,
    webContents,
    updateCancellations: () => updateCancellations,
  };
}

test('document reload releases the request cap and old finally cannot erase replacement ownership', async () => {
  const api = mainRequests();
  const reads = Array.from({ length: 16 }, (_, i) =>
    api.request('account', 'A-1', `request-${i}`),
  );
  try {
    api.webContents.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    });
    api.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });
    assert.equal(api.count(), 16);
    assert.ok(api.pending.every((p) => !p.signal.aborted));
    api.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.ok(
      api.pending.every((p) => p.signal.aborted),
      'reload aborts the outgoing document',
    );
    assert.equal(api.count(), 0);
    const replacement = api.request('account', 'A-1', 'request-0');
    api.pending[0].release();
    assert.equal((await reads[0]).groups[0].problem, 'cancelled');
    assert.equal(
      api.count(),
      1,
      'old finalizer preserves the new document request',
    );
    api.pending[16].release();
    assert.equal((await replacement).groups[0].state, 'visible');
  } finally {
    api.pending.forEach((p) => p.release());
    await Promise.all(reads);
  }
});

for (const event of ['destroyed', 'render-process-gone']) {
  test(`${event} aborts and clears document relationship reads`, async () => {
    const api = mainRequests();
    const read = api.request('account', 'A-1', 'request');
    api.webContents.emit(event);
    const aborted = api.pending[0].signal.aborted;
    const remaining = api.count();
    api.pending[0].release();
    await read;
    assert.equal(aborted, true);
    assert.equal(remaining, 0);
    assert.equal(api.updateCancellations(), event === 'destroyed' ? 1 : 0);
  });
}

test('inspected immediate parent seeds known ancestors without inheriting the old source parent', () => {
  const relationships = graph('A-1');
  relationships.groups.find((g) => g.kind === 'parent')!.items = [
    {
      key: 'NEW-1',
      summary: 'New parent',
      relationship: 'child of',
      direction: 'inward',
      access: 'available',
    },
  ];
  const knownIssues = [
    issue('A-1', 'OLD-1'),
    issue('OLD-1'),
    issue('NEW-1', 'ROOT-1'),
    issue('ROOT-1'),
  ];
  const preview = {
    issue: { ...issue('A-1'), unavailableFields: ['parent'] },
    description: '',
    comments: [],
    totalComments: 0,
  };
  const brief = () =>
    issueWorkBrief({ preview, provider: 'jira', knownIssues, relationships });
  assert.match(brief(), /- Parent path: ROOT-1 → NEW-1/);
  assert.doesNotMatch(brief(), /OLD-1/);
  relationships.groups.find((g) => g.kind === 'parent')!.state = 'unavailable';
  assert.match(brief(), /- Parent path: Unknown/);
  relationships.groups.find((g) => g.kind === 'parent')!.state = 'visible';
  relationships.groups.find((g) => g.kind === 'parent')!.items = [];
  assert.match(brief(), /- Parent path: No visible parent returned/);
  assert.doesNotMatch(brief(), /OLD-1|NEW-1/);
});

// Execute the actual App inspection, refresh callback, and dependency effects.
// This harness models React state/effect delivery without DOM or Electron.
function rendererRequests(realRefresh = false) {
  const source = parsed('../src/renderer/App.tsx');
  const names = new Set([
    'relationshipGraphs',
    'relationshipLoading',
    'relationshipRequests',
    'relationshipRequestChanges',
    'relationshipGraphsRef',
    'relationshipConfirmedSnapshots',
    'updateRelationshipGraphs',
    'manualRelationshipRefreshes',
    'relationshipGeneration',
    'relationshipIdentity',
    'inspectRelationships',
    'invalidateRelationships',
    'refreshTab',
  ]);
  const declarations = nodes(
    source,
    (n) =>
      ts.isVariableDeclaration(n) &&
      [...names].some(
        (name) =>
          n.name.getText(source) === name ||
          n.name.getText(source).startsWith(`[${name},`),
      ),
  )
    .map((n) => `const ${n.getText(source)};`)
    .join('\n');
  const effects = nodes(
    source,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(source) === 'useEffect' &&
      (n.getText(source).includes('setRelationshipGraphs({})') ||
        n.getText(source).includes('relationshipGeneration.current++')),
  )
    .map((n) => `${n.getText(source)};`)
    .join('\n');
  const tabs = [
    { id: 'a', connectionId: 'work', rootKey: 'A-1' },
    { id: 'b', connectionId: 'work', rootKey: 'B-1' },
    { id: 'other', connectionId: 'other', rootKey: 'A-1' },
  ] as TabState[];
  const snapshots = Object.fromEntries(
    tabs.map((tab) => [
      tab.id,
      {
        rootKey: tab.rootKey,
        issues: [issue(tab.rootKey)],
        fetchedAt: 1,
        warnings: [],
      },
    ]),
  ) as Record<string, TreeSnapshot>;
  const pending: {
    key: string;
    resolve: (g: IssueRelationships) => void;
    reject: (e: Error) => void;
  }[] = [];
  const cancelled: string[] = [];
  const states: any[] = [];
  let stateIndex = 0;
  let effectIndex = 0;
  const mounted: { deps: unknown[]; cleanup?: () => void }[] = [];
  const setter = () => {};
  let now = 1_000_000;
  let tick = () => {};
  class ClockDate extends Date {
    static now() {
      return now;
    }
  }
  const context: any = {
    relationshipChangedKeys,
    relationshipKinds,
    crypto: { randomUUID: () => `request-${pending.length}` },
    useState: (value: unknown) => {
      const index = stateIndex++;
      states[index] = value;
      return [
        value,
        (next: any) => {
          states[index] =
            typeof next === 'function' ? next(states[index]) : next;
        },
      ];
    },
    useRef: (current: unknown) => ({ current }),
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
      const index = effectIndex++;
      const before = mounted[index];
      if (!before || deps.some((value, i) => value !== before.deps[i])) {
        before?.cleanup?.();
        mounted[index] = { deps, cleanup: fn() || undefined };
      }
    },
    snapshots,
    snapshotsRef: { current: snapshots },
    activeTab: tabs[0],
    previewRoute: undefined,
    previewKey: undefined,
    tabsRef: { current: tabs },
    workspaceRef: { current: { tabs } },
    demoMode: false,
    navigator: { onLine: true },
    forcedRefreshes: { current: new Set() },
    deferredRefreshes: { current: new Set() },
    runningExplicitRefreshes: { current: new Map() },
    refreshBlocked: { current: () => false },
    cooldowns: { current: {} },
    refreshSchedule: { current: { begin: () => true, finish: setter } },
    refreshSequences: { current: {} },
    refreshRootKey: (tab: TabState) =>
      JSON.stringify([tab.connectionId, tab.rootKey]),
    rootRefreshes: {
      current: {
        load: (
          _root: string,
          _explicit: boolean,
          _initial: boolean,
          read: () => Promise<TreeSnapshot>,
        ) => ({ promise: read(), started: true, generation: 1 }),
        isCurrent: () => true,
      },
    },
    connectionsRef: {
      current: [
        { id: 'work', provider: 'github' },
        { id: 'other', provider: 'github' },
      ],
    },
    setSnapshots: setter,
    setConfirmedSnapshots: setter,
    setSaving: setter,
    setUndoState: setter,
    setRefreshing: setter,
    setLoading: setter,
    setWorkspace: setter,
    setConnectionErrors: setter,
    setErrors: setter,
    mutations: {
      beginRefresh: () => 1,
      endRefresh: setter,
      confirmedSnapshot: (id: string) => context.snapshotsRef.current[id],
      receive: (tab: TabState, snapshot: TreeSnapshot) => {
        context.snapshots = { ...context.snapshots, [tab.id]: snapshot };
        context.snapshotsRef.current = context.snapshots;
        context.api.publish({
          snapshots: context.snapshots,
          confirmedSnapshots: context.snapshots,
          saving: new Set(),
          undoBusy: false,
        });
      },
    },
    window: {
      canopy: {
        relationships: (_id: string, key: string) =>
          new Promise<IssueRelationships>((resolve, reject) =>
            pending.push({ key, resolve, reject }),
          ),
        cancelRelationships: (id: string, request: string) => {
          cancelled.push(`${id}:${request}`);
          return Promise.resolve();
        },
        tree: async (_id: string, key: string) => ({
          rootKey: key,
          issues: [issue(key)],
          fetchedAt: 2,
          warnings: [],
        }),
      },
    },
  };
  const publish = nodes(
    source,
    (n) =>
      ts.isArrowFunction(n) &&
      ts.isBlock(n.body) &&
      n.body.getText(source).includes('setSnapshots(view.snapshots)'),
  )[0];
  assert.ok(publish, 'production mutation snapshot callback');
  runInNewContext(
    js(
      `${declarations}\nglobalThis.api = { inspect: inspectRelationships, refresh: refreshTab, publish: ${publish.getText(source)}, intent: () => [...manualRelationshipRefreshes.current] };`,
    ),
    context,
  );
  const renderEffects = () => {
    effectIndex = 0;
    runInNewContext(js(effects), context);
  };
  renderEffects();
  context.api.publish({
    snapshots,
    confirmedSnapshots: snapshots,
    saving: new Set(),
    undoBusy: false,
  });
  if (realRefresh) {
    context.Date = ClockDate;
    context.setSnapshots = (value: Record<string, TreeSnapshot>) => {
      context.snapshots = value;
      context.snapshotsRef.current = value;
    };
    context.window.canopy.update = async (_connection: string, key: string) =>
      issue(key);
    context.mutations = new Mutations(
      context.window.canopy,
      (view) => context.api.publish(view),
      setter,
    );
    context.rootRefreshes.current = new RootRefreshGate(() => now);
    context.refreshSchedule.current = new RefreshSchedule();
    context.refreshSchedule.current.sync(
      tabs.map((tab) => tab.id),
      'a',
      now,
    );
    context.editorRef = { current: null };
    const gate = nodes(
      source,
      (n) =>
        ts.isBinaryExpression(n) &&
        n.left.getText(source) === 'refreshBlocked.current',
    )[0];
    assert.ok(gate, 'actual editor and pending-write gate');
    runInNewContext(js(`${gate.getText(source)};`), context);
    for (const tab of tabs)
      context.mutations.receive(tab, snapshots[tab.id], 0);
    Object.assign(context, {
      ready: true,
      activeIdRef: { current: 'a' },
      activeViewSourceIdsRef: { current: [] },
      workflowReturn: { current: null },
      finishWorkflowReturn: () => false,
      setSyncNow: setter,
      setCooldownTimes: setter,
      setForeground: setter,
      setOnline: setter,
      document: {
        visibilityState: 'visible',
        hasFocus: () => true,
        addEventListener: setter,
        removeEventListener: setter,
      },
    });
    Object.assign(context.window, {
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
      clearInterval: setter,
      addEventListener: setter,
      removeEventListener: setter,
    });
    const scheduler = nodes(
      source,
      (n) =>
        ts.isCallExpression(n) &&
        n.expression.getText(source) === 'useEffect' &&
        n.getText(source).includes('refreshSchedule.current.due(Date.now())'),
    )[0];
    assert.ok(scheduler, 'actual scheduled/deferred delivery');
    runInNewContext(js(`${scheduler.getText(source)};`), context);
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    ...context.api,
    pending,
    cancelled,
    tabs,
    context,
    settle,
    advance: async (milliseconds: number) => {
      now += milliseconds;
      tick();
      await settle();
    },
    editor: (connectionId?: string) => {
      context.editorRef.current = connectionId ? { connectionId } : null;
    },
    setTree: (
      read: (connection: string, key: string) => Promise<TreeSnapshot>,
    ) => {
      context.window.canopy.tree = read;
    },
    graphs: () => states[0] as Record<string, IssueRelationships>,
    loading: () => states[1],
    refresh: async (tab: TabState, userRequested = true, explicit = true) => {
      await context.api.refresh(tab, true, explicit, userRequested);
      renderEffects();
    },
    seed: (tab: TabState, issues: Issue[]) => {
      context.snapshotsRef.current[tab.id] = {
        rootKey: tab.rootKey,
        issues,
        fetchedAt: 1,
        warnings: [],
      };
      context.api.publish({
        snapshots: context.snapshotsRef.current,
        confirmedSnapshots: context.snapshotsRef.current,
        saving: new Set(),
        undoBusy: false,
      });
    },
    confirmed: (tab: TabState, issues: Issue[]) =>
      context.mutations.receive(tab, treeSnapshot(tab.rootKey, issues)),
    blocked: (value: boolean) => {
      context.refreshBlocked.current = () => value;
    },
    next: (snapshot: TreeSnapshot) => {
      context.window.canopy.tree = async () => snapshot;
    },
    optimistic: () => {
      context.snapshots = { ...context.snapshots };
      context.api.publish({
        snapshots: context.snapshots,
        confirmedSnapshots: context.snapshotsRef.current,
        saving: new Set(),
        undoBusy: false,
      });
      renderEffects();
    },
  };
}

for (const change of [
  'optimistic edit',
  'same-account unrelated root',
  'other account',
]) {
  test(`${change} preserves inspected and held graphs`, async () => {
    const api = rendererRequests();
    const first = api.inspect('work', 'A-1');
    api.pending[0].resolve(graph('A-1'));
    await first;
    const held = api.inspect('work', 'A-1');
    if (change === 'optimistic edit') api.optimistic();
    else await api.refresh(api.tabs[change === 'other account' ? 2 : 1]);
    assert.equal(api.cancelled.length, 0);
    assert.equal(api.graphs()['["work","A-1"]']?.key, 'A-1');
    api.pending[1].resolve(graph('A-1'));
    await held;
    assert.equal(api.graphs()['["work","A-1"]']?.key, 'A-1');
  });
}

test('own confirmed refresh invalidates old results and excludes stale completion/error/finally', async () => {
  const api = rendererRequests();
  const inspected = api.inspect('work', 'A-1');
  const blocked = graph('A-1');
  blocked.groups[0].items = [
    {
      key: 'B-2',
      summary: 'Known blocker',
      relationship: 'blocked by',
      direction: 'inward',
      access: 'available',
      statusCategory: 'new',
    },
  ];
  api.pending[0].resolve(blocked);
  await inspected;
  assert.equal(
    relationshipBlockers(issue('A-1'), api.graphs()['["work","A-1"]']).blocker,
    'blocked',
  );
  const old = api.inspect('work', 'A-1');
  await api.refresh(api.tabs[0]);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.deepEqual(api.cancelled, ['work:request-1']);
  const fresh = api.inspect('work', 'A-1');
  api.pending[1].reject(new Error('late old error'));
  await old;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.equal(api.loading()['["work","A-1"]'], true);
  const unknown = graph('A-1');
  unknown.groups[0].items = [
    {
      key: 'B-2',
      summary: 'Unknown blocker',
      relationship: 'blocked by',
      direction: 'inward',
      access: 'available',
    },
  ];
  api.pending[2].resolve(unknown);
  await fresh;
  assert.equal(
    relationshipBlockers(
      issue('A-1'),
      api.graphs()['["work","A-1"]'],
      new Map([
        [
          'B-2',
          {
            ...issue('B-2'),
            status: { id: 'done', name: 'Done', category: 'done' },
          },
        ],
      ]),
    ).blocker,
    'unknown',
  );
  const stale = api.inspect('work', 'A-1');
  await api.refresh(api.tabs[0]);
  api.pending[3].resolve(graph('A-1'));
  await stale;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
});

test('deferred manual refresh retains its intent while automatic recovery alone preserves inspections', async () => {
  const api = rendererRequests();
  const inspected = api.inspect('work', 'A-1');
  api.pending[0].resolve(blockerGraph('A-1'));
  await inspected;
  const held = api.inspect('work', 'A-1');
  api.blocked(true);
  await api.refresh(api.tabs[0], true);
  assert.equal(api.cancelled.length, 0);
  assert.equal(api.graphs()['["work","A-1"]']?.key, 'A-1');
  api.blocked(false);
  await api.refresh(api.tabs[0], false, false);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.deepEqual(api.cancelled, ['work:request-1']);
  api.pending[1].resolve(blockerGraph('A-1'));
  await held;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
});

test('confirmed edit publication invalidates affected inspection before an unchanged poll can hide the change', async () => {
  const api = rendererRequests();
  api.seed(api.tabs[0], [issue('A-1'), issue('B-2', 'A-1')]);
  const inspected = api.inspect('work', 'A-1');
  api.pending[0].resolve(blockerGraph('A-1'));
  await inspected;
  const held = api.inspect('work', 'A-1');
  api.optimistic();
  assert.equal(api.cancelled.length, 0);
  api.confirmed(api.tabs[0], [
    issue('A-1'),
    {
      ...issue('B-2', 'A-1'),
      status: { id: 'done', name: 'Done', category: 'done' },
    },
  ]);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.deepEqual(api.cancelled, ['work:request-1']);
  api.pending[1].resolve(blockerGraph('A-1'));
  await held;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
});

test('unchanged polling retains explicit partial and missing-status uncertainty', async () => {
  const api = rendererRequests();
  const inspected = api.inspect('work', 'A-1');
  const partial = blockerGraph('A-1');
  partial.groups[0].state = 'partial';
  delete partial.groups[0].items[0].statusCategory;
  api.pending[0].resolve(partial);
  await inspected;
  await api.refresh(api.tabs[0], false);
  assert.equal(api.graphs()['["work","A-1"]']?.groups[0].state, 'partial');
  assert.equal(
    relationshipBlockers(
      issue('A-1'),
      api.graphs()['["work","A-1"]'],
      new Map([
        [
          'B-2',
          {
            ...issue('B-2'),
            status: { id: 'done', name: 'Done', category: 'done' },
          },
        ],
      ]),
    ).blocker,
    'unknown',
  );
});

test('conflicting or unavailable Jira fallback status is unknown while inspected status remains authoritative', () => {
  const source = {
    ...issue('A-1'),
    linksAvailable: true,
    links: [
      {
        key: 'B-2',
        summary: 'B-2',
        relationship: 'depends on',
        direction: 'inward' as const,
        statusCategory: 'done' as const,
      },
    ],
  };
  for (const target of [
    issue('B-2'),
    { ...issue('B-2'), unavailableFields: ['status'] },
  ]) {
    assert.equal(
      relationshipBlockers(source, undefined, new Map([['B-2', target]]))
        .blocker,
      'unknown',
    );
    assert.equal(
      relationshipBlockers(
        source,
        blockerGraph('A-1', 'B-2', 'done'),
        new Map([['B-2', target]]),
      ).blocker,
      'clear',
      'inspected result determines authority',
    );
  }
});

test('relationship comparison treats link direction, availability, and child additions as evidence, not array order or labels', () => {
  const source = {
    ...issue('A-1'),
    linksAvailable: true,
    links: [
      {
        key: 'B-2',
        summary: 'B-2',
        relationship: 'depends on',
        direction: 'inward' as const,
        statusCategory: 'new' as const,
      },
      {
        key: 'B-3',
        summary: 'B-3',
        relationship: 'relates to',
        direction: 'outward' as const,
      },
    ],
  };
  const before = treeSnapshot('A-1', [source]);
  assert.equal(
    relationshipChangedKeys(
      before,
      treeSnapshot('A-1', [
        {
          ...source,
          links: [...source.links].reverse(),
          labels: [{ id: 'blocker', name: 'blocker' }],
          updated: 'later',
        },
      ]),
    ).size,
    0,
  );
  assert.ok(
    relationshipChangedKeys(
      before,
      treeSnapshot('A-1', [{ ...source, linksAvailable: false }]),
    ).has('A-1'),
  );
  assert.ok(
    relationshipChangedKeys(
      before,
      treeSnapshot('A-1', [
        { ...source, links: [{ ...source.links[0], direction: 'outward' }] },
      ]),
    ).has('A-1'),
  );
  const added = relationshipChangedKeys(
    before,
    treeSnapshot('A-1', [source, issue('CHILD-1', 'A-1')]),
  );
  assert.ok(added.has('A-1'));
  assert.ok(added.has('CHILD-1'));
});

const blockerGraph = (
  key: string,
  target = 'B-2',
  statusCategory: 'new' | 'done' | undefined = 'new',
) => {
  const result = graph(key);
  result.groups[0].items = [
    {
      key: target,
      summary: target,
      relationship: 'blocked by',
      direction: 'inward',
      access: 'available',
      statusCategory,
    },
  ];
  return result;
};
const treeSnapshot = (
  rootKey: string,
  issues: Issue[],
  warnings: string[] = [],
): TreeSnapshot => ({ rootKey, issues, warnings, fetchedAt: 2 });

for (const mode of ['scheduled', 'focus/reconnect', 'forced recovery']) {
  test(`${mode} unchanged confirmed poll preserves inspected and held blocker authority`, async () => {
    const api = rendererRequests();
    api.seed(api.tabs[0], [
      issue('A-1'),
      {
        ...issue('B-2', 'A-1'),
        status: { id: 'done', name: 'Done', category: 'done' },
      },
    ]);
    api.next(
      treeSnapshot('A-1', [
        issue('A-1'),
        {
          ...issue('B-2', 'A-1'),
          status: { id: 'done', name: 'Done', category: 'done' },
        },
      ]),
    );
    const inspected = api.inspect('work', 'A-1');
    api.pending[0].resolve(blockerGraph('A-1'));
    await inspected;
    const held = api.inspect('work', 'A-1');
    await api.refresh(api.tabs[0], false, mode === 'forced recovery');
    assert.equal(api.cancelled.length, 0);
    assert.equal(
      relationshipBlockers(issue('A-1'), api.graphs()['["work","A-1"]'])
        .blocker,
      'blocked',
      'unchanged stale completed tree cannot replace inspected active blocker',
    );
    assert.equal(api.loading()['["work","A-1"]'], true);
    api.pending[1].resolve(blockerGraph('A-1'));
    await held;
    assert.equal(
      relationshipBlockers(issue('A-1'), api.graphs()['["work","A-1"]'])
        .blocker,
      'blocked',
    );
  });
}

for (const change of [
  'status',
  'missing status',
  'removed target',
  'source parent',
  'links missing',
  'incomplete tree',
]) {
  test(`quiet ${change} invalidates affected authority and rejects stale completion`, async () => {
    const api = rendererRequests();
    api.seed(api.tabs[0], [issue('A-1'), issue('B-2', 'A-1')]);
    const inspected = api.inspect('work', 'A-1');
    api.pending[0].resolve(blockerGraph('A-1'));
    await inspected;
    const held = api.inspect('work', 'A-1');
    let issues = [issue('A-1'), issue('B-2', 'A-1')];
    if (change === 'status')
      issues[1].status = { id: 'done', name: 'Done', category: 'done' };
    if (change === 'missing status') issues[1].unavailableFields = ['status'];
    if (change === 'removed target') issues = [issue('A-1')];
    if (change === 'source parent') issues[0].parentKey = 'NEW-1';
    if (change === 'links missing') issues[0].unavailableFields = ['links'];
    api.next(
      treeSnapshot(
        'A-1',
        issues,
        change === 'incomplete tree' ? ['Partial hierarchy'] : [],
      ),
    );
    await api.refresh(api.tabs[0], false, true);
    assert.equal(api.graphs()['["work","A-1"]'], undefined);
    assert.equal(api.cancelled.length, 1);
    const fresh = api.inspect('work', 'A-1');
    api.pending[1].resolve(blockerGraph('A-1', 'B-2', 'done'));
    await held;
    assert.equal(api.graphs()['["work","A-1"]'], undefined);
    assert.equal(api.loading()['["work","A-1"]'], true);
    const unknown = blockerGraph('A-1');
    delete unknown.groups[0].items[0].statusCategory;
    api.pending[2].resolve(unknown);
    await fresh;
    assert.equal(
      relationshipBlockers(
        issue('A-1'),
        api.graphs()['["work","A-1"]'],
        new Map([
          [
            'B-2',
            {
              ...issue('B-2'),
              status: { id: 'done', name: 'Done', category: 'done' },
            },
          ],
        ]),
      ).blocker,
      'unknown',
    );
  });
}

test('changed target in another same-account root invalidates its inspected source only', async () => {
  const api = rendererRequests();
  api.seed(api.tabs[1], [issue('B-1'), issue('B-2', 'B-1')]);
  const inspected = api.inspect('work', 'A-1');
  api.pending[0].resolve(blockerGraph('A-1'));
  await inspected;
  const unrelated = api.inspect('other', 'A-1');
  api.pending[1].resolve(blockerGraph('A-1'));
  await unrelated;
  const held = api.inspect('work', 'A-1');
  api.next(
    treeSnapshot('B-1', [
      issue('B-1'),
      {
        ...issue('B-2', 'B-1'),
        status: { id: 'done', name: 'Done', category: 'done' },
      },
    ]),
  );
  await api.refresh(api.tabs[1], false);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.equal(api.graphs()['["other","A-1"]']?.groups[0].state, 'visible');
  assert.deepEqual(api.cancelled, ['work:request-2']);
  api.pending[2].resolve(blockerGraph('A-1'));
  await held;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
});

test('quiet nonrelationship changes and unrelated changed roots preserve inspections', async () => {
  const api = rendererRequests();
  const inspected = api.inspect('work', 'A-1');
  api.pending[0].resolve(blockerGraph('A-1'));
  await inspected;
  const held = api.inspect('work', 'A-1');
  api.next(
    treeSnapshot('A-1', [
      {
        ...issue('A-1'),
        updated: 'new',
        commentCount: 9,
        labels: [{ id: 'x', name: 'label' }],
        priority: { id: 'high', name: 'High' },
      },
    ]),
  );
  await api.refresh(api.tabs[0], false);
  api.next(
    treeSnapshot('B-1', [
      {
        ...issue('B-1'),
        status: { id: 'done', name: 'Done', category: 'done' },
      },
    ]),
  );
  await api.refresh(api.tabs[1], false);
  assert.equal(api.cancelled.length, 0);
  assert.equal(api.graphs()['["work","A-1"]']?.key, 'A-1');
  api.pending[1].resolve(blockerGraph('A-1'));
  await held;
  assert.equal(api.graphs()['["work","A-1"]']?.groups[0].state, 'visible');
});

for (const connection of ['work', 'other']) {
  test(`pending newly discovered target change is guarded by ${connection} account identity`, async () => {
    const api = rendererRequests();
    const tab = connection === 'work' ? api.tabs[1] : api.tabs[2];
    api.seed(tab, [issue(tab.rootKey), issue('B-2', tab.rootKey)]);
    const held = api.inspect('work', 'A-1');
    api.next(
      treeSnapshot(tab.rootKey, [
        issue(tab.rootKey),
        {
          ...issue('B-2', tab.rootKey),
          status: { id: 'done', name: 'Done', category: 'done' },
        },
      ]),
    );
    await api.refresh(tab, false);
    assert.equal(
      api.cancelled.length,
      0,
      'unrelated source is retained until its unknown targets are returned',
    );
    api.pending[0].resolve(blockerGraph('A-1'));
    await held;
    const result = api.graphs()['["work","A-1"]'];
    assert.equal(
      result.groups[0].state,
      connection === 'work' ? 'partial' : 'visible',
    );
    if (connection === 'work') {
      assert.equal(result.groups[0].problem, 'invalid');
      assert.match(result.groups[0].reason!, /changed.*Inspect again/);
      assert.equal(
        relationshipBlockers(issue('A-1'), result).blocker,
        'unknown',
      );
      const fresh = api.inspect('work', 'A-1');
      api.pending[1].resolve(blockerGraph('A-1', 'B-2', 'done'));
      await fresh;
      assert.equal(
        relationshipBlockers(issue('A-1'), api.graphs()['["work","A-1"]'])
          .blocker,
        'clear',
      );
    }
  });
}

test('late target conflict preserves unaffected active blockers and outside-connection privacy', async () => {
  const api = rendererRequests();
  api.seed(api.tabs[1], [issue('B-1'), issue('B-3', 'B-1')]);
  const held = api.inspect('work', 'A-1');
  api.next(
    treeSnapshot('B-1', [
      issue('B-1'),
      {
        ...issue('B-3', 'B-1'),
        status: { id: 'done', name: 'Done', category: 'done' },
      },
    ]),
  );
  await api.refresh(api.tabs[1], false);
  const result = blockerGraph('A-1');
  result.groups[0].items.push({
    key: 'B-3',
    summary: 'Changed blocker',
    relationship: 'blocked by',
    direction: 'inward',
    statusCategory: 'done',
    access: 'outside-connection',
    crossRepository: true,
  });
  api.pending[0].resolve(result);
  await held;
  const inspected = api.graphs()['["work","A-1"]'];
  assert.equal(inspected.groups[0].state, 'partial');
  assert.equal(inspected.groups[0].items[1].statusCategory, undefined);
  assert.equal(inspected.groups[0].items[1].access, 'outside-connection');
  assert.equal(inspected.groups[0].items[1].crossRepository, true);
  const blockers = relationshipBlockers(issue('A-1'), inspected);
  assert.equal(blockers.blocker, 'blocked');
  assert.equal(blockers.incomplete, true);
  assert.deepEqual(blockers.blockers, ['B-2']);
});

for (const gate of ['editor', 'pending write']) {
  for (const manual of [true, false]) {
    test(`real ${gate} opening during ${manual ? 'manual' : 'quiet'} delivery retains its exact refresh intent`, async () => {
      const api = rendererRequests(true);
      for (const [connection, key] of [
        ['work', 'A-1'],
        ['work', 'B-1'],
        ['other', 'A-1'],
      ]) {
        const inspected = api.inspect(connection, key);
        api.pending.at(-1)!.resolve(blockerGraph(key));
        await inspected;
      }
      const index = api.pending.length;
      const held = api.inspect('work', 'A-1');
      let releaseTree!: () => void;
      api.setTree(
        async (_connection: string, key: string) =>
          new Promise((resolve) => {
            releaseTree = () => resolve(treeSnapshot(key, [issue(key)]));
          }),
      );
      const delivery = api.refresh(api.tabs[0], manual, true);
      assert.equal(
        typeof releaseTree,
        'function',
        'gate opens after real root read starts',
      );
      let write: Promise<unknown> | undefined;
      let releaseWrite!: () => void;
      if (gate === 'editor') api.editor('work');
      else {
        api.context.window.canopy.update = async (
          _connection: string,
          key: string,
        ) =>
          new Promise((resolve) => {
            releaseWrite = () =>
              resolve({
                ...issue(key),
                priority: { id: 'high', name: 'High' },
              });
          });
        write = api.context.mutations.update('work', 'A-1', {
          priorityId: 'high',
        });
        await api.settle();
        assert.equal(api.context.mutations.pending('work'), true);
      }
      releaseTree();
      await delivery;
      assert.ok(api.graphs()['["work","A-1"]']);
      assert.equal(api.loading()['["work","A-1"]'], true);
      assert.equal(api.cancelled.length, 0);
      assert.equal(api.context.deferredRefreshes.current.has('a'), true);
      if (gate === 'editor') api.editor();
      else {
        releaseWrite();
        await write;
      }
      api.setTree(async (_connection: string, key: string) =>
        treeSnapshot(key, [issue(key)]),
      );
      // Closing the gate can attempt a retry before the shared root cooldown.
      await api.advance(1_500);
      assert.equal(api.context.api.intent().length, manual ? 1 : 0);
      assert.ok(api.graphs()['["work","A-1"]']);
      assert.equal(api.cancelled.length, 0);
      await api.advance(31_000);
      assert.equal(api.context.deferredRefreshes.current.has('a'), false);
      assert.equal(api.context.api.intent().length, 0);
      assert.ok(api.graphs()['["work","B-1"]']);
      assert.ok(api.graphs()['["other","A-1"]']);
      if (manual) {
        assert.equal(api.graphs()['["work","A-1"]'], undefined);
        assert.deepEqual(api.cancelled, [`work:request-${index}`]);
        const fresh = api.inspect('work', 'A-1');
        api.pending[index].resolve(blockerGraph('A-1', 'B-2', 'done'));
        await held;
        assert.equal(api.graphs()['["work","A-1"]'], undefined);
        assert.equal(api.loading()['["work","A-1"]'], true);
        api.pending.at(-1)!.resolve(blockerGraph('A-1'));
        await fresh;
      } else {
        assert.equal(api.cancelled.length, 0);
        api.pending[index].resolve(blockerGraph('A-1'));
        await held;
        assert.ok(api.graphs()['["work","A-1"]']);
      }
    });
  }
}

for (const replacement of [
  'closed',
  'root generation',
  'refresh sequence',
  'other account',
]) {
  test(`blocked delivery cannot restore manual intent after ${replacement} replacement`, async () => {
    const api = rendererRequests(true);
    const inspected = api.inspect('work', 'A-1');
    api.pending[0].resolve(blockerGraph('A-1'));
    await inspected;
    let releaseTree!: () => void;
    api.setTree(
      async (_connection: string, key: string) =>
        new Promise((resolve) => {
          releaseTree = () => resolve(treeSnapshot(key, [issue(key)]));
        }),
    );
    const delivery = api.refresh(api.tabs[0], true, true);
    api.editor('work');
    let newer: Promise<unknown> | undefined;
    if (replacement === 'closed')
      api.context.tabsRef.current = api.tabs.slice(1);
    if (replacement === 'other account')
      api.context.tabsRef.current = [
        { ...api.tabs[0], connectionId: 'other' },
        ...api.tabs.slice(1),
      ];
    if (replacement === 'root generation') {
      const key = api.context.refreshRootKey(api.tabs[0]);
      api.context.rootRefreshes.current.forget(key);
      const load = api.context.rootRefreshes.current.load(
        key,
        true,
        false,
        async () => treeSnapshot('A-1', [issue('A-1')]),
      );
      assert.ok('promise' in load);
      if ('promise' in load) await load.promise;
    }
    if (replacement === 'refresh sequence') {
      api.editor();
      api.context.refreshSchedule.current.forget('a');
      api.context.refreshSchedule.current.sync(
        api.tabs.map((tab: TabState) => tab.id),
        'a',
        api.context.Date.now(),
      );
      newer = api.refresh(api.tabs[0], false, true);
      api.editor('work');
    }
    releaseTree();
    await delivery;
    await newer;
    assert.equal(
      api.context.api.intent().length,
      0,
      'outgoing ownership cannot enqueue manual invalidation',
    );
    assert.equal(api.cancelled.length, 0);
    api.editor();
    api.setTree(async (_connection: string, key: string) =>
      treeSnapshot(key, [issue(key)]),
    );
    await api.advance(31_000);
    assert.ok(api.graphs()['["work","A-1"]']);
    assert.equal(api.cancelled.length, 0);
  });
}

test('new manual intent queued during delivery belongs to the successful retry', async () => {
  const api = rendererRequests(true);
  const inspected = api.inspect('work', 'A-1');
  api.pending[0].resolve(blockerGraph('A-1'));
  await inspected;
  const held = api.inspect('work', 'A-1');
  let releaseTree!: () => void;
  api.setTree(
    async (_connection: string, key: string) =>
      new Promise((resolve) => {
        releaseTree = () => resolve(treeSnapshot(key, [issue(key)]));
      }),
  );
  const first = api.refresh(api.tabs[0], false, true);
  api.editor('work');
  await api.refresh(api.tabs[0], true, true);
  releaseTree();
  await first;
  assert.equal(api.cancelled.length, 0);
  api.editor();
  api.setTree(async (_connection: string, key: string) =>
    treeSnapshot(key, [issue(key)]),
  );
  await api.advance(31_000);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.deepEqual(api.cancelled, ['work:request-1']);
  api.pending[1].resolve(blockerGraph('A-1'));
  await held;
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
});

test('demo related-work step inspects the lazy graph before highlighting CAN-200', async () => {
  const source = readFileSync(
    new URL('../src/renderer/App.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf("show(4, 'The linked CAN-200");
  const end = source.indexOf("openTab('demo', 'CAN-200')", start);
  assert.ok(start > 0 && end > start);
  const provider = new DemoProvider();
  let inspected: IssueRelationships | undefined;
  let highlighted = false;
  const button = {};
  const context = {
    show: () => {},
    delay: async () => {},
    inspectRelationships: async (connection: string, key: string) => {
      assert.equal(connection, 'demo');
      assert.equal(key, 'CAN-108');
      inspected = await provider.relationships(key);
    },
    document: {
      querySelector: () =>
        inspected?.groups
          .find((group) => group.kind === 'related')
          ?.items.some((link) => link.key === 'CAN-200')
          ? button
          : null,
      querySelectorAll: () =>
        inspected
          ? [
              {
                textContent: 'CAN-108 relates to CAN-200',
                querySelector: () => button,
              },
            ]
          : [],
    },
    waitFor: async (check: () => boolean) =>
      assert.equal(check(), true, 'typed related reference is rendered'),
    highlight: (target: unknown) => {
      assert.equal(
        target,
        button,
        'lazy target must exist before highlighting',
      );
      highlighted = true;
    },
  };
  await runInNewContext(
    js(`(async () => { ${source.slice(start, end)} })()`),
    context,
  );
  assert.equal(highlighted, true);
  assert.equal(inspected?.key, 'CAN-108');
});
