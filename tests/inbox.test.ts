import { DEFAULT_VIEW } from '../src/renderer/table-view';
import {
  emptySidebarSession,
  organizeSidebar,
} from '../src/renderer/sidebar-organization';
import { activateTab } from '../src/renderer/workspace';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type {
  CanopyAPI,
  Connection,
  Issue,
  IssueRelationships,
  TreeSnapshot,
  Workspace,
} from '../src/shared/types';
import {
  changeTriage,
  emptyTriage,
  MAX_TRIAGE_HISTORY,
  MAX_TRIAGE_ITEMS,
  recoverTriage,
  TRIAGE_RETENTION,
  triageIdentity,
  validTriage,
} from '../src/shared/triage';
import { recoverWorkspaceViews } from '../src/shared/views';
import {
  inboxCandidates,
  inboxItems,
  InboxInspection,
  type InboxCandidate,
  type InboxGraph,
} from '../src/renderer/inbox';
import { configuredRoots, type ViewSource } from '../src/renderer/saved-views';
import { removeConnection } from '../src/renderer/workspace';
import { issueFields, markIssueSeen, seenRootKey } from '../src/renderer/seen';
const connections: Connection[] = [
  { id: 'a', name: 'Work', url: 'https://example.invalid', provider: 'github' },
  {
    id: 'b',
    name: 'Personal',
    url: 'https://example.invalid',
    provider: 'jira',
  },
];
const base: Workspace = {
  tabs: [],
  activeTabId: null,
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
};
const source = (connectionId = 'a', rootKey = 'org/repo#1'): ViewSource => ({
  id: JSON.stringify([connectionId, rootKey]),
  connectionId,
  rootKey,
});
const issue = (key = 'org/repo#1', patch: Partial<Issue> = {}): Issue => ({
  id: key,
  key,
  summary: key,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
  linksAvailable: true,
  ...patch,
});
const snapshot = (
  rootKey: string,
  issues: Issue[],
  fetchedAt = 100,
): TreeSnapshot => ({ rootKey, issues, fetchedAt, warnings: [] });
const blocked = (key: string): IssueRelationships => ({
  key,
  groups: [
    {
      kind: 'blockers',
      state: 'partial',
      reason: 'Page limit',
      items: [
        {
          key: 'org/repo#9',
          summary: 'Blocker',
          relationship: 'blocked by',
          direction: 'inward',
          statusCategory: 'new',
          access: 'available',
        },
      ],
    },
  ],
});
function sample(count = 1): InboxCandidate[] {
  const root = source();
  return inboxCandidates(
    [root],
    {
      [root.id]: snapshot(
        root.rootKey,
        Array.from({ length: count }, (_, i) =>
          issue(
            i ? `org/repo#${i + 1}` : root.rootKey,
            i ? { parentKey: root.rootKey } : {},
          ),
        ),
      ),
    },
    connections,
  );
}
it('combines confirmed reasons, preserves account/root identity and handles unknown GitHub blockers honestly', () => {
  const roots = [source(), source('b')];
  const current = issue(undefined, {
    summary: 'Changed',
    assignee: { id: 'me', name: 'Me' },
    status: { id: 'review', name: 'Review', category: 'indeterminate' },
    updated: '2026-10-01T10:00:00Z',
  });
  const snapshots = Object.fromEntries(
    roots.map((root) => [root.id, snapshot(root.rootKey, [current])]),
  );
  const workspace: Workspace = {
    ...base,
    triage: { ...emptyTriage(), reviewStatuses: { a: ['Review'] } },
    seenRoots: {
      [seenRootKey('a', roots[0].rootKey)]: {
        touchedAt: 1,
        issues: {
          [current.key]: {
            seenAt: 1,
            fields: { ...issueFields(current), Summary: 'Old' },
          },
        },
      },
    },
  };
  const candidates = inboxCandidates(roots, snapshots, connections);
  let items = inboxItems(
    candidates,
    workspace,
    connections,
    snapshots,
    { a: { id: 'me' } },
    {},
    100,
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reasons, [
    'Unread changes',
    'Assigned to you',
    'Review: Review',
  ]);
  assert.equal(items[0].blockerUnknown, true);
  const graph = {
    [triageIdentity('a', current.key)]: {
      stamp: candidates[0].stamp,
      graph: blocked(current.key),
    },
  };
  items = inboxItems(
    candidates,
    workspace,
    connections,
    snapshots,
    { a: { id: 'me' } },
    graph,
    100,
  );
  assert.ok(items[0].reasons.includes('Blocked by org/repo#9'));
  assert.ok(items[0].blockerUnknown);
  assert.equal(
    inboxItems(candidates, { ...base }, connections, snapshots, {}, {}, 100)
      .length,
    0,
    'unidentified account cannot match unassigned issues',
  );
  assert.equal(
    inboxItems(
      candidates,
      base,
      connections,
      snapshots,
      {},
      {
        [triageIdentity('a', current.key)]: {
          stamp: 'stale',
          graph: blocked(current.key),
        },
      },
      100,
    ).length,
    0,
  );
});
it('uses newest confirmed overlapping root, keeps contexts and marks seen via existing baselines', () => {
  const roots = [source(), source('a', 'org/repo#2')];
  const child = issue('org/repo#3', {
    parentKey: roots[0].rootKey,
    summary: 'Fresh',
  });
  const snapshots = {
    [roots[0].id]: snapshot(roots[0].rootKey, [issue(), child], 200),
    [roots[1].id]: snapshot(
      roots[1].rootKey,
      [
        issue(roots[1].rootKey),
        { ...child, parentKey: roots[1].rootKey, summary: 'Stale' },
      ],
      100,
    ),
  };
  const candidates = inboxCandidates(roots, snapshots, connections);
  const result = candidates.find((item) => item.issue.key === child.key)!;
  assert.equal(result.issue.summary, 'Fresh');
  assert.equal(result.fetchedAt, 200);
  assert.equal(result.roots.length, 2);
  const seenRoots: NonNullable<Workspace['seenRoots']> = Object.fromEntries(
    roots.map((root) => [
      seenRootKey(root.connectionId, root.rootKey),
      {
        touchedAt: 1,
        issues: { [child.key]: { seenAt: 1, fields: { Summary: 'Old' } } },
      },
    ]),
  );
  const workspace = { ...base, seenRoots };
  assert.equal(
    inboxItems(candidates, workspace, connections, snapshots, {}, {}, 200)
      .length,
    1,
  );
  for (const root of result.roots) {
    const key = seenRootKey(root.connectionId, root.rootKey);
    seenRoots[key] = markIssueSeen(seenRoots[key], child, 201);
  }
  assert.equal(
    inboxItems(candidates, workspace, connections, snapshots, {}, {}, 201)
      .length,
    0,
  );
});
it('keeps completed unread changes, snoozes pinned items and expires at the exact boundary', () => {
  const root = source();
  const completed = issue(undefined, {
    status: { id: 'done', name: 'Done', category: 'done' },
  });
  const snapshots = { [root.id]: snapshot(root.rootKey, [completed]) };
  const candidates = inboxCandidates([root], snapshots, connections);
  const triage = changeTriage(
    changeTriage(undefined, 'a', root.rootKey, 'pin', 100),
    'a',
    root.rootKey,
    'snooze',
    100,
    1000,
  );
  const workspace = {
    ...base,
    triage,
    seenRoots: {
      [seenRootKey('a', root.rootKey)]: {
        touchedAt: 1,
        issues: { [root.rootKey]: { seenAt: 1, fields: { Status: 'Open' } } },
      },
    },
  };
  const before = inboxItems(
    candidates,
    workspace,
    connections,
    snapshots,
    {},
    {},
    1099,
  )[0];
  assert.deepEqual(before.reasons, ['Unread changes', 'Pinned locally']);
  assert.equal(before.snoozedUntil, 1100);
  assert.equal(
    inboxItems(candidates, workspace, connections, snapshots, {}, {}, 1100)[0]
      .snoozedUntil,
    undefined,
  );
  const restored = recoverTriage(JSON.parse(JSON.stringify(triage)), 1100);
  assert.equal(restored.items[0].pinned, true);
  assert.equal(restored.items[0].snoozedUntil, undefined);
});
it('bounds private action history and preferences, migrates absence/corruption without dropping workspace', () => {
  let state = emptyTriage();
  for (let index = 0; index < MAX_TRIAGE_ITEMS + 20; index++)
    state = changeTriage(state, 'a', `A-${index}`, 'pin', index + 1);
  assert.equal(state.items.length, MAX_TRIAGE_ITEMS);
  assert.equal(state.history.length, MAX_TRIAGE_HISTORY);
  assert.equal(state.items.at(-1)?.issueKey, 'A-20');
  assert.ok(validTriage(JSON.parse(JSON.stringify(state))));
  assert.equal(recoverTriage(state, TRIAGE_RETENTION + 600).history.length, 0);
  const corrupts: unknown[] = [
    {
      ...state,
      history: [{ connectionId: 'a', issueKey: 'A-1', at: 1, action: ['pin'] }],
    },
    {
      ...state,
      items: [{ ...state.items[0], snoozedUntil: Number.MAX_SAFE_INTEGER }],
    },
    null,
    { ...state, version: 2 },
    { ...state, items: [...state.items, state.items[0]] },
    { ...state, items: [{ ...state.items[0], snoozedUntil: Infinity }] },
    {
      ...state,
      history: [
        {
          connectionId: 'a',
          issueKey: 'A-1',
          at: 1,
          action: 'seen',
          summary: 'private',
        },
      ],
    },
    { ...state, reviewStatuses: { a: [42] } },
  ];
  for (const corrupt of corrupts) {
    assert.equal(validTriage(corrupt), false);
    const restored = recoverWorkspaceViews({
      ...base,
      triage: corrupt,
    } as Workspace);
    assert.deepEqual(restored.triage, emptyTriage());
    assert.deepEqual(restored.tabs, base.tabs);
  }
  assert.deepEqual(recoverWorkspaceViews(base).triage, emptyTriage());
  assert.equal(
    removeConnection(
      { ...base, triage: changeTriage(undefined, 'a', 'A-1', 'pin') },
      'a',
    ).triage?.items.length,
    0,
  );
});
it('discovers saved-only, closed, configured repository and root-view roots', () => {
  const workspace: Workspace = {
    ...base,
    closedTabs: [
      { ...source('b', 'B-1'), expanded: [], hideDone: true, scrollTop: 0 },
    ],
    savedViews: [
      {
        id: 'v',
        name: 'v',
        roots: [source('b', 'B-2')],
        connectionIds: [],
        filters: {
          assignee: 'any',
          statuses: [],
          priority: '',
          hideDone: true,
        },
        sort: { column: 'key', direction: 'asc' },
      },
    ],
    rootViews: { [JSON.stringify(['b', 'B-3'])]: {} as never },
  };
  assert.deepEqual(
    configuredRoots(workspace, [
      { ...connections[0], repositories: ['org/repo'] },
    ]).map((item) => item.rootKey),
    ['B-1', 'B-2', 'org/repo', 'B-3'],
  );
});
it('inspects bounded pages, retains successes on failures, retries, and scopes duplicate keys by account', async () => {
  const candidates = [
    ...sample(22),
    ...sample().map((item) => ({
      ...item,
      source: { ...item.source, connectionId: 'b' },
    })),
  ];
  const calls: string[] = [];
  let fail = true;
  let latest: Record<string, InboxGraph> = {};
  const api = {
    syncStatus: async () => ({ retryAt: null }),
    cancelRelationships: async () => {},
    relationships: async (id: string, key: string) => {
      calls.push(triageIdentity(id, key));
      if (key === 'org/repo#2' && fail) throw new Error('secret transport');
      return blocked(key);
    },
  };
  const controller = new InboxInspection(api, (entries) => (latest = entries));
  await controller.load(candidates);
  assert.equal(calls.length, 20);
  assert.ok(latest[triageIdentity('a', 'org/repo#1')].graph);
  assert.equal(
    latest[triageIdentity('a', 'org/repo#2')].error,
    'Blockers could not be inspected. Retry.',
  );
  await controller.load(candidates);
  assert.equal(calls.length, 23);
  assert.ok(latest[triageIdentity('b', 'org/repo#1')].graph);
  assert.equal(JSON.stringify(latest).includes('secret'), false);
  fail = false;
  await controller.load(candidates, true);
  assert.ok(latest[triageIdentity('a', 'org/repo#2')].graph);
  assert.equal(controller.busy, false);
});
it('cancels exact requests and rejects ignored-abort late success and failure after fresh reset', async () => {
  for (const rejectLate of [false, true]) {
    let release!: () => void;
    let pendingId = '';
    const cancelled: string[] = [];
    let latest: Record<string, InboxGraph> = {};
    let calls = 0;
    const api = {
      syncStatus: async () => ({ retryAt: null }),
      cancelRelationships: async (id: string, requestId: string) => {
        cancelled.push(triageIdentity(id, requestId));
      },
      relationships: async (_id: string, key: string, requestId: string) => {
        calls++;
        if (calls === 1) {
          pendingId = requestId;
          await new Promise<void>((resolve) => (release = resolve));
          if (rejectLate) throw new Error('late');
        }
        return blocked(key);
      },
    };
    const candidates = sample();
    const controller = new InboxInspection(
      api,
      (entries) => (latest = entries),
    );
    const old = controller.load(candidates);
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = candidates.map((item) => ({ ...item, stamp: 'fresh' }));
    controller.reset(fresh);
    assert.deepEqual(cancelled, [triageIdentity('a', pendingId)]);
    await controller.load(fresh);
    release();
    await old;
    assert.equal(latest[triageIdentity('a', 'org/repo#1')].stamp, 'fresh');
    assert.ok(latest[triageIdentity('a', 'org/repo#1')].graph);
    assert.equal(controller.busy, false);
  }
});
it('obeys rate limits without provider graph reads and can retry after recovery', async () => {
  let limited = true;
  let calls = 0;
  let statusCalls = 0;
  let latest: Record<string, InboxGraph> = {};
  const api = {
    syncStatus: async () => {
      statusCalls++;
      return { retryAt: limited ? Date.now() + 60000 : null };
    },
    cancelRelationships: async () => {},
    relationships: async (_id: string, key: string) => {
      calls++;
      return blocked(key);
    },
  };
  const controller = new InboxInspection(api, (entries) => (latest = entries));
  await controller.load(sample(3));
  assert.equal(calls, 0);
  assert.equal(statusCalls, 1);
  assert.match(
    latest[triageIdentity('a', 'org/repo#1')].error!,
    /Rate limited until/,
  );
  limited = false;
  await controller.load(sample(3), true);
  assert.equal(calls, 3);
});
it('retains confirmed partial blockers when a retry fails at the same snapshot', async () => {
  let fail = false;
  let latest: Record<string, InboxGraph> = {};
  const controller = new InboxInspection(
    {
      syncStatus: async () => ({ retryAt: null }),
      cancelRelationships: async () => {},
      relationships: async (_id, key) => {
        if (fail) throw new Error('private');
        return blocked(key);
      },
    },
    (entries) => (latest = entries),
  );
  const candidates = sample();
  await controller.load(candidates);
  fail = true;
  await controller.load(candidates, true);
  assert.ok(latest[triageIdentity('a', 'org/repo#1')].graph);
  assert.ok(latest[triageIdentity('a', 'org/repo#1')].error);
  const root = source();
  const snapshots = { [root.id]: snapshot(root.rootKey, [issue()]) };
  assert.deepEqual(
    inboxItems(candidates, base, connections, snapshots, {}, latest, 100)[0]
      .reasons,
    ['Blocked by org/repo#9'],
  );
});
it('does not carry a successful old graph into a failed read of a newer snapshot', async () => {
  let fail = false;
  let latest: Record<string, InboxGraph> = {};
  const controller = new InboxInspection(
    {
      syncStatus: async () => ({ retryAt: null }),
      cancelRelationships: async () => {},
      relationships: async (_id, key) => {
        if (fail) throw new Error('failed fresh read');
        return blocked(key);
      },
    },
    (entries) => (latest = entries),
  );
  await controller.load(sample());
  fail = true;
  await controller.load(
    sample().map((candidate) => ({ ...candidate, stamp: 'new' })),
  );
  assert.equal(latest[triageIdentity('a', 'org/repo#1')].stamp, 'new');
  assert.equal(latest[triageIdentity('a', 'org/repo#1')].graph, undefined);
});
it('retries visible blocker groups whose target statuses remain unknown', async () => {
  let calls = 0;
  let latest: Record<string, InboxGraph> = {};
  const controller = new InboxInspection(
    {
      syncStatus: async () => ({ retryAt: null }),
      cancelRelationships: async () => {},
      relationships: async (_id, key) => {
        calls++;
        return {
          key,
          groups: [
            {
              kind: 'blockers',
              state: 'visible',
              items: [
                {
                  ...blocked(key).groups[0].items[0],
                  statusCategory: undefined,
                },
              ],
            },
          ],
        };
      },
    },
    (entries) => (latest = entries),
  );
  await controller.load(sample());
  await controller.load(sample(), true);
  assert.equal(calls, 2);
  const root = source();
  assert.equal(
    inboxItems(
      sample(),
      base,
      connections,
      { [root.id]: snapshot(root.rootKey, [issue()]) },
      {},
      latest,
      100,
    ).length,
    0,
    'unknown blocker status cannot establish confirmed blocked work',
  );
});
it('includes orphaned returned work and normalizes provider root presentations without duplicate discovery', () => {
  const root = source();
  const orphan = issue('org/repo#99', {
    assignee: { id: 'me', name: 'Me' },
    parentKey: 'unloaded-parent',
  });
  const snapshots = { [root.id]: snapshot(root.rootKey, [issue(), orphan]) };
  const candidates = inboxCandidates([root], snapshots, connections);
  const graph = {
    [triageIdentity('a', orphan.key)]: {
      stamp: candidates.find((item) => item.issue.key === orphan.key)!.stamp,
      graph: blocked(orphan.key),
    },
  };
  const result = inboxItems(
    candidates,
    base,
    connections,
    snapshots,
    { a: { id: 'me' } },
    graph,
    100,
  );
  assert.deepEqual(result[0].reasons, [
    'Assigned to you',
    'Blocked by org/repo#9',
  ]);
  const configured = configuredRoots(
    {
      ...base,
      pinnedRoots: [{ connectionId: 'a', rootKey: 'org/repo' }],
      rootViews: { [JSON.stringify(['a', 'ORG/REPO'])]: {} as never },
    },
    connections,
  );
  assert.equal(configured.length, 1);
  assert.equal(configured[0].rootKey, 'org/repo');
});
it('reuses matching stamped Next tasks graphs and rejects stale or other-account seeds', async () => {
  let calls = 0;
  let latest: Record<string, InboxGraph> = {};
  const controller = new InboxInspection(
    {
      syncStatus: async () => ({ retryAt: null }),
      cancelRelationships: async () => {},
      relationships: async (_id, key) => {
        calls++;
        return blocked(key);
      },
    },
    (entries) => (latest = entries),
  );
  const candidates = sample(3);
  const visible = (key: string): IssueRelationships => ({
    key,
    groups: [{ kind: 'blockers', state: 'visible', items: [] }],
  });
  controller.reset(candidates, {
    [triageIdentity('a', 'org/repo#1')]: {
      stamp: candidates[0].stamp,
      graph: visible('org/repo#1'),
    },
    [triageIdentity('a', 'org/repo#2')]: {
      stamp: 'older',
      graph: visible('org/repo#2'),
    },
    [triageIdentity('b', 'org/repo#3')]: {
      stamp: candidates[2].stamp,
      graph: visible('org/repo#3'),
    },
  });
  await controller.load(candidates);
  assert.equal(calls, 2);
  assert.equal(
    latest[triageIdentity('a', 'org/repo#1')].graph?.groups[0].items.length,
    0,
  );
});
it('keeps the exact held inbox read during unrelated same-account or other-account refreshes', async () => {
  for (const connectionId of ['a', 'b']) {
    let release!: () => void;
    const calls: string[] = [];
    const cancelled: string[] = [];
    let latest: Record<string, InboxGraph> = {};
    const first = sample()[0];
    const second = {
      ...first,
      issue: issue(connectionId === 'a' ? 'other/root#1' : first.issue.key),
      source: source(connectionId, 'other/root#1'),
      stamp: 'unrelated-old',
    };
    const controller = new InboxInspection(
      {
        syncStatus: async () => ({ retryAt: null }),
        cancelRelationships: async (id, requestId) => {
          cancelled.push(triageIdentity(id, requestId));
        },
        relationships: async (id, key) => {
          calls.push(triageIdentity(id, key));
          if (calls.length === 1)
            await new Promise<void>((resolve) => (release = resolve));
          return blocked(key);
        },
      },
      (entries) => (latest = entries),
    );
    controller.reset([first, second]);
    const pending = controller.load([first, second]);
    await new Promise((resolve) => setImmediate(resolve));
    const refreshed = { ...second, stamp: 'unrelated-fresh' };
    controller.reset([first, refreshed]);
    assert.deepEqual(
      cancelled,
      [],
      'unrelated refresh must preserve exact held request',
    );
    assert.equal(controller.busy, true);
    release();
    await pending;
    assert.equal(
      latest[triageIdentity(first.source.connectionId, first.issue.key)].graph
        ?.key,
      first.issue.key,
    );
    assert.equal(calls.length, 1, 'queued old snapshot must be skipped');
    await controller.load([first, refreshed]);
    assert.equal(calls.length, 2);
    assert.equal(
      latest[triageIdentity(second.source.connectionId, second.issue.key)]
        .stamp,
      'unrelated-fresh',
    );
  }
});

