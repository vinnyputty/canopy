import assert from 'node:assert/strict';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connection, RootReference, Workspace } from '../src/shared/types';
import { SidebarWork } from '../src/renderer/SidebarWork';
import {
  forgetSidebarConnections,
  captureSidebar,
  emptySidebarSession,
  organizeSidebar,
  restoreSidebar,
  rootIdentity,
  sidebarRoots,
} from '../src/renderer/sidebar-organization';
import { DEFAULT_VIEW } from '../src/renderer/table-view';
import {
  configuredRoots,
  starterViews,
  viewSources,
} from '../src/renderer/saved-views';

const root = (rootKey: string, connectionId = 'one'): RootReference => ({
  connectionId,
  rootKey,
  summary: `Summary ${rootKey}`,
});
const roots = [root('A-1'), root('A-1', 'two'), root('B-1')];
const initial = (): Workspace => ({
  tabs: roots.map((item, index) => ({
    ...item,
    id: String(index),
    expanded: [item.rootKey],
    linkedExpanded: ['C-1'],
    selectedKey: 'C-1',
    focusKey: 'C-1',
    scrollTop: 345,
    hideDone: true,
    view: DEFAULT_VIEW,
  })),
  activeTabId: '1',
  activeSavedViewId: 'assigned-to-me',
  pinnedRoots: roots,
  recentRoots: roots,
  rootViews: { [rootIdentity(roots[0])]: DEFAULT_VIEW },
  savedViews: [{ ...starterViews()[0], roots, connectionIds: ['one'] }],
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
});
it('orders favorites by connection and root, persists order, and preserves all live view state through Undo', () => {
  const before = initial();
  let result = organizeSidebar(before, emptySidebarSession(), {
    type: 'move',
    root: roots[1],
    direction: -1,
  });
  assert.deepEqual(result.workspace.pinnedRoots, [
    roots[1],
    roots[0],
    roots[2],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.workspace)).pinnedRoots, [
    roots[1],
    roots[0],
    roots[2],
  ]);
  assert.equal(result.workspace.tabs, before.tabs);
  assert.equal(result.workspace.activeTabId, before.activeTabId);
  assert.equal(result.workspace.activeSavedViewId, before.activeSavedViewId);
  assert.equal(result.workspace.rootViews, before.rootViews);
  assert.equal(result.workspace.savedViews, before.savedViews);
  const refreshed = {
    ...result.workspace,
    tabs: result.workspace.tabs.map((tab) => ({
      ...tab,
      selectedKey: 'NEW-1',
      scrollTop: 678,
    })),
    recentRoots: [root('NEW-1')],
    pinnedRoots: result.workspace.pinnedRoots?.map((item) => ({
      ...item,
      summary: 'Refreshed',
    })),
  };
  result = organizeSidebar(refreshed, result.session, { type: 'undo' });
  assert.deepEqual(
    result.workspace.pinnedRoots?.map(rootIdentity),
    roots.map(rootIdentity),
  );
  assert.equal(result.workspace.pinnedRoots?.[0].summary, 'Refreshed');
  assert.equal(result.workspace.tabs, refreshed.tabs);
  assert.equal(result.workspace.recentRoots, refreshed.recentRoots);
});
it('parks only one connection’s root, retaining tabs, root overrides, recents, and saved-view sources', () => {
  const before = initial();
  const available = configuredRoots(before, []);
  const sources = viewSources(before.savedViews![0], available);
  let result = organizeSidebar(before, emptySidebarSession(), {
    type: 'park',
    root: roots[0],
  });
  assert.equal(result.workspace, before);
  assert.deepEqual(
    sidebarRoots(result.workspace, result.session).active.map(rootIdentity),
    [roots[1], roots[2]].map(rootIdentity),
  );
  assert.deepEqual(sidebarRoots(result.workspace, result.session).pinned, [
    roots[1],
    roots[2],
  ]);
  assert.deepEqual(sidebarRoots(result.workspace, result.session).recent, [
    roots[1],
    roots[2],
  ]);
  assert.deepEqual(
    viewSources(
      result.workspace.savedViews![0],
      configuredRoots(result.workspace, []),
    ),
    sources,
  );
  assert.deepEqual(sidebarRoots(before, emptySidebarSession()).parked, []);
  result = organizeSidebar(result.workspace, result.session, {
    type: 'restore',
    root: roots[0],
  });
  assert.deepEqual(result.session.parked, []);
  result = organizeSidebar(result.workspace, result.session, { type: 'undo' });
  assert.deepEqual(result.session.parked, [roots[0]]);
  result = organizeSidebar(result.workspace, result.session, { type: 'undo' });
  assert.deepEqual(result.session.parked, []);
  assert.equal(result.workspace, before);
});
it('supports a stack of pin, unpin, reorder, park and restore without changing tab selection or scrolling', () => {
  const before = initial();
  let result = { workspace: before, session: emptySidebarSession() };
  for (const action of [
    { type: 'pin' as const, root: roots[0] },
    { type: 'pin' as const, root: root('D-1') },
    { type: 'move' as const, root: roots[2], direction: -1 as const },
    { type: 'park' as const, root: roots[1] },
    { type: 'restore' as const, root: roots[1] },
  ])
    result = organizeSidebar(result.workspace, result.session, action);
  for (let index = 0; index < 5; index++)
    result = organizeSidebar(result.workspace, result.session, {
      type: 'undo',
    });
  assert.deepEqual(result.workspace, before);
  assert.deepEqual(result.session.parked, []);
  assert.equal(result.workspace.tabs, before.tabs);
});
it('skips parked favorites when moving and ignores invalid and boundary moves', () => {
  const before = initial();
  let result = organizeSidebar(before, emptySidebarSession(), {
    type: 'park',
    root: roots[1],
  });
  result = organizeSidebar(result.workspace, result.session, {
    type: 'move',
    root: roots[0],
    direction: 1,
  });
  assert.deepEqual(sidebarRoots(result.workspace, result.session).pinned, [
    roots[2],
    roots[0],
  ]);
  for (const item of [roots[0], root('missing')]) {
    const unchanged = organizeSidebar(result.workspace, result.session, {
      type: 'move',
      root: item,
      direction: 1,
    });
    assert.equal(unchanged.workspace, result.workspace);
    assert.equal(unchanged.session, result.session);
  }
  const refreshed = {
    ...result.workspace,
    tabs: result.workspace.tabs.map((tab) => ({
      ...tab,
      summary: 'New title',
    })),
  };
  assert.equal(
    sidebarRoots(refreshed, result.session).parked[0].summary,
    'New title',
  );
});

