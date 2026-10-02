import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { issueWorkBrief } from '../src/renderer/copy-issue';
import { relationshipBlockers } from '../src/renderer/relationships';
import { DemoProvider } from '../src/main/demo-provider';
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
function rendererRequests() {
  const source = parsed('../src/renderer/App.tsx');
  const names = new Set([
    'relationshipGraphs',
    'relationshipLoading',
    'relationshipRequests',
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
  const context: any = {
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
    setRefreshing: setter,
    setLoading: setter,
    setWorkspace: setter,
    setConnectionErrors: setter,
    setErrors: setter,
    mutations: {
      beginRefresh: () => 1,
      endRefresh: setter,
      confirmedSnapshot: () => undefined,
      receive: (tab: TabState, snapshot: TreeSnapshot) => {
        context.snapshots = { ...context.snapshots, [tab.id]: snapshot };
        context.snapshotsRef.current = context.snapshots;
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
  runInNewContext(
    js(
      `${declarations}\nglobalThis.api = { inspect: inspectRelationships, refresh: refreshTab };`,
    ),
    context,
  );
  const renderEffects = () => {
    effectIndex = 0;
    runInNewContext(js(effects), context);
  };
  renderEffects();
  return {
    ...context.api,
    pending,
    cancelled,
    tabs,
    graphs: () => states[0] as Record<string, IssueRelationships>,
    loading: () => states[1],
    refresh: async (tab: TabState) => {
      await context.api.refresh(tab, true, true);
      renderEffects();
    },
    optimistic: () => {
      context.snapshots = { ...context.snapshots };
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
