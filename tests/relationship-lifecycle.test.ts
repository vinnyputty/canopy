import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxPanel } from '../src/renderer/InboxPanel';
import {
  configuredRoots,
  viewSources,
  sourceTabId,
} from '../src/renderer/saved-views';
import { inboxCandidates } from '../src/renderer/inbox';
import {
  emptySidebarSession,
  organizeSidebar,
} from '../src/renderer/sidebar-organization';
import { changeTriage } from '../src/shared/triage';
import { ancestorPath, buildIssueTree } from '../src/renderer/tree';
import { inboxStamp, InboxInspection } from '../src/renderer/inbox';
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
  relationshipDestination,
} from '../src/renderer/relationships';
import { activateTab, sameRoot, visit } from '../src/renderer/workspace';
import { rootView } from '../src/renderer/table-view';
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
  Workspace,
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
    initialLoad: false,
    cancelHandoffs: () => {},
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
function rendererRequests(realRefresh = false, initialTabs?: TabState[]) {
  const source = parsed('../src/renderer/App.tsx');
  const names = new Set([
    'receiveInboxGraphs',
    'inboxInspection',
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
          n.name.getText(source) === `[${name}]` ||
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
  const tabs =
    initialTabs ??
    ([
      { id: 'a', connectionId: 'work', rootKey: 'A-1' },
      { id: 'b', connectionId: 'work', rootKey: 'B-1' },
      { id: 'other', connectionId: 'other', rootKey: 'A-1' },
    ] as TabState[]);
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
      states[index] = typeof value === 'function' ? value() : value;
      return [
        states[index],
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
    confirmedSnapshots: snapshots,
    inboxStamp,
    InboxInspection,
    inboxInspectionGraphs: {},
    inboxInspectionBusy: false,
    setInboxInspectionGraphs: (entries: Record<string, unknown>) => {
      context.inboxInspectionGraphs = entries;
    },
    setInboxInspectionBusy: (busy: boolean) => {
      context.inboxInspectionBusy = busy;
    },
    inboxGraphs: {},
    setInboxGraphs: (next: any) => {
      context.inboxGraphs =
        typeof next === 'function' ? next(context.inboxGraphs) : next;
    },
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
        syncStatus: async () => ({ retryAt: null }),
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
      `${declarations}\nglobalThis.api = { inspect: inspectRelationships, receiveInbox: receiveInboxGraphs, inspection: typeof inboxInspection === 'undefined' ? undefined : inboxInspection, refresh: refreshTab, publish: ${publish.getText(source)}, intent: () => [...manualRelationshipRefreshes.current], graphRef: () => relationshipGraphsRef.current };`,
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
    inboxGraphs: () => context.inboxGraphs,
    graphs: () => states[0] as Record<string, IssueRelationships>,
    loading: () => states[states[1] instanceof InboxInspection ? 2 : 1],
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
    assert.equal(api.inboxGraphs()['["work","A-1"]']?.graph.key, 'A-1');
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

for (const mode of [
  'status change',
  'removal',
  'other account',
  'unreferenced root',
]) {
  test(`first outside-root delivery preserves inspected authority before ${mode}`, async () => {
    const api = rendererRequests(true);
    const first = api.inspect('work', 'A-1');
    api.pending[0].resolve(blockerGraph('A-1'));
    await first;
    const cached = api.graphs()['["work","A-1"]'];
    const held = api.inspect('work', 'A-1');
    const tab = {
      ...api.tabs[0],
      id: 'outside',
      connectionId: mode === 'other account' ? 'other' : 'work',
      rootKey: mode === 'unreferenced root' ? 'Z-1' : 'B-2',
    } as TabState;
    api.tabs.push(tab);
    api.context.refreshSchedule.current.sync(
      api.tabs.map((tab: TabState) => tab.id),
      'a',
      api.context.Date.now(),
    );
    let changed = false;
    api.setTree(async (_connection: string, key: string) =>
      treeSnapshot(
        key,
        key === tab.rootKey && changed && mode === 'removal'
          ? []
          : [
              {
                ...issue(key),
                status:
                  key === tab.rootKey && !changed
                    ? { id: 'done', name: 'Done', category: 'done' }
                    : issue(key).status,
              },
            ],
      ),
    );
    await api.refresh(tab, false, true);
    assert.equal(
      api.context.mutations.confirmedSnapshot(tab.id).rootKey,
      tab.rootKey,
    );
    assert.equal(
      api.graphs()['["work","A-1"]'],
      cached,
      'first confirmed evidence preserves the exact graph',
    );
    assert.equal(api.loading()['["work","A-1"]'], true);
    assert.deepEqual(api.cancelled, []);
    assert.equal(
      relationshipBlockers(
        issue('A-1'),
        cached,
        new Map([
          [
            tab.rootKey,
            api.context.mutations.confirmedSnapshot(tab.id).issues[0],
          ],
        ]),
      ).blocker,
      'blocked',
      'inspected active status wins over a newly loaded completed tree',
    );
    await api.advance(31_000);
    await api.refresh(tab, false, true);
    assert.equal(
      api.graphs()['["work","A-1"]'],
      cached,
      'unchanged subsequent quiet reads retain authority',
    );
    assert.deepEqual(api.cancelled, []);
    changed = true;
    await api.refresh(tab, false, true);
    const affected = mode === 'status change' || mode === 'removal';
    assert.equal(!!api.graphs()['["work","A-1"]'], !affected);
    assert.deepEqual(api.cancelled, affected ? ['work:request-1'] : []);
    if (affected) {
      const replacement = api.inspect('work', 'A-1');
      api.pending[1].resolve(blockerGraph('A-1', 'B-2', 'done'));
      await held;
      assert.equal(api.graphs()['["work","A-1"]'], undefined);
      assert.equal(
        api.loading()['["work","A-1"]'],
        true,
        'old finalizer cannot erase current request',
      );
      const missing = blockerGraph('A-1');
      missing.groups[0].items[0].statusCategory = undefined;
      api.pending[2].resolve(missing);
      await replacement;
      assert.equal(
        relationshipBlockers(issue('A-1'), api.graphs()['["work","A-1"]'])
          .blocker,
        'unknown',
      );
    } else {
      api.pending[1].resolve(blockerGraph('A-1'));
      await held;
    }
    const manualHeld = api.inspect('work', 'A-1');
    const index = api.pending.length - 1;
    await api.refresh(api.tabs[0], true, true);
    assert.equal(
      api.graphs()['["work","A-1"]'],
      undefined,
      'manual owning-source invalidation is intentional',
    );
    assert.equal(api.cancelled.at(-1), `work:request-${index}`);
    api.pending[index].resolve(blockerGraph('A-1'));
    await manualHeld;
    assert.equal(api.graphs()['["work","A-1"]'], undefined);
  });
}

for (const [checkpoint, name] of [
  [0, 'blocker owner reuse'],
  [2, 'parent and child owner reuse'],
] as const) {
  test(`desktop tab count follows actual App ${name} and root admission`, () => {
    const smoke = parsed('../tools/smoke-relationships.mjs');
    const installer = nodes(
      smoke,
      (n) =>
        ts.isCallExpression(n) &&
        n.expression.getText(smoke) === 'app.evaluate',
    )[0] as ts.CallExpression;
    const counts = nodes(
      smoke,
      (n) =>
        ts.isCallExpression(n) &&
        n.expression.getText(smoke) ===
          "expect(page.getByRole('tab')).toHaveCount",
    ) as ts.CallExpression[];
    assert.equal(
      counts.length,
      3,
      'all native tab-count checkpoints are covered',
    );
    const handlers = new Map<string, (...args: any[]) => any>();
    runInNewContext(`(${installer.arguments[0].getText(smoke)})({ ipcMain })`, {
      ipcMain: {
        _invokeHandlers: handlers,
        removeHandler: (channel: string) => handlers.delete(channel),
        handle: (channel: string, handler: (...args: any[]) => any) =>
          handlers.set(channel, handler),
      },
    });
    const initial = handlers.get('canopy:loadWorkspace')!() as Workspace;
    assert.deepEqual(
      Array.from(initial.tabs, (tab) => tab.id),
      ['source', 'wrong', 'owner', 'jira', 'unrelated'],
    );
    const source = parsed('../src/renderer/App.tsx');
    const declarations = nodes(
      source,
      (n) =>
        ts.isVariableDeclaration(n) &&
        [
          'navigate',
          'jumpToRelationship',
          'organize',
          'openSavedResult',
        ].includes(n.name.getText(source)),
    )
      .map((n) => `const ${n.getText(source)};`)
      .join('\n');
    const context: any = {
      relationshipDestination,
      organizeSidebar,
      ancestorPath,
      buildIssueTree,
      savedSources: initial.tabs.map((tab) => ({ ...tab, id: tab.id })),
      viewSnapshots: Object.fromEntries(
        initial.tabs.map((tab) => [
          tab.id,
          handlers.get('canopy:tree')!(null, tab.connectionId, tab.rootKey),
        ]),
      ),
      sidebarSessionRef: { current: emptySidebarSession() },
      setSidebarSession: () => {},
      connectionsRef: { current: handlers.get('canopy:connections')!() },
      activateTab,
      rootView,
      sameRoot,
      visit,
      useCallback: (fn: unknown) => fn,
      workspaceRef: { current: initial },
      historyRef: { current: { back: [], forward: [] } },
      pendingScrollRestore: { current: null },
      navigationReveal: { current: null },
      setHistory: () => {},
      setInboxOpen: (value: boolean) => {
        context.inboxOpen = value;
      },
      setNextTaskViews: () => {},
      setReveal: (value: unknown) => {
        context.reveal = value;
      },
      setWorkspace: (update: Workspace | ((value: Workspace) => Workspace)) => {
        context.workspaceRef.current =
          typeof update === 'function'
            ? update(context.workspaceRef.current)
            : update;
      },
      snapshots: Object.fromEntries(
        initial.tabs.map((tab) => [
          tab.id,
          handlers.get('canopy:tree')!(null, tab.connectionId, tab.rootKey),
        ]),
      ),
      crypto: {
        randomUUID: (() => {
          let id = 0;
          return () => `outside-${id++}`;
        })(),
      },
    };
    runInNewContext(
      js(
        `${declarations}\nglobalThis.api = { jump: jumpToRelationship, navigate, organize, openSavedResult };`,
      ),
      context,
    );
    const current = () => context.workspaceRef.current as Workspace;
    const active = () =>
      current().tabs.find((tab) => tab.id === current().activeTabId)!;
    const jump = (connection: string, key: string) => {
      context.api.jump(connection, key);
      assert.equal(active().connectionId, connection);
      assert.equal(active().selectedKey, key);
      assert.equal(context.reveal.tabId, active().id);
      assert.equal(context.reveal.key, key);
    };
    const returned = () =>
      context.api.navigate(current().tabs.find((tab) => tab.id === 'source'));
    jump('work', 'team/a#11');
    assert.equal(active().id, 'owner');
    assert.equal(
      current().tabs.find((tab) => tab.id === 'wrong')!.selectedKey,
      'team/a#10',
    );
    const blockerWorkspace = current();
    returned();
    jump('work', 'team/b#5');
    const outside = active();
    assert.equal(outside.rootKey, 'team/b#5');
    assert.equal(outside.id, 'outside-0');
    const outsideWorkspace = current();
    context.snapshots[outside.id] = handlers.get('canopy:tree')!(
      null,
      'work',
      'team/b#5',
    );
    returned();
    jump('work', 'team/a#10');
    assert.equal(active().id, 'owner');
    returned();
    jump('work', 'team/a#12');
    assert.equal(active().id, 'owner');
    const hierarchyWorkspace = current();
    assert.equal(
      current().tabs.length,
      initial.tabs.length + 1,
      'outside root admitted once, hierarchy reuses its owner',
    );
    jump('work', 'team/b#5');
    assert.equal(active().id, outside.id);
    context.api.navigate({ ...outside, id: 'duplicate-root-id' });
    assert.equal(
      active().id,
      outside.id,
      'actual tab admission deduplicates the same account/root',
    );
    assert.equal(current().tabs.length, hierarchyWorkspace.tabs.length);
    jump('other', 'team/b#5');
    assert.equal(
      active().id,
      'outside-1',
      'same key on another account admits a distinct root',
    );
    assert.equal(current().tabs.length, hierarchyWorkspace.tabs.length + 1);
    jump('work', 'team/b#5');
    assert.equal(active().id, outside.id);
    const owner = current().tabs.find((tab) => tab.id === 'owner')!;
    context.api.organize({ type: 'pin', root: owner });
    const triage = changeTriage(
      undefined,
      'work',
      'team/a#11',
      'pin',
      Date.now(),
    );
    context.workspaceRef.current = {
      ...current(),
      triage,
      rootViews: {
        '["work","TEAM/A#10"]': {
          ...rootView(current(), owner),
          filters: { status: 'Open' },
        },
      },
    };
    context.api.navigate(current().tabs.find((tab) => tab.id === 'wrong'));
    context.inboxOpen = true;
    context.api.openSavedResult({
      issue: issue('team/a#11', 'team/a#10'),
      source: owner,
    });
    assert.equal(
      active().id,
      'owner',
      'Inbox selection resolves the exact owning account/root',
    );
    assert.equal(active().selectedKey, 'team/a#11');
    assert.equal(context.inboxOpen, false);
    assert.equal(context.reveal.tabId, 'owner');
    assert.equal(context.navigationReveal.current.key, 'team/a#11');
    const rootViews = current().rootViews;
    context.api.organize({ type: 'undo' });
    assert.equal(active().id, 'owner');
    assert.equal(active().selectedKey, 'team/a#11');
    assert.deepEqual(current().triage, triage);
    assert.deepEqual(current().rootViews, rootViews);
    assert.deepEqual(current().pinnedRoots, []);
    const checkpoints = [
      blockerWorkspace,
      outsideWorkspace,
      hierarchyWorkspace,
    ];
    console.log(
      'Native tab-count source proof',
      JSON.stringify({
        counts: checkpoints.map((value) => value.tabs.length),
        checkpoint,
        expected: counts[checkpoint].arguments[0].getText(smoke),
      }),
    );
    const assertion = (index: number) =>
      runInNewContext(counts[index].getText(smoke), {
        page: {
          getByRole: (role: string) => {
            assert.equal(role, 'tab');
            return checkpoints[index].tabs;
          },
        },
        expect: (tabs: TabState[]) => ({
          toHaveCount: (count: number) =>
            assert.equal(
              tabs.length,
              count,
              `actual native ${name} tab-count assertion`,
            ),
        }),
      });
    assertion(1); // The outside-root assertion must remain exact as well.
    assertion(checkpoint);
  });
}

test('desktop background audit preserves unreferenced roots and invalidates its referenced parent', async () => {
  const source = parsed('../tools/smoke-relationships.mjs');
  const installer = nodes(
    source,
    (n) =>
      ts.isCallExpression(n) && n.expression.getText(source) === 'app.evaluate',
  )[0] as ts.CallExpression;
  const background = nodes(
    source,
    (n) =>
      ts.isForOfStatement(n) &&
      n.getText(source).includes('const backgroundHeld'),
  )[0] as ts.ForOfStatement;
  assert.ok(
    installer && background,
    'actual IPC fixture and native audit selection',
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  const fixture: any = {
    ipcMain: {
      _invokeHandlers: handlers,
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: (...args: any[]) => any) =>
        handlers.set(channel, handler),
    },
  };
  runInNewContext(
    `(${installer.arguments[0].getText(source)})({ ipcMain })`,
    fixture,
  );
  const controls = fixture.relationshipAudit;
  const api = rendererRequests(true);
  const tabs = handlers.get('canopy:loadWorkspace')!().tabs as TabState[];
  api.tabs.splice(0, api.tabs.length, ...tabs);
  api.context.activeTab = api.tabs[0];
  let serial = 0;
  api.context.crypto.randomUUID = () => `background-${serial++}`;
  for (const name of ['tree', 'relationships', 'cancelRelationships'])
    api.context.window.canopy[name] = async (...args: unknown[]) =>
      handlers.get(`canopy:${name}`)!(null, ...args);
  api.context.mutations = new Mutations(
    api.context.window.canopy,
    (view) => api.context.api.publish(view),
    () => {},
  );
  api.context.refreshSchedule.current.sync(
    api.tabs.map((tab: TabState) => tab.id),
    'source',
    api.context.Date.now(),
  );
  api.context.activeIdRef.current = 'source';
  for (const tab of tabs)
    api.context.mutations.receive(
      tab,
      await api.context.window.canopy.tree(tab.connectionId, tab.rootKey),
      0,
    );
  await api.refresh(tabs[0], false, true);
  await api.advance(31_000);
  await api.inspect('work', 'team/a#1');

  // Match the preceding native changed-target poll and restored target evidence.
  controls.mode = 'background-hold';
  const recovery = api.inspect('work', 'team/a#1');
  const recoveryCall = controls.calls.at(-1);
  const recoveryBoundary = controls.cancelled.length;
  controls.pollTargetUnavailable = true;
  await api.advance(121_000);
  assert.ok(
    controls.cancelled
      .slice(recoveryBoundary)
      .some(
        (call: any) =>
          call.connection === recoveryCall.connection &&
          call.requestId === recoveryCall.requestId,
      ),
  );
  controls.release();
  await recovery;
  controls.mode = 'normal';
  controls.pollTargetUnavailable = false;
  await api.advance(241_000);
  await api.inspect('work', 'team/a#1');
  const identity = '["work","team/a#1"]';
  const inspected = api.graphs()[identity] as IssueRelationships;
  assert.equal(
    inspected.groups.find((group) => group.kind === 'parent')!.items[0].key,
    'team/a#10',
  );
  assert.equal(
    inspected.groups.find((group) => group.kind === 'blocked')!.items[0].key,
    'team/b#5',
  );
  assert.equal(
    api.context.mutations
      .confirmedSnapshot('owner')
      .issues.find((row: Issue) => row.key === 'team/a#11').unavailableFields,
    undefined,
  );

  const cases = runInNewContext(background.expression.getText(source), {}) as [
    number,
    string,
    string?,
    boolean?,
  ][];
  for (const [index, connection, selectedRoot, invalidates = false] of cases) {
    const tab = tabs[index];
    assert.equal(tab.connectionId, connection);
    if (selectedRoot) assert.equal(tab.rootKey, selectedRoot);
    const before = api.context.mutations.confirmedSnapshot(tab.id);
    controls.heldTreeConnection = connection;
    // Reviewed fixture held team/a#10 implicitly; the fixed fixture scopes both identities.
    controls.heldTreeRoot = tab.rootKey;
    controls.backgroundMarker = `Confirmed background ${connection} ${tab.rootKey}`;
    controls.treeRelease = null;
    const delivery = api.refresh(tab, true, true);
    assert.equal(typeof controls.treeRelease, 'function');
    controls.mode = 'background-hold';
    controls.release = null;
    const held = api.inspect('work', 'team/a#1');
    const call = controls.calls.at(-1);
    assert.equal(call.connection, 'work');
    assert.equal(call.key, 'team/a#1');
    const boundary = controls.cancelled.length;
    assert.ok(api.graphs()[identity]);
    assert.equal(api.loading()[identity], true);
    controls.treeRelease();
    await delivery;
    const after = api.context.mutations.confirmedSnapshot(tab.id);
    assert.equal(
      api.context.api.intent().length,
      0,
      'the delivered manual target refresh has no outstanding source intent',
    );
    assert.equal(
      api.context.api.graphRef()[identity],
      api.graphs()[identity],
      'published graph ref and visible graph agree',
    );
    const changed = [...relationshipChangedKeys(before, after)];
    assert.deepEqual(
      changed,
      [tab.rootKey],
      'only the selected root summary changed; cached blocker/child facts were restored',
    );
    const cancelled = controls.cancelled
      .slice(boundary)
      .filter(
        (cancel: any) =>
          cancel.connection === call.connection &&
          cancel.requestId === call.requestId,
      );
    console.log(
      'Background audit proof',
      JSON.stringify({
        connection,
        rootKey: tab.rootKey,
        invalidates,
        changed,
        call,
        cancelled,
        graphPresent: !!api.graphs()[identity],
        loading: api.loading()[identity] === true,
      }),
    );
    assert.equal(cancelled.length, invalidates ? 1 : 0);
    assert.equal(!!api.graphs()[identity], !invalidates);
    assert.equal(api.loading()[identity] === true, !invalidates);
    controls.release();
    await held;
    assert.equal(
      !!api.graphs()[identity],
      !invalidates,
      'late result respects exact cancellation and graph authority',
    );
    controls.mode = 'normal';
    controls.heldTreeConnection = null;
    controls.heldTreeRoot = null;
    controls.backgroundMarker = null;
    if (invalidates) await api.inspect('work', 'team/a#1');
  }
  assert.equal(
    cases.length,
    3,
    'negative account/root controls and positive parent-change control all execute',
  );
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

test('inbox cache handoff preserves unrelated typed graphs and own refresh invalidates both caches', async () => {
  const api = rendererRequests();
  const first = api.inspect('work', 'A-1');
  api.pending[0].resolve(graph('A-1'));
  await first;
  const other = api.inspect('other', 'A-1');
  api.pending[1].resolve(graph('A-1'));
  await other;
  api.receiveInbox({
    '["work","A-1"]': {
      stamp: inboxStamp(api.context.snapshots['a'], issue('A-1')),
      graph: graph('A-1'),
    },
  });
  assert.equal(api.graphs()['["other","A-1"]']?.key, 'A-1');
  assert.equal(api.inboxGraphs()['["other","A-1"]']?.graph.key, 'A-1');
  await api.refresh(api.tabs[0]);
  assert.equal(api.graphs()['["work","A-1"]'], undefined);
  assert.equal(api.inboxGraphs()['["work","A-1"]'], undefined);
  assert.equal(api.graphs()['["other","A-1"]']?.key, 'A-1');
  assert.equal(api.inboxGraphs()['["other","A-1"]']?.graph.key, 'A-1');
});

test('actual Inbox handoff rejects stale provenance and invalidates referenced targets through the live graph ref', () => {
  const api = rendererRequests();
  const identity = '["work","A-1"]';
  const stamped = inboxStamp(api.context.snapshots.a, issue('A-1'));
  api.receiveInbox({
    [identity]: { stamp: 'old', graph: blockerGraph('A-1', 'B-1', 'new') },
  });
  assert.equal(api.graphs()[identity], undefined);
  api.receiveInbox({
    [identity]: { stamp: stamped, graph: blockerGraph('wrong', 'B-1', 'new') },
  });
  assert.equal(api.graphs()[identity], undefined);
  api.receiveInbox({
    [identity]: { stamp: stamped, graph: blockerGraph('A-1', 'B-1', 'new') },
  });
  assert.equal(api.graphRef()[identity]?.key, 'A-1');
  api.confirmed(api.tabs[1], [
    { ...issue('B-1'), status: { id: 'done', name: 'Done', category: 'done' } },
  ]);
  assert.equal(
    api.graphs()[identity],
    undefined,
    'a confirmed target change invalidates the handed-off typed graph',
  );
  assert.equal(api.inboxGraphs()[identity], undefined);
  const fresh = treeSnapshot('A-1', [{ ...issue('A-1'), summary: 'fresh' }]);
  api.confirmed(api.tabs[0], fresh.issues);
  api.receiveInbox({ [identity]: { stamp: stamped, graph: graph('A-1') } });
  assert.equal(
    api.graphs()[identity],
    undefined,
    'a stale Inbox publication cannot restore invalidated data',
  );
});

test('actual Inbox and saved-view refresh callbacks carry manual relationship intent', async () => {
  const source = parsed('../src/renderer/App.tsx');
  for (const name of ['InboxPanel', 'SavedViewsPanel']) {
    const panel = nodes(
      source,
      (n) =>
        ts.isJsxSelfClosingElement(n) && n.tagName.getText(source) === name,
    )[0] as ts.JsxSelfClosingElement;
    const attribute = panel.attributes.properties.find(
      (n) => ts.isJsxAttribute(n) && n.name.getText(source) === 'onRefresh',
    ) as ts.JsxAttribute;
    const expression = (attribute.initializer as ts.JsxExpression).expression!;
    const api = rendererRequests();
    const first = api.inspect('work', 'A-1');
    api.pending[0].resolve(graph('A-1'));
    await first;
    const context = {
      setIdentityRetry: () => {},
      savedSources: [api.tabs[0]],
      allRefreshTabs: api.tabs,
      sameRoot,
      refreshTab: (...args: Parameters<typeof api.context.api.refresh>) =>
        api.context.api.refresh(...args),
    };
    await runInNewContext(js(`(${expression.getText(source)})();`), context);
    await api.settle();
    assert.equal(
      api.graphs()['["work","A-1"]'],
      undefined,
      `${name} refresh invalidates its cached inspection`,
    );
  }
});

// Use App's actual root paging/confirmed snapshot mapping. B is a real open root
// after the first ten, not a fictitious total or an omitted loaded target.
function outsideInboxTarget() {
  const tabs = [
    { id: 'a', connectionId: 'work', rootKey: 'org/repo#1' },
    { id: 'other', connectionId: 'other', rootKey: 'org/repo#1' },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `filler-${index}`,
      connectionId: 'work',
      rootKey: `org/repo#${index + 2}`,
    })),
    { id: 'outside', connectionId: 'work', rootKey: 'org/repo#99' },
    { id: 'unrelated', connectionId: 'work', rootKey: 'org/repo#100' },
  ] as TabState[];
  const api = rendererRequests(false, tabs);
  const source = parsed('../src/renderer/App.tsx');
  const names = new Set([
    'inboxView',
    'activeSavedView',
    'availableRoots',
    'savedSources',
    'sourceTabs',
    'allRefreshTabs',
    'sourceTabKeys',
    'inboxSnapshots',
  ]);
  const declarations = nodes(
    source,
    (node) =>
      ts.isVariableDeclaration(node) && names.has(node.name.getText(source)),
  )
    .map((node) => `const ${node.getText(source)};`)
    .join('\n');
  Object.assign(api.context, {
    workspace: { tabs, activeTabId: 'other' },
    connections: [
      { id: 'work', provider: 'github' },
      { id: 'other', provider: 'github' },
    ],
    inboxOpen: true,
    inboxRootLimit: 10,
    useMemo: (fn: () => unknown) => fn(),
    configuredRoots,
    viewSources,
    sourceTabId,
    sameRoot,
  });
  const page = () =>
    runInNewContext(
      js(
        `(() => { ${declarations}; return { availableRoots, savedSources, allRefreshTabs, inboxSnapshots }; })()`,
      ),
      api.context,
    );
  const initial = page();
  assert.equal(initial.availableRoots.length, 12);
  assert.equal(initial.savedSources.length, 10);
  assert.equal(initial.allRefreshTabs.length, 12);
  assert.ok(
    initial.allRefreshTabs.some((tab: TabState) => tab.id === 'outside'),
  );
  assert.ok(
    !initial.savedSources.some(
      (tab: TabState) => tab.rootKey === 'org/repo#99',
    ),
  );
  const candidates = inboxCandidates(
    initial.savedSources,
    initial.inboxSnapshots,
    api.context.connections,
  );
  const candidateKey = () =>
    JSON.stringify(
      inboxCandidates(
        page().savedSources,
        page().inboxSnapshots,
        api.context.connections,
      )
        .map((item) => [item.source.connectionId, item.issue.key, item.stamp])
        .sort(),
    );
  const initialKey = candidateKey();
  const controller: InboxInspection =
    api.inspection ??
    new InboxInspection(api.context.window.canopy, (entries) => {
      api.context.inboxInspectionGraphs = entries;
      api.receiveInbox(entries);
    });
  const id = '["work","org/repo#1"]';
  const sourceCandidate = candidates.find(
    (item) =>
      item.source.connectionId === 'work' && item.issue.key === 'org/repo#1',
  )!;
  const targetChanged = () => {
    api.confirmed(tabs[10], [
      {
        ...issue('org/repo#99'),
        status: { id: 'done', name: 'Done', category: 'done' },
      },
    ]);
    assert.equal(
      candidateKey(),
      initialKey,
      'the selected source and candidateKey stay unchanged',
    );
  };
  return { api, controller, candidates, sourceCandidate, id, targetChanged };
}

for (const path of ['cache republish', 'held success', 'failed retry']) {
  test(`outside-page confirmed target invalidation reaches local Inbox and handoff: ${path}`, async () => {
    const { api, controller, candidates, sourceCandidate, id, targetChanged } =
      outsideInboxTarget();
    const oldGraph = blockerGraph('org/repo#1', 'org/repo#99', 'new');
    oldGraph.groups[0].state = 'partial';
    const entry = { stamp: sourceCandidate.stamp, graph: oldGraph };
    let release!: (graph: IssueRelationships) => void;
    let reject!: (error: Error) => void;
    api.context.window.canopy.relationships = () =>
      new Promise((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
    controller.reset(
      candidates,
      path === 'held success' ? {} : { [id]: entry },
    );
    let held: Promise<void> | undefined;
    if (path !== 'cache republish') {
      held = controller.load(candidates, path === 'failed retry');
      await api.settle();
    }
    targetChanged();
    assert.equal(
      api.graphRef()[id],
      undefined,
      'main initially evicts the outside-page target reference',
    );
    assert.equal(
      api.context.inboxInspectionGraphs[id]?.graph,
      undefined,
      'local display cache is evicted without candidate reset or republication',
    );
    if (path === 'cache republish') {
      api.receiveInbox({ [id]: entry });
      controller.reset(candidates, { [id]: entry });
    } else if (path === 'held success') release(oldGraph);
    else reject(new Error('fake held failure'));
    // Other selected issues complete immediately, keeping the batch bounded.
    api.context.window.canopy.relationships = async (
      _connection: string,
      key: string,
    ) => graph(key);
    await held;
    assert.notEqual(
      api.context.inboxInspectionGraphs[id]?.graph?.groups[0].items[0]
        ?.statusCategory,
      'new',
    );
    assert.notEqual(
      api.graphRef()[id]?.groups[0].items[0]?.statusCategory,
      'new',
    );
    if (path === 'failed retry')
      assert.equal(api.context.inboxInspectionGraphs[id]?.graph, undefined);
    // A real new inspection after B changed can regain authority on unchanged A.
    api.context.window.canopy.relationships = async (
      _connection: string,
      key: string,
    ) =>
      key === 'org/repo#1'
        ? blockerGraph(key, 'org/repo#99', 'done')
        : graph(key);
    await controller.load(candidates, true);
    assert.equal(
      api.context.inboxInspectionGraphs[id]?.graph?.groups[0].items[0]
        ?.statusCategory,
      'done',
    );
    assert.equal(
      api.graphRef()[id]?.groups[0].items[0]?.statusCategory,
      'done',
    );
    api.receiveInbox({ [id]: entry });
    assert.equal(
      api.graphRef()[id]?.groups[0].items[0]?.statusCategory,
      'done',
      'stale republication cannot overwrite fresh inspection',
    );
  });
}

test('outside-page invalidation preserves other-account keys, unrelated roots and manual target intent', async () => {
  const { api, controller, candidates, sourceCandidate, id } =
    outsideInboxTarget();
  const entry = {
    stamp: sourceCandidate.stamp,
    graph: blockerGraph('org/repo#1', 'org/repo#99', 'new'),
  };
  controller.reset(candidates, { [id]: entry });
  api.confirmed(api.tabs[1], [
    { ...issue('org/repo#99'), summary: 'Other account changed' },
  ]);
  api.confirmed(api.tabs[11], [
    { ...issue('org/repo#100'), summary: 'Unrelated root changed' },
  ]);
  assert.equal(
    api.context.inboxInspectionGraphs[id]?.graph?.groups[0].items[0]
      .statusCategory,
    'new',
  );
  assert.equal(api.graphRef()[id]?.groups[0].items[0].statusCategory, 'new');
  await api.refresh(api.tabs[10]);
  assert.equal(
    api.graphRef()[id]?.groups[0].items[0].statusCategory,
    'new',
    'manual B inspection invalidation alone is not a changed-target signal',
  );
  api.receiveInbox({ [id]: entry });
  assert.equal(api.graphRef()[id]?.groups[0].items[0].statusCategory, 'new');
  api.receiveInbox({ [id]: { ...entry, stamp: 'wrong' } });
  api.receiveInbox({ [id]: { ...entry, graph: graph('wrong') } });
  assert.equal(api.graphRef()[id]?.groups[0].items[0].statusCategory, 'new');
  api.confirmed(api.tabs[0], [
    { ...issue('org/repo#1'), summary: 'Source changed' },
  ]);
  api.receiveInbox({ [id]: entry });
  assert.equal(api.graphRef()[id], undefined);
});

// Execute the actual panel's candidate/effect block with persistent hook slots.
// App's real mutation publication, inspection controller and handoff run alongside it.
function inboxPanelEffects(inspection: InboxInspection) {
  const source = parsed('../src/renderer/InboxPanel.tsx');
  const component = nodes(
    source,
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'InboxPanel',
  )[0] as ts.FunctionDeclaration;
  const block = component.body!.getText(source);
  const prefix = block.slice(1, block.indexOf('  const items ='));
  const effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const refs: { current: unknown }[] = [];
  return (props: React.ComponentProps<typeof InboxPanel>) => {
    let effectIndex = 0;
    let refIndex = 0;
    return runInNewContext(js(`(() => { ${prefix}; return candidates; })()`), {
      props: { ...props, inspection },
      inboxCandidates,
      queueMicrotask,
      useMemo: (fn: () => unknown) => fn(),
      useState: (value: unknown) => [value, () => {}],
      useRef: (value: unknown) => (refs[refIndex++] ??= { current: value }),
      useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
        const index = effectIndex++;
        const previous = effects[index];
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: fn() || undefined };
        }
      },
    });
  };
}

for (const path of ['completed', 'pending']) {
  test(`quiet confirmed fetch preserves ${path} Inbox inspection and updates confirmation display`, async () => {
    const api = rendererRequests(true);
    const controller: InboxInspection = api.inspection;
    const panel = inboxPanelEffects(controller);
    const connections = [
      {
        id: 'work',
        name: 'Work',
        provider: 'github' as const,
        url: 'https://sample.invalid',
      },
    ];
    const id = '["work","A-1"]';
    let release!: (result: IssueRelationships) => void;
    let reads = 0;
    api.context.window.canopy.relationships = async () => {
      reads++;
      return path === 'completed'
        ? blockerGraph('A-1')
        : new Promise<IssueRelationships>((resolve) => {
            release = resolve;
          });
    };
    const props = (): React.ComponentProps<typeof InboxPanel> => ({
      workspace: {
        tabs: [],
        activeTabId: null,
        shortcuts: {},
        theme: 'system',
        sidebarCollapsed: false,
      },
      inspection: controller,
      graphs: api.context.inboxInspectionGraphs,
      busy: controller.busy,
      connections,
      sources: [api.tabs[0]],
      snapshots: api.context.snapshotsRef.current,
      totalRoots: 1,
      errors: {},
      identityErrors: {},
      users: {},
      loading: new Set(),
      now: 0,
      onChange: () => {},
      onSeen: () => {},
      onOpen: () => {},
      onRefresh: () => {},
      onMoreRoots: () => {},
    });
    panel(props());
    await api.settle();
    assert.equal(reads, 1);
    const initialStamp = inboxCandidates(
      [api.tabs[0]],
      props().snapshots,
      connections,
    )[0].stamp;
    const updatedFetch = 1_800_000_000_000;
    api.next({
      rootKey: 'A-1',
      issues: [issue('A-1')],
      fetchedAt: updatedFetch,
      warnings: [],
    });
    await api.refresh(api.tabs[0], false, true);
    const fresh = panel(props());
    await api.settle();
    assert.equal(
      fresh[0].stamp,
      initialStamp,
      'poll time is separate from issue content identity',
    );
    assert.equal(
      api.cancelled.length,
      0,
      'quiet publication/reset preserves active ownership',
    );
    assert.equal(
      reads,
      1,
      'quiet publication adds no inspection or discovery work',
    );
    if (path === 'pending') {
      assert.equal(controller.busy, true);
      release(blockerGraph('A-1'));
      await api.settle();
    }
    assert.equal(controller.busy, false);
    assert.equal(
      api.context.inboxInspectionGraphs[id].graph.groups[0].items[0]
        .statusCategory,
      'new',
    );
    assert.equal(
      api.graphRef()[id].groups[0].items[0].statusCategory,
      'new',
      'actual App handoff admits the original read after the newer quiet fetch',
    );
    const markup = renderToStaticMarkup(
      React.createElement(InboxPanel, props()),
    );
    assert.match(markup, /Blocked by B-2/);
    assert.ok(
      markup.includes(new Date(updatedFetch).toLocaleString()),
      'latest confirmation display remains fresh',
    );
    assert.match(markup, /0<!-- --> unfinished|0 unfinished/);

    // A real source change still invalidates the local result and App authority.
    api.confirmed(api.tabs[0], [
      { ...issue('A-1'), summary: 'Source changed' },
    ]);
    panel(props());
    await api.settle();
    assert.equal(api.context.inboxInspectionGraphs[id], undefined);
    assert.equal(api.graphRef()[id], undefined);
    assert.equal(
      reads,
      1,
      'changed content waits for explicit bounded inspection',
    );
  });
}

for (const change of ['source content', 'tree coverage']) {
  test(`quiet Inbox refresh keeps pending read guarded against later ${change} changes`, async () => {
    const api = rendererRequests(true);
    const controller: InboxInspection = api.inspection;
    const sources = [api.tabs[0]];
    const connections = [
      {
        id: 'work',
        name: 'Work',
        provider: 'github' as const,
        url: 'https://sample.invalid',
      },
    ];
    const candidates = () =>
      inboxCandidates(sources, api.context.snapshotsRef.current, connections);
    let release!: (result: IssueRelationships) => void;
    api.context.window.canopy.relationships = async () =>
      new Promise<IssueRelationships>((resolve) => {
        release = resolve;
      });
    controller.reset(candidates());
    const held = controller.load(candidates());
    await api.settle();
    api.next({
      rootKey: 'A-1',
      issues: [issue('A-1')],
      fetchedAt: 300,
      warnings: [],
    });
    await api.refresh(api.tabs[0], false, true);
    controller.reset(candidates());
    assert.equal(api.cancelled.length, 0);
    if (change === 'source content')
      api.confirmed(api.tabs[0], [{ ...issue('A-1'), summary: 'Real change' }]);
    else {
      // Relationship authority also includes coverage, independently of issue content.
      api.next({
        rootKey: 'A-1',
        issues: [issue('A-1')],
        fetchedAt: 400,
        warnings: ['Incomplete hierarchy'],
      });
      await api.refresh(api.tabs[0], false, true);
    }
    controller.reset(candidates());
    assert.equal(api.cancelled.length, 1);
    release(blockerGraph('A-1'));
    await held;
    assert.equal(
      api.context.inboxInspectionGraphs['["work","A-1"]'],
      undefined,
    );
    assert.equal(api.graphRef()['["work","A-1"]'], undefined);
  });
}