it('restores focus by stable action identity, falls back to the same root, and restores sidebar scroll after focus', () => {
  let scrollTop = 211;
  const first = {
    dataset: { sidebarFocus: 'active:open', sidebarRoot: 'root' },
    disabled: false,
    focus: () => {
      throw new Error('Wrong root');
    },
  };
  const open = {
    dataset: { sidebarFocus: 'pinned:open', sidebarRoot: 'root' },
    disabled: false,
    focus: (options: { preventScroll: boolean }) => {
      assert.equal(options.preventScroll, true);
      scrollTop = 0;
      focused = open;
    },
  };
  const move = {
    dataset: { sidebarFocus: 'pinned:move', sidebarRoot: 'root' },
    disabled: false,
    focus: open.focus,
  };
  let focused = move;
  const body = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
    ownerDocument: {
      get activeElement() {
        return focused;
      },
    },
    contains: () => true,
    querySelectorAll: () => [first, open, move],
  } as unknown as HTMLElement;
  const position = captureSidebar(body);
  assert.deepEqual(position, {
    scrollTop: 211,
    focus: 'pinned:move',
    root: 'root',
  });
  move.focus = (options) => {
    assert.equal(options.preventScroll, true);
    focused = move;
    scrollTop = 0;
  };
  restoreSidebar(body, position);
  assert.equal(focused, move);
  assert.equal(scrollTop, 211);
  move.disabled = true;
  restoreSidebar(body, position);
  assert.equal(focused, open);
  assert.equal(scrollTop, 211);
  const outside = { scrollTop: 55 };
  restoreSidebar(body, outside);
  assert.equal(focused, open);
  assert.equal(scrollTop, 55);
});

it('renders named navigation, compact counts, connection context, current state, and native buttons for every action', () => {
  const workspace = initial();
  workspace.activeSavedViewId = null;
  workspace.recentRoots = [...roots, root('D-1')];
  const session = organizeSidebar(workspace, emptySidebarSession(), {
    type: 'park',
    root: roots[2],
  }).session;
  const html = renderToStaticMarkup(
    React.createElement(SidebarWork, {
      workspace,
      session,
      connections: [
        { id: 'one', name: 'Team One', provider: 'jira' },
        { id: 'two', name: 'Team Two', provider: 'github' },
      ] as Connection[],
      onOrganize: () => {},
      onOpen: () => {},
      onSelectTab: () => {},
      onSelectView: () => {},
      onCreateView: () => {},
      onOpenPicker: () => {},
    }),
  );
  for (const name of [
    'Active tabs',
    'Pinned roots',
    'Saved views',
    'Recent roots',
    'Parked roots',
  ])
    assert.ok(html.includes(`<nav aria-label="${name}">`));
  for (const label of [
    'Pin',
    'Unpin',
    'Move favorite up',
    'Move favorite down',
    'Park for this session',
    'Restore to sidebar',
    'Undo park B-1',
    'Open issue',
    'Create saved view',
  ])
    assert.ok(html.includes(`aria-label="${label}`), label);
  assert.match(html, /aria-label="2 items"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /GitHub · Team Two/);
  assert.match(html, /Jira · Team One/);
  assert.match(html, /role="status"/);
  assert.match(html, /Parking lasts until restart/);
  assert.doesNotMatch(html, /tabindex="-1"/);
});

it('disconnecting clears Undo and only that connection’s parked roots', () => {
  const before = initial();
  let result = organizeSidebar(before, emptySidebarSession(), {
    type: 'park',
    root: roots[0],
  });
  result = organizeSidebar(result.workspace, result.session, {
    type: 'park',
    root: roots[1],
  });
  result = organizeSidebar(result.workspace, result.session, {
    type: 'pin',
    root: roots[0],
  });
  const cleaned = forgetSidebarConnections(result.session, ['one']);
  assert.deepEqual(cleaned.parked, [roots[1]]);
  assert.deepEqual(cleaned.undo, []);
  assert.equal(
    organizeSidebar(result.workspace, cleaned, { type: 'undo' }).workspace,
    result.workspace,
  );
  assert.equal(forgetSidebarConnections(result.session, []), result.session);
});
