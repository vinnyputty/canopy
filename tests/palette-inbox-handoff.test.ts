import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import type { TabState, TreeSnapshot, Workspace } from '../src/shared/types';
import { demoSeeds } from '../src/main/demo-provider';
import { viewSources } from '../src/renderer/saved-views';
import { rootView } from '../src/renderer/table-view';
import { paletteIssueTab } from '../src/renderer/navigation-palette';
import { activateTab, sameRoot, visit } from '../src/renderer/workspace';
import { callback, execute, findNode, sourceFile } from './source-probe';

const source = sourceFile(
  process.env.CANOPY_PALETTE_HANDOFF_SOURCE ??
    new URL('../src/renderer/App.tsx', import.meta.url),
);
function attribute(tag: string, name: string) {
  const element = findNode(
    source,
    (node): node is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === tag,
  );
  const attr = findNode(
    element,
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) && node.name.getText() === name,
  );
  assert.ok(
    attr.initializer &&
      ts.isJsxExpression(attr.initializer) &&
      attr.initializer.expression,
  );
  return attr.initializer.expression.getText();
}
function harness(
  initialInbox = true,
  options: { tabs?: TabState[]; snapshots?: Record<string, TreeSnapshot> } = {},
) {
  const tab: TabState = {
    id: 'source',
    connectionId: 'fixture',
    rootKey: 'CAN-1',
    expanded: ['CAN-1'],
    hideDone: false,
    scrollTop: 17,
  };
  const requested = {
    id: 'requested-view',
    name: 'Requested',
    roots: [],
    connectionIds: [],
    filters: {
      assignee: 'any' as const,
      statuses: [],
      priority: '',
      hideDone: false,
    },
    sort: { column: 'key' as const, direction: 'asc' as const },
  };
  let workspace: Workspace = {
    tabs: options.tabs ?? [tab],
    activeTabId: tab.id,
    savedViews: [requested],
    activeSavedViewId: 'previous-view',
    shortcuts: {},
    theme: 'dark',
    sidebarCollapsed: false,
  };
  let inboxOpen = initialInbox;
  let selected: unknown = { connectionId: 'fixture', key: 'OLD-1' };
  let dialog: unknown = 'commands';
  let reveal: unknown;
  let history = { back: [] as TabState[], forward: [] as TabState[] };
  const workspaceRef = { current: workspace };
  const navigationReveal = { current: undefined as unknown };
  const pendingScrollRestore = { current: undefined as unknown };
  const setters = {
    setInboxOpen: (value: boolean) => {
      inboxOpen = value;
    },
    setSelectedViewIssue: (value: unknown) => {
      selected = value;
    },
    setWorkspace: (update: (value: Workspace) => Workspace) => {
      workspace = update(workspace);
      workspaceRef.current = workspace;
    },
    setDialog: (value: unknown) => {
      dialog = value;
    },
  };
  const navigate = execute(callback(source, 'navigate'), {
    useCallback: (fn: unknown) => fn,
    ...setters,
    workspaceRef,
    setHistory: (value: typeof history) => {
      history = value;
    },
    historyRef: { current: history },
    visit,
    sameRoot,
    activateTab,
    pendingScrollRestore,
  });
  const openTab = execute(callback(source, 'openTab'), {
    useCallback: (fn: unknown) => fn,
    ...setters,
    workspaceRef,
    navigate,
    connections: [{ id: 'fixture', provider: 'jira' }],
  });
  const palette = execute(attribute('CommandDialog', 'onNavigate'), {
    ...setters,
    openTab,
    navigate,
    paletteIssueTab,
    workspaceRef,
    sameRoot,
    snapshots: {},
    viewSnapshots: options.snapshots ?? {},
    navigationReveal,
    setReveal: (value: unknown) => {
      reveal = value;
    },
  });
  const sidebar = execute(attribute('SidebarWork', 'onSelectView'), setters);
  const visible = () =>
    execute(callback(source, 'activeSavedView'), {
      inboxOpen,
      inboxView: { id: 'triage-inbox' },
      workspace,
    });
  let persisted: Workspace | undefined;
  const save = execute(callback(source, 'saveWorkspace'), {
    useCallback: (fn: unknown) => fn,
    demoResetting: { current: false },
    pendingWorkspaceSave: { current: Promise.resolve() },
    window: {
      canopy: {
        saveWorkspace: async (value: Workspace) => {
          persisted = JSON.parse(JSON.stringify(value));
        },
      },
    },
  });
  return {
    persist: async () => {
      await save(workspace);
      return persisted!;
    },
    tab,
    requested,
    palette,
    sidebar,
    visible,
    state: () => ({
      inboxOpen,
      workspace,
      selected,
      dialog,
      reveal,
      navigationReveal: navigationReveal.current,
      pendingScrollRestore: pendingScrollRestore.current,
    }),
  };
}

for (const inbox of [true, false]) {
  test(`actual palette saved-view handoff displays requested view from ${inbox ? 'Inbox' : 'root'}`, () => {
    const h = harness(inbox);
    h.palette({ target: { type: 'Saved view', viewId: h.requested.id } });
    assert.equal(h.visible(), h.requested);
    assert.equal(h.state().workspace.activeSavedViewId, h.requested.id);
    assert.equal(h.state().inboxOpen, false);
    assert.equal(h.state().selected, null);
    assert.equal(h.state().dialog, null);
    assert.equal(h.state().workspace.activeTabId, h.tab.id);
    assert.equal(h.state().workspace.tabs[0], h.tab);
  });
}