it('organization Undo preserves live triage, owning selection and root presentation', () => {
  const tab = {
    id: 'owner',
    connectionId: 'a',
    rootKey: 'org/repo#1',
    selectedKey: 'org/repo#1',
    expanded: ['org/repo#1'],
    hideDone: false,
    scrollTop: 0,
  };
  const organized = organizeSidebar(
    { ...base, tabs: [tab], activeTabId: tab.id },
    emptySidebarSession(),
    { type: 'pin', root: tab },
  );
  const triage = changeTriage(
    undefined,
    'a',
    tab.rootKey,
    'snooze',
    Date.now(),
    3600000,
  );
  const selected = activateTab(
    {
      ...organized.workspace,
      triage,
      rootViews: {
        '["a","ORG/REPO#1"]': { ...DEFAULT_VIEW, filters: { status: 'Open' } },
      },
    },
    { ...tab, selectedKey: 'org/repo#2' },
    false,
  );
  const undone = organizeSidebar(selected, organized.session, {
    type: 'undo',
  }).workspace;
  assert.deepEqual(undone.triage, triage);
  assert.equal(undone.activeTabId, 'owner');
  assert.equal(undone.tabs[0].connectionId, 'a');
  assert.equal(undone.tabs[0].selectedKey, 'org/repo#2');
  assert.deepEqual(undone.rootViews, selected.rootViews);
  assert.deepEqual(undone.pinnedRoots, []);
});
