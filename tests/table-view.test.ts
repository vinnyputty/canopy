import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recoverWorkspaceViews, validViewMap } from '../src/shared/views';
import type {
  Issue,
  TabState,
  TreeSnapshot,
  Workspace,
} from '../src/shared/types';
import { buildIssueTree, flattenVisible } from '../src/renderer/tree';
import {
  activateTab,
  closeTabs,
  reopenTab,
  removeConnection,
  travel,
  visit,
} from '../src/renderer/workspace';
import {
  canRank,
  defaultRootView,
  DEFAULT_VIEW,
  migrateViews,
  resetRootView,
  rootView,
  setRootView,
  sortIssueTree,
} from '../src/renderer/table-view';

function issue(
  key: string,
  parentKey?: string,
  extra: Partial<Issue> = {},
): Issue {
  return {
    id: key,
    key,
    parentKey,
    summary: key,
    type: 'Task',
    priority: null,
    assignee: null,
    status: { id: 'new', name: 'New', category: 'new' },
    links: [],
    ...extra,
  };
}
function tab(connectionId: string, rootKey: string): TabState {
  return {
    id: `${connectionId}:${rootKey}`,
    connectionId,
    rootKey,
    expanded: [rootKey],
    hideDone: true,
    scrollTop: 0,
  };
}
function workspace(...tabs: TabState[]): Workspace {
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    shortcuts: {},
    theme: 'system',
    sidebarCollapsed: false,
  };
}
describe('table sorting', () => {
  it('sorts siblings independently while preserving hierarchy and canonical Jira rank', () => {
    const tree = buildIssueTree(
      [
        issue('A-1'),
        issue('A-2', 'A-1', { summary: 'Zulu' }),
        issue('A-3', 'A-1', { summary: 'Alpha' }),
        issue('A-4', 'A-2', { summary: 'Bravo' }),
        issue('A-5', 'A-2', { summary: 'Alpha' }),
      ],
      'A-1',
    )!;
    const sorted = sortIssueTree(tree, { column: 'issue', direction: 'asc' });
    assert.deepEqual(
      flattenVisible(sorted, new Set(['A-1', 'A-2'])).map(
        (node) => node.issue.key,
      ),
      ['A-1', 'A-3', 'A-2', 'A-5', 'A-4'],
    );
    assert.deepEqual(
      tree.children.map((node) => node.issue.key),
      ['A-2', 'A-3'],
    );
    assert.equal(
      sortIssueTree(tree, { column: 'rank', direction: 'asc' }),
      tree,
    );
  });
  it('uses Jira configured priority order and keeps empty values last in both directions', () => {
    const tree = buildIssueTree(
      [
        issue('A-1'),
        issue('A-2', 'A-1'),
        issue('A-3', 'A-1', { priority: { id: 'p9', name: 'Blocker' } }),
        issue('A-4', 'A-1', { priority: { id: 'p1', name: 'Urgent' } }),
      ],
      'A-1',
    )!;
    assert.deepEqual(
      sortIssueTree(tree, { column: 'priority', direction: 'asc' }, [
        'p1',
        'p9',
      ]).children.map((n) => n.issue.key),
      ['A-4', 'A-3', 'A-2'],
    );
    assert.deepEqual(
      sortIssueTree(tree, { column: 'priority', direction: 'desc' }, [
        'p1',
        'p9',
      ]).children.map((n) => n.issue.key),
      ['A-3', 'A-4', 'A-2'],
    );
    assert.equal(
      sortIssueTree(tree, { column: 'priority', direction: 'asc' }),
      tree,
    );
  });
  it('uses natural names, deterministic key ties, and null-last assignees', () => {
    const tree = buildIssueTree(
      [
        issue('A-1'),
        issue('A-2', 'A-1'),
        issue('A-10', 'A-1', { assignee: { id: 'x', name: 'Person 2' } }),
        issue('A-3', 'A-1', { assignee: { id: 'y', name: 'Person 2' } }),
        issue('A-4', 'A-1', { assignee: { id: 'z', name: 'Person 10' } }),
      ],
      'A-1',
    )!;
    assert.deepEqual(
      sortIssueTree(tree, {
        column: 'assignee',
        direction: 'asc',
      }).children.map((n) => n.issue.key),
      ['A-3', 'A-10', 'A-4', 'A-2'],
    );
  });
  it('sorts status names in both directions independently of status category', () => {
    const tree = buildIssueTree(
      [
        issue('A-1'),
        issue('A-2', 'A-1', {
          status: { id: 'z', name: 'Waiting', category: 'new' },
        }),
        issue('A-3', 'A-1', {
          status: { id: 'a', name: 'Closed', category: 'done' },
        }),
      ],
      'A-1',
    )!;
    assert.deepEqual(
      sortIssueTree(tree, { column: 'status', direction: 'asc' }).children.map(
        (node) => node.issue.key,
      ),
      ['A-3', 'A-2'],
    );
    assert.deepEqual(
      sortIssueTree(tree, { column: 'status', direction: 'desc' }).children.map(
        (node) => node.issue.key,
      ),
      ['A-2', 'A-3'],
    );
  });
  it('gates rank writes by root, permissions, capability and active sort', () => {
    const snapshot: TreeSnapshot = {
      rootKey: 'A-1',
      issues: [],
      fetchedAt: 1,
      warnings: [],
      ranking: { state: 'supported', issueKeys: ['A-1', 'A-2'] },
    };
    assert.equal(canRank(snapshot, DEFAULT_VIEW.sort, 'A-2'), true);
    assert.equal(canRank(snapshot, DEFAULT_VIEW.sort, 'A-1'), false);
    assert.equal(canRank(snapshot, DEFAULT_VIEW.sort, 'A-3'), false);
    assert.equal(
      canRank(snapshot, { column: 'status', direction: 'asc' }, 'A-2'),
      false,
    );
    assert.equal(
      canRank({ ...snapshot, ranking: undefined }, DEFAULT_VIEW.sort, 'A-2'),
      false,
    );
    assert.equal(
      canRank(
        { ...snapshot, ranking: { state: 'unknown', issueKeys: [] } },
        DEFAULT_VIEW.sort,
        'A-2',
      ),
      false,
    );
  });
});
describe('persisted table views', () => {
  it('isolates connections, retains closed roots and resets to connection defaults', () => {
    const a = tab('one', 'A-1'),
      b = tab('one', 'A-2'),
      other = tab('github', 'team/a#1');
    let saved = migrateViews(workspace(a, b, other));
    saved = setRootView(saved, a, {
      columns: ['issue', 'status'],
      textSize: 'large',
      hideDone: false,
      filters: { priority: 'p9' },
      widths: { ...DEFAULT_VIEW.widths, status: 96 },
    });
    saved = defaultRootView(saved, a);
    assert.equal(rootView(saved, b).textSize, 'large');
    assert.equal(rootView(saved, b).widths.status, 96);
    assert.equal(saved.tabs[1].hideDone, false);
    assert.deepEqual(saved.tabs[1].filters, { priority: 'p9' });
    assert.equal(rootView(saved, other).textSize, 'medium');
    assert.equal(rootView(saved, other).widths.status, 128);
    saved = setRootView(saved, b, {
      textSize: 'small',
      widths: { ...DEFAULT_VIEW.widths, issue: 650, status: 142 },
      sort: { column: 'status', direction: 'desc' },
      spacing: 'comfortable',
    });
    saved = setRootView(saved, a, { textSize: 'medium' });
    saved = defaultRootView(saved, a);
    assert.equal(rootView(saved, b).textSize, 'small');
    saved = { ...saved, tabs: saved.tabs.filter((t) => t.id !== b.id) };
    saved = JSON.parse(JSON.stringify(saved));
    assert.equal(rootView(saved, b).textSize, 'small');
    assert.equal(rootView(saved, b).widths.issue, 650);
    assert.equal(rootView(saved, b).widths.status, 142);
    assert.deepEqual(rootView(saved, b).sort, {
      column: 'status',
      direction: 'desc',
    });
    assert.equal(rootView(saved, b).spacing, 'comfortable');
    saved = resetRootView(saved, b);
    assert.equal(rootView(saved, b).textSize, 'medium');
    assert.equal(rootView(saved, b).widths.status, 96);
    assert.deepEqual(rootView(saved, b).filters, { priority: 'p9' });
  });
  it('migrates legacy filters without making untouched roots override defaults', () => {
    const a = tab('one', 'A-1'),
      b = tab('one', 'A-2');
    a.hideDone = false;
    a.filters = { status: 's1' };
    const migrated = migrateViews(workspace(a, b));
    assert.equal(Object.keys(migrated.rootViews!).length, 1);
    assert.equal(rootView(migrated, a).hideDone, false);
    assert.deepEqual(rootView(migrated, a).filters, { status: 's1' });
    assert.deepEqual(migrateViews(migrated), migrated);
  });
});