test('actual sidebar saved-view handoff agrees with palette visibility and selection', () => {
  const h = harness();
  h.sidebar(h.requested.id);
  assert.equal(h.visible(), h.requested);
  assert.equal(h.state().inboxOpen, false);
  assert.equal(h.state().selected, null);
  assert.equal(h.state().dialog, 'commands');
});

for (const type of ['Open root', 'Recent root']) {
  test(`actual palette ${type} handoff exits Inbox and restores existing root identity`, () => {
    const h = harness();
    h.palette({
      target: { type, root: { connectionId: 'fixture', rootKey: 'can-1' } },
    });
    assert.equal(h.state().inboxOpen, false);
    assert.equal(h.visible(), undefined);
    assert.equal(h.state().workspace.activeSavedViewId, null);
    assert.equal(h.state().workspace.activeTabId, h.tab.id);
    assert.equal(h.state().pendingScrollRestore, h.tab.id);
    assert.equal(h.state().dialog, null);
  });
}

test('actual palette loaded-issue handoff exits Inbox and retains reveal and scroll restoration', () => {
  const h = harness();
  h.palette({ target: { type: 'Loaded issue', tab: h.tab, key: 'CAN-2' } });
  assert.equal(h.state().inboxOpen, false);
  assert.equal(h.visible(), undefined);
  assert.equal(h.state().workspace.activeSavedViewId, null);
  assert.equal(h.state().workspace.tabs[0].selectedKey, 'CAN-2');
  assert.deepEqual(h.state().reveal, { tabId: h.tab.id, key: 'CAN-2' });
  assert.deepEqual(h.state().navigationReveal, h.state().reveal);
  assert.equal(h.state().pendingScrollRestore, h.tab.id);
  assert.equal(h.state().dialog, null);
});

for (const provider of ['jira', 'github'] as const) {
  for (const existing of [false, true]) {
    test(`actual palette persists a real ${provider} tab for saved-only loaded issue, existing root=${existing}`, async () => {
      const rootKey = provider === 'github' ? 'owner/repo#1' : 'CAN-1';
      const key = provider === 'github' ? 'owner/repo#3' : 'CAN-3';
      const parentKey = provider === 'github' ? 'owner/repo#2' : 'CAN-2';
      const root = { connectionId: `selected-${provider}`, rootKey };
      const view = {
        id: 'saved',
        name: 'Saved',
        roots: [root],
        connectionIds: [],
        filters: {
          assignee: 'any' as const,
          statuses: [],
          priority: '',
          hideDone: false,
        },
        sort: { column: 'key' as const, direction: 'asc' as const },
      };
      const source = viewSources(view, [])[0];
      const sourceTab: TabState = {
        ...source,
        expanded: [rootKey],
        hideDone: false,
        scrollTop: 19,
      };
      const foreign = {
        ...sourceTab,
        id: 'foreign-tab',
        connectionId: 'other-account',
      };
      const opened = { ...sourceTab, id: 'opened-tab', scrollTop: 39 };
      const snapshot: TreeSnapshot = {
        rootKey,
        fetchedAt: 1,
        warnings: [],
        issues: [
          { ...demoSeeds[0], key: rootKey, parentKey: undefined },
          { ...demoSeeds[0], key: parentKey, parentKey: rootKey },
          { ...demoSeeds[0], key, parentKey },
        ],
      };
      const h = harness(true, {
        tabs: existing ? [foreign, opened] : [foreign],
        snapshots: { [source.id]: snapshot },
      });
      const before = JSON.parse(JSON.stringify(h.state().workspace));
      h.palette({ target: { type: 'Loaded issue', tab: sourceTab, key } });
      const persisted = await h.persist();
      const active = persisted.tabs.find(
        (tab) => tab.id === persisted.activeTabId,
      )!;
      assert.ok(active && !active.id.startsWith('saved-view:'));
      if (existing) assert.equal(active.id, opened.id);
      assert.equal(active.connectionId, root.connectionId);
      assert.equal(active.rootKey, rootKey);
      assert.equal(active.selectedKey, key);
      assert.equal(
        active.scrollTop,
        existing ? opened.scrollTop : sourceTab.scrollTop,
      );
      assert.equal(active.focusKey, undefined);
      assert.deepEqual(active.expanded, [rootKey, parentKey, key]);
      assert.deepEqual(
        persisted.tabs.find((tab) => tab.id === foreign.id),
        foreign,
      );
      assert.equal(
        persisted.tabs.length,
        before.tabs.length + (existing ? 0 : 1),
      );
      assert.deepEqual(
        rootView(persisted, active),
        rootView(before, sourceTab),
      );
      assert.equal(h.state().inboxOpen, false);
      assert.equal(persisted.activeSavedViewId, null);
      assert.equal(h.state().dialog, null);
      assert.deepEqual(h.state().reveal, { tabId: active.id, key });
      assert.deepEqual(h.state().navigationReveal, h.state().reveal);
      assert.equal(h.state().pendingScrollRestore, active.id);
      assert.equal(
        sourceTab.id,
        source.id,
        'local snapshot lookup identity stays virtual',
      );
    });
  }
}
