import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TabState, Workspace } from '../src/shared/types';
import {
  activateTab,
  closeTabs,
  rememberRoot,
  removeConnection,
  reorderTab,
  reopenTab,
  togglePinned,
  travel,
  visit,
} from '../src/renderer/workspace';
import { restoreWindow, type WindowState } from '../src/main/window-state';

const tab = (id: string, connectionId = 'site'): TabState => ({
  id,
  connectionId,
  rootKey: `CAN-${id}`,
  expanded: [`CAN-${id}`],
  hideDone: true,
  scrollTop: 0,
});
const initial = (): Workspace => ({
  tabs: [tab('1'), tab('2'), tab('3')],
  activeTabId: '2',
  theme: 'system',
  shortcuts: {},
  sidebarCollapsed: false,
});

describe('workspace restoration', () => {
  it('reorders without changing active selection, and ignores invalid drags', () => {
    const current = initial();
    const next = reorderTab(current, '1', '3');
    assert.deepEqual(
      next.tabs.map((item) => item.id),
      ['2', '3', '1'],
    );
    assert.equal(next.activeTabId, '2');
    assert.equal(reorderTab(current, 'missing', '2'), current);
  });
  it('leaves empty restore/navigation and unknown closes unchanged', () => {
    const current = initial();
    assert.equal(reopenTab(current), current);
    assert.equal(closeTabs(current, ['missing']), current);
    assert.equal(reorderTab(current, '1', '1'), current);
    assert.equal(reorderTab(current, '1', 'missing'), current);
    const history = { back: [], forward: [] };
    assert.deepEqual(travel(history, tab('1'), 'back'), { history });
    assert.deepEqual(travel(history, undefined, 'forward'), { history });
  });
  it('unpins only the matching site and root without closing its tab', () => {
    const current = initial();
    const pinned = togglePinned(
      togglePinned(current, tab('1')),
      tab('1', 'other-site'),
    );
    const next = togglePinned(pinned, tab('1'));
    assert.deepEqual(
      next.pinnedRoots?.map((root) => root.connectionId),
      ['other-site'],
    );
    assert.equal(next.tabs, current.tabs);
    assert.equal(next.activeTabId, current.activeTabId);
  });
  it('keeps favorites independent from closed tabs and restores every tab field', () => {
    const current = initial();
    const saved = {
      ...current.tabs[1],
      expanded: ['CAN-2', 'CAN-20'],
      linkedExpanded: ['CAN-21'],
      selectedKey: 'CAN-22',
      scrollTop: 347,
      hideDone: false,
      filters: { status: 'todo', priority: 'high' },
      focusKey: 'CAN-22',
    };
    current.tabs[1] = saved;
    const closed = closeTabs(togglePinned(current, saved), ['2']);
    assert.equal(closed.pinnedRoots?.[0].rootKey, 'CAN-2');
    assert.equal(closed.activeTabId, '3');
    const restored = reopenTab(JSON.parse(JSON.stringify(closed)));
    assert.deepEqual(restored.tabs.at(-1), saved);
    assert.equal(restored.activeTabId, '2');
    assert.deepEqual(restored.closedTabs, []);
  });
  it('reopens bulk-closed tabs in reverse visual order and caps closed history', () => {
    const current = initial();
    current.tabs = Array.from({ length: 30 }, (_, index) => tab(String(index)));
    const closed = closeTabs(
      current,
      current.tabs.map((item) => item.id),
    );
    assert.equal(closed.activeTabId, null);
    assert.equal(closed.closedTabs?.length, 20);
    const restored = reopenTab(reopenTab(closed));
    assert.deepEqual(
      restored.tabs.map((item) => item.id),
      ['29', '28'],
    );
  });
  it('restores an already reopened root without creating duplicate tabs', () => {
    const current = closeTabs(initial(), ['2']);
    const opened = activateTab(current, { ...tab('2'), id: 'new-id' });
    const restored = reopenTab(opened);
    assert.equal(restored.tabs.length, 3);
    assert.equal(restored.activeTabId, 'new-id');
  });
  it('deduplicates recents by site and root and caps them at twenty', () => {
    let current = initial();
    for (let id = 0; id < 30; id++)
      current = rememberRoot(current, tab(String(id)));
    current = rememberRoot(current, tab('29', 'other-site'));
    current = rememberRoot(current, tab('29'));
    assert.equal(current.recentRoots?.length, 20);
    assert.deepEqual(
      current.recentRoots?.slice(0, 2).map((item) => item.connectionId),
      ['site', 'other-site'],
    );
  });
  it('removes all saved root data for a disconnected site while retaining other sites', () => {
    let current = initial();
    current.tabs.push(tab('4', 'other-site'));
    current = closeTabs(
      togglePinned(rememberRoot(current, tab('1')), tab('1')),
      ['1'],
    );
    const next = removeConnection(current, 'site');
    assert.deepEqual(
      next.tabs.map((item) => item.id),
      ['4'],
    );
    assert.equal(next.activeTabId, '4');
    assert.deepEqual(next.pinnedRoots, []);
    assert.deepEqual(next.recentRoots, []);
    assert.deepEqual(next.closedTabs, []);
  });
  it('restores visited position in either direction and discards the forward branch after a new visit', () => {
    const from = {
      ...tab('1'),
      scrollTop: 212,
      selectedKey: 'CAN-10',
      linkedExpanded: ['CAN-1'],
      filters: { status: 'todo', priority: 'high' },
      focusKey: 'CAN-10',
    };
    const to = { ...tab('2'), scrollTop: 90 };
    const history = visit({ back: [], forward: [] }, from, to);
    const back = travel(history, to, 'back');
    assert.deepEqual(back.tab, from);
    const forward = travel(back.history, from, 'forward');
    assert.deepEqual(forward.tab, to);
    assert.deepEqual(visit(back.history, from, tab('3')).forward, []);
    assert.equal(visit(history, from, { ...from, scrollTop: 999 }), history);
  });
});