describe('table view persistence validation', () => {
  it('rejects malformed columns, widths, sorting, density and filters', () => {
    assert.equal(validViewMap({ root: DEFAULT_VIEW }), true);
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...DEFAULT_VIEW, columns: ['status', 'issue'] },
      { ...DEFAULT_VIEW, columns: ['issue', 'status', 'status'] },
      { ...DEFAULT_VIEW, columns: ['issue', '__proto__'] },
      { ...DEFAULT_VIEW, widths: { ...DEFAULT_VIEW.widths, issue: Infinity } },
      { ...DEFAULT_VIEW, widths: { ...DEFAULT_VIEW.widths, priority: 79 } },
      { ...DEFAULT_VIEW, widths: { ...DEFAULT_VIEW.widths, status: 481 } },
      { ...DEFAULT_VIEW, sort: { column: 'updated', direction: 'asc' } },
      { ...DEFAULT_VIEW, sort: { column: 'rank', direction: 'sideways' } },
      { ...DEFAULT_VIEW, textSize: 'huge' },
      { ...DEFAULT_VIEW, spacing: 'huge' },
      { ...DEFAULT_VIEW, filters: { assignee: 'someone' } },
      { ...DEFAULT_VIEW, filters: { status: 5 } },
      { ...DEFAULT_VIEW, filters: { surprise: 'value' } },
    ];
    for (const view of invalid)
      assert.equal(validViewMap({ root: view }), false, JSON.stringify(view));
    assert.equal(validViewMap([]), false);
  });
  it('recovers only invalid view entries and retains tabs and valid defaults', () => {
    const current = workspace(tab('one', 'A-1'));
    const saved = {
      ...current,
      rootViews: { good: DEFAULT_VIEW, bad: null },
      viewDefaults: { one: DEFAULT_VIEW },
    } as unknown as Workspace;
    const recovered = recoverWorkspaceViews(saved);
    assert.deepEqual(recovered.rootViews, { good: DEFAULT_VIEW });
    assert.deepEqual(recovered.viewDefaults, saved.viewDefaults);
    assert.equal(recovered.tabs, current.tabs);
    assert.equal(saved.rootViews!.bad, null);
  });
});

describe('table views and navigation snapshots', () => {
  it('restores a full historical view into overrides and keeps it through unrelated edits and restart', () => {
    const a = tab('one', 'A-1'),
      b = tab('one', 'A-2');
    let current = migrateViews(workspace(a, b));
    current = setRootView(current, a, {
      filters: { status: 'progress', priority: '2', assignee: 'me' },
      hideDone: false,
      textSize: 'large',
      columns: ['issue', 'status'],
      widths: { ...DEFAULT_VIEW.widths, issue: 700 },
      sort: { column: 'status', direction: 'desc' },
      spacing: 'comfortable',
    });
    const saved = current.tabs[0];
    const history = visit({ back: [], forward: [] }, saved, b);
    current = setRootView(current, a, {
      filters: {},
      hideDone: true,
      textSize: 'small',
    });
    const restored = travel(history, b, 'back').tab!;
    current = activateTab(current, restored);
    assert.deepEqual(rootView(current, a), saved.view);
    current = setRootView(current, b, { spacing: 'comfortable' });
    current = migrateViews(JSON.parse(JSON.stringify(current)));
    assert.deepEqual(current.tabs[0].filters, saved.filters);
    assert.deepEqual(rootView(current, a), saved.view);
    current = closeTabs(current, [a.id]);
    current = setRootView(current, a, { textSize: 'small', filters: {} });
    current = reopenTab(current);
    assert.deepEqual(rootView(current, a), saved.view);
  });
  it('migrates closed legacy tabs, preferring the open state for a duplicate root', () => {
    const closed = {
      ...tab('one', 'A-1'),
      filters: { status: 'done' },
      hideDone: false,
    };
    let current = migrateViews({ ...workspace(), closedTabs: [closed] });
    assert.deepEqual(rootView(current, closed).filters, closed.filters);
    current = reopenTab(current);
    current = setRootView(current, current.tabs[0], { textSize: 'large' });
    assert.deepEqual(
      migrateViews(JSON.parse(JSON.stringify(current))).tabs[0].filters,
      closed.filters,
    );
    const duplicate = migrateViews({
      ...workspace(tab('one', 'A-1')),
      closedTabs: [closed],
    });
    assert.equal(rootView(duplicate, closed).hideDone, true);
    assert.deepEqual(rootView(duplicate, closed).filters, {});
    assert.deepEqual(duplicate.rootViews, {});
  });
  it('keeps normal selection inherited and removes only disconnected connection views', () => {
    const a = tab('one', 'A-1'),
      b = tab('two', 'A-1');
    let current = migrateViews(workspace(a, b));
    current = activateTab(current, a, false);
    assert.deepEqual(current.rootViews, {});
    current = setRootView(current, a, { textSize: 'large' });
    current = defaultRootView(current, a);
    current = setRootView(current, b, { textSize: 'small' });
    current = defaultRootView(current, b);
    current = removeConnection(current, 'one');
    assert.equal(current.viewDefaults?.one, undefined);
    assert.equal(Object.keys(current.rootViews!).length, 1);
    assert.equal(rootView(current, b).textSize, 'small');
    assert.equal(rootView(current, a).textSize, 'medium');
  });
  it('rejects malformed saved tab containers with a workspace error', () => {
    for (const value of [
      { tabs: null },
      { tabs: [null] },
      { tabs: [], closedTabs: {} },
      { tabs: [], closedTabs: [null] },
    ])
      assert.throws(
        () => recoverWorkspaceViews(value as unknown as Workspace),
        /Invalid saved workspace/,
      );
  });
  it('recovers invalid view snapshots in both open and closed tabs', () => {
    const a = { ...tab('one', 'A-1'), view: { ...DEFAULT_VIEW, columns: [] } };
    const recovered = recoverWorkspaceViews({
      ...workspace(a),
      closedTabs: [a],
    });
    assert.equal(recovered.tabs[0].view, undefined);
    assert.equal(recovered.closedTabs?.[0].view, undefined);
    assert.equal(recovered.tabs[0].rootKey, 'A-1');
  });
});