describe('window restoration', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 };
  it('rejects absent displays, absent state, and nonfinite geometry', () => {
    assert.equal(restoreWindow(null, [primary]), null);
    assert.equal(
      restoreWindow({ bounds: primary, maximized: false }, []),
      null,
    );
    assert.equal(
      restoreWindow({ bounds: { ...primary, x: NaN }, maximized: false }, [
        primary,
      ]),
      null,
    );
    assert.equal(
      restoreWindow(
        { bounds: { ...primary, height: Infinity }, maximized: false },
        [primary],
      ),
      null,
    );
  });
  it('clamps a removed monitor to the primary work area', () => {
    assert.deepEqual(
      restoreWindow(
        {
          bounds: { x: 2200, y: 50, width: 1600, height: 1000 },
          maximized: true,
        },
        [primary],
      ),
      { bounds: { x: 0, y: 0, width: 1440, height: 900 }, maximized: true },
    );
  });
  it('rejects missing geometry fields and respects work areas smaller than minimum size', () => {
    assert.equal(
      restoreWindow({ bounds: {}, maximized: false } as WindowState, [primary]),
      null,
    );
    const small = { x: 0, y: 0, width: 800, height: 500 };
    assert.deepEqual(
      restoreWindow(
        {
          bounds: { x: 50, y: 60, width: 1000, height: 800 },
          maximized: false,
        },
        [small],
      )?.bounds,
      small,
    );
  });
  it('keeps valid negative monitor positions and rejects invalid saved sizes', () => {
    const saved = {
      bounds: { x: -1200, y: 20, width: 1000, height: 650 },
      maximized: false,
    };
    assert.deepEqual(
      restoreWindow(saved, [primary, { ...primary, x: -1440 }]),
      saved,
    );
    assert.equal(
      restoreWindow({ ...saved, bounds: { ...saved.bounds, width: -2 } }, [
        primary,
      ]),
      null,
    );
  });
});
