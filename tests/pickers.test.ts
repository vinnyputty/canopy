import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Pickers } from '../src/renderer/pickers';
import type { CanopyAPI, Choice, Issue } from '../src/shared/types';
const ada = { id: 'ada', name: 'Ada' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(overrides: Partial<CanopyAPI> = {}) {
  const calls: string[] = [];
  const pickers = new Pickers(
    {
      priorities: async () => {
        calls.push('priority');
        return [];
      },
      transitions: async () => {
        calls.push('status');
        return [];
      },
      cachedUsers: async () => {
        calls.push('cached');
        return [ada];
      },
      assignees: async () => {
        calls.push('search');
        return { users: [ada], nextStartAt: 100 };
      },
      validateAssignee: async () => ada,
      ...overrides,
    },
    () => {},
  );
  return { pickers, calls };
}
const issue = (key: string, statusId: string, type = 'Task'): Issue => ({
  id: key,
  key,
  summary: key,
  type,
  priority: null,
  assignee: null,
  links: [],
  status: { id: statusId, name: statusId, category: 'new' },
});
it('loads destination paths on demand when status sharing is disabled', async () => {
  const open = issue('ABC-1', 'open');
  open.projectId = 'project';
  open.typeId = 'task';
  const started = {
    id: 'started',
    name: 'Started',
    category: 'indeterminate' as const,
  };
  const done = { id: 'done', name: 'Done', category: 'done' as const };
  const { pickers } = harness({
    transitions: async () => [
      { id: 'start', name: 'Start', to: started, requiresFields: false },
    ],
    workflowGraph: async () => ({
      open: [
        { id: 'start', name: 'Start', to: started, requiresFields: false },
      ],
      started: [
        { id: 'finish', name: 'Finish', to: done, requiresFields: false },
      ],
    }),
  });
  await pickers.open('a', open.key, 'status', 'ABC-1', false, open);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    pickers
      .paths('a', 'ABC-1', open)
      .map((path) => path.steps.map((step) => step.id)),
    [['start', 'finish']],
  );
});
it('shows cached suggestions on opening without loading unrelated fields or directory search', async () => {
  const { pickers, calls } = harness();
  await pickers.open('a', 'ABC-1', 'assignee');
  assert.deepEqual(calls, ['cached']);
  assert.deepEqual(pickers.values['a:ABC-1'].assignees, [ada]);
  assert.equal(pickers.values['a:ABC-1'].nextStartAt, 0);
  await pickers.load('a', 'ABC-1', 'assignee', '', true);
  assert.deepEqual(calls, ['cached', 'search']);
});
it('fetches an initial window when no cached suggestions exist', async () => {
  const { pickers, calls } = harness({ cachedUsers: async () => [] });
  await pickers.open('a', 'ABC-1', 'assignee');
  assert.deepEqual(calls, ['search']);
});
it('isolates loading failures by field and refreshes only the retried field', async () => {
  const status = deferred<[]>();
  let fresh: boolean | undefined;
  const { pickers } = harness({
    priorities: async (_id, _key, refresh) => {
      fresh = refresh;
      if (!refresh) throw new Error('Priority denied');
      return [];
    },
    transitions: () => status.promise,
  });
  const loading = pickers.open('a', 'ABC-1', 'status');
  await pickers.open('a', 'ABC-1', 'priority');
  await pickers.open('a', 'ABC-1', 'assignee');
  assert.equal(pickers.values['a:ABC-1'].status?.loading, true);
  assert.equal(pickers.values['a:ABC-1'].priority?.error, 'Priority denied');
  assert.deepEqual(pickers.values['a:ABC-1'].assignees, [ada]);
  await pickers.load('a', 'ABC-1', 'priority', '', false, true);
  assert.equal(fresh, true);
  status.resolve([]);
  await loading;
  assert.equal(pickers.values['a:ABC-1'].priority?.error, undefined);
});
it('discards older assignee queries and disconnected connection responses', async () => {
  const old = deferred<{ users: Choice[] }>();
  const { pickers } = harness({
    assignees: async (_id, _key, query) =>
      query === 'old' ? old.promise : { users: [ada] },
  });
  const pending = pickers.load('a', 'ABC-1', 'assignee', 'old');
  await pickers.load('a', 'ABC-1', 'assignee', 'new');
  old.resolve({ users: [{ id: 'old', name: 'Old' }] });
  await pending;
  assert.deepEqual(pickers.values['a:ABC-1'].assignees, [ada]);
  const priority = deferred<Choice[]>();
  const second = harness({ priorities: () => priority.promise }).pickers;
  const loading = second.open('a', 'ABC-1', 'priority');
  second.clear();
  priority.resolve([ada]);
  await loading;
  assert.deepEqual(second.values, {});
});
it('keeps invalid cached suggestions in the editor with an independent assignment error', async () => {
  const { pickers } = harness({
    validateAssignee: async (_id, _key, _account, refresh) => {
      assert.equal(refresh, true);
      throw new Error('Not assignable');
    },
  });
  await pickers.open('a', 'ABC-1', 'assignee');
  assert.equal(await pickers.validate('a', 'ABC-1', ada.id), false);
  assert.deepEqual(pickers.values['a:ABC-1'].assignees, [ada]);
  assert.equal(pickers.values['a:ABC-1'].assignee?.error, 'Not assignable');
  await pickers.open('a', 'ABC-1', 'status');
  assert.deepEqual(pickers.values['a:ABC-1'].transitions, []);
});
it('merges windows and prevents concurrent Load more requests', async () => {
  const page = deferred<{ users: Choice[]; nextStartAt: number }>();
  let calls = 0;
  const { pickers } = harness({
    assignees: async (_id, _key, _query, startAt) => {
      assert.equal(startAt, 0);
      calls++;
      return page.promise;
    },
  });
  await pickers.open('a', 'ABC-1', 'assignee');
  const loading = pickers.load('a', 'ABC-1', 'assignee', '', true);
  await pickers.load('a', 'ABC-1', 'assignee', '', true);
  page.resolve({ users: [ada, { id: 'sam', name: 'Sam' }], nextStartAt: 100 });
  await loading;
  assert.equal(calls, 1);
  assert.equal(pickers.values['a:ABC-1'].assignees?.length, 2);
});

it('invalidates stale query results before the debounce finishes and releases inactive user pages', async () => {
  const old = deferred<{ users: Choice[] }>();
  const { pickers } = harness({ assignees: () => old.promise });
  await pickers.open('a', 'ABC-1', 'assignee');
  const pending = pickers.load('a', 'ABC-1', 'assignee', 'old');
  pickers.changeQuery('a', 'ABC-1', 'new');
  old.resolve({ users: [{ id: 'old', name: 'Old' }] });
  await pending;
  assert.equal(pickers.values['a:ABC-1'].query, 'new');
  assert.equal(pickers.values['a:ABC-1'].assignee?.loading, true);
  assert.notDeepEqual(pickers.values['a:ABC-1'].assignees, [
    { id: 'old', name: 'Old' },
  ]);
  pickers.close('a', 'ABC-1', 'assignee');
  assert.equal(pickers.values['a:ABC-1'].assignees, undefined);
  assert.equal(pickers.values['a:ABC-1'].nextStartAt, undefined);
});

it('preserves a rejected status error while rollback invalidates the optimistic workflow context', async () => {
  const { pickers } = harness();
  const issue = {
    id: '1',
    key: 'ABC-1',
    summary: '',
    type: 'Task',
    priority: null,
    assignee: null,
    links: [],
    status: { id: 'done', name: 'Done', category: 'done' as const },
  };
  pickers.observe('a', [issue]);
  await pickers.open('a', issue.key, 'status');
  pickers.rejected('a', issue.key, 'status');
  pickers.observe('a', [{ ...issue, status: { ...issue.status, id: 'open' } }]);
  assert.match(pickers.values['a:ABC-1'].status?.error ?? '', /was rejected/);
  assert.equal(pickers.values['a:ABC-1'].transitions, undefined);
});

it('shows cached transitions immediately and shares an in-flight status load', async () => {
  const pending =
    deferred<{ id: string; name: string; requiresFields: boolean }[]>();
  let requests = 0;
  let loadingRenders = 0;
  const pickers = new Pickers(
    {
      priorities: async () => [],
      transitions: async () => {
        requests++;
        return pending.promise;
      },
      cachedUsers: async () => [],
      assignees: async () => ({ users: [] }),
      validateAssignee: async () => null,
    },
    (values) => {
      if (values['a:ABC-1']?.status?.loading) loadingRenders++;
    },
  );
  const first = pickers.open('a', 'ABC-1', 'status');
  const repeatedWhilePending = pickers.open('a', 'ABC-1', 'status');
  assert.equal(requests, 1);
  pending.resolve([{ id: 'done', name: 'Done', requiresFields: false }]);
  await Promise.all([first, repeatedWhilePending]);
  loadingRenders = 0;
  await pickers.open('a', 'ABC-1', 'status');
  assert.equal(requests, 1);
  assert.equal(loadingRenders, 0);
  assert.deepEqual(pickers.values['a:ABC-1'].transitions, [
    { id: 'done', name: 'Done', requiresFields: false },
  ]);
});

it('reloads transitions after status changes and ignores stale in-flight choices', async () => {
  const first =
    deferred<{ id: string; name: string; requiresFields: boolean }[]>();
  let requests = 0;
  const { pickers } = harness({
    transitions: async () => {
      requests++;
      return requests === 1
        ? first.promise
        : [{ id: 'reopen', name: 'Reopen', requiresFields: false }];
    },
  });
  const issue = {
    id: '1',
    key: 'ABC-1',
    summary: '',
    type: 'Task',
    priority: null,
    assignee: null,
    links: [],
    status: { id: 'open', name: 'Open', category: 'new' as const },
  };
  pickers.observe('a', [issue]);
  const old = pickers.open('a', issue.key, 'status');
  pickers.observe('a', [{ ...issue, status: { ...issue.status, id: 'done' } }]);
  await pickers.open('a', issue.key, 'status');
  first.resolve([{ id: 'done', name: 'Done', requiresFields: false }]);
  await old;
  assert.equal(requests, 2);
  assert.deepEqual(pickers.values['a:ABC-1'].transitions, [
    { id: 'reopen', name: 'Reopen', requiresFields: false },
  ]);
});

it('clears rejected choices and can retry after a failed transition load', async () => {
  let requests = 0;
  const { pickers } = harness({
    transitions: async () => {
      requests++;
      if (requests === 2) throw new Error('Workflow unavailable');
      return [{ id: String(requests), name: 'Choice', requiresFields: false }];
    },
  });
  await pickers.open('a', 'ABC-1', 'status');
  pickers.rejected('a', 'ABC-1', 'status');
  assert.equal(pickers.values['a:ABC-1'].transitions, undefined);
  await pickers.open('a', 'ABC-1', 'status');
  assert.equal(pickers.values['a:ABC-1'].status?.error, 'Workflow unavailable');
  await pickers.load('a', 'ABC-1', 'status', '', false, true);
  assert.equal(requests, 3);
  assert.deepEqual(pickers.values['a:ABC-1'].transitions, [
    { id: '3', name: 'Choice', requiresFields: false },
  ]);
});

it('revalidates provider choices after a rejected status selection', async () => {
  const requests: boolean[] = [];
  let cached = [{ id: 'stale', name: 'Stale', requiresFields: false }];
  const { pickers } = harness({
    transitions: async (_connection, _key, refresh) => {
      requests.push(Boolean(refresh));
      if (refresh)
        cached = [{ id: 'fresh', name: 'Fresh', requiresFields: false }];
      return cached;
    },
  });
  await pickers.open('a', 'ABC-1', 'status');
  pickers.rejected('a', 'ABC-1', 'status');
  await pickers.open('a', 'ABC-1', 'status');
  assert.deepEqual(requests, [false, true]);
  assert.deepEqual(pickers.values['a:ABC-1'].transitions, [
    { id: 'fresh', name: 'Fresh', requiresFields: false },
  ]);
});

it('keeps status choices for the same issue key separate by connection', async () => {
  const requests: string[] = [];
  const { pickers } = harness({
    transitions: async (connection) => {
      requests.push(connection);
      return connection === 'github'
        ? [{ id: 'closed', name: 'Closed', requiresFields: false }]
        : [{ id: 'jira-42', name: 'Complete', requiresFields: false }];
    },
  });
  await Promise.all([
    pickers.open('github', 'team/a#1', 'status'),
    pickers.open('jira', 'team/a#1', 'status'),
  ]);
  await pickers.open('github', 'team/a#1', 'status');
  assert.deepEqual(requests, ['github', 'jira']);
  assert.deepEqual(pickers.values['github:team/a#1'].transitions, [
    { id: 'closed', name: 'Closed', requiresFields: false },
  ]);
  assert.deepEqual(pickers.values['jira:team/a#1'].transitions, [
    { id: 'jira-42', name: 'Complete', requiresFields: false },
  ]);
});

it('prefetches one Jira transition set per issue type and current status', async () => {
  const requests: string[] = [];
  let loadingRenders = 0;
  const pickers = new Pickers(
    {
      priorities: async () => [],
      transitions: async (_connection, key) => {
        requests.push(key);
        return [{ id: `${key}-next`, name: 'Next', requiresFields: false }];
      },
      cachedUsers: async () => [],
      assignees: async () => ({ users: [] }),
      validateAssignee: async () => null,
    },
    (values) => {
      if (values['jira:ABC-2']?.status?.loading) loadingRenders++;
    },
  );
  await pickers.prime('jira', 'ABC-1', [
    issue('ABC-1', 'open'),
    issue('ABC-2', 'open'),
    issue('ABC-3', 'done'),
    issue('ABC-4', 'open', 'Bug'),
  ]);
  assert.deepEqual(requests, ['ABC-1', 'ABC-3', 'ABC-4']);
  await pickers.open('jira', 'ABC-2', 'status', 'ABC-1', true);
  assert.deepEqual(requests, ['ABC-1', 'ABC-3', 'ABC-4']);
  assert.equal(loadingRenders, 0);
  assert.equal(pickers.values['jira:ABC-2'].transitions?.[0].id, 'ABC-1-next');
  pickers.observe('jira', [issue('ABC-2', 'done')]);
  await pickers.open('jira', 'ABC-2', 'status', 'ABC-1', true);
  assert.deepEqual(requests, ['ABC-1', 'ABC-3', 'ABC-4']);
  assert.equal(pickers.values['jira:ABC-2'].transitions?.[0].id, 'ABC-3-next');
});

it('refreshes only the rejected issue and allows sharing to be disabled', async () => {
  const requests: { key: string; refresh: boolean }[] = [];
  const { pickers } = harness({
    transitions: async (_connection, key, refresh) => {
      requests.push({ key, refresh: Boolean(refresh) });
      return [
        {
          id: refresh ? `${key}-fresh` : `${key}-shared`,
          name: 'Next',
          requiresFields: false,
        },
      ];
    },
  });
  await pickers.prime('jira', 'ABC-1', [
    issue('ABC-1', 'open'),
    issue('ABC-2', 'open'),
    issue('ABC-3', 'open'),
  ]);
  await pickers.open('jira', 'ABC-2', 'status', 'ABC-1', true);
  pickers.rejected('jira', 'ABC-2', 'status');
  await pickers.open('jira', 'ABC-2', 'status', 'ABC-1', true);
  await pickers.open('jira', 'ABC-3', 'status', 'ABC-1', true);
  assert.deepEqual(requests, [
    { key: 'ABC-1', refresh: false },
    { key: 'ABC-2', refresh: true },
  ]);
  assert.equal(pickers.values['jira:ABC-2'].transitions?.[0].id, 'ABC-2-fresh');
  assert.equal(
    pickers.values['jira:ABC-3'].transitions?.[0].id,
    'ABC-1-shared',
  );
  pickers.clearStatusChoices('jira', [issue('ABC-3', 'open')]);
  await pickers.open('jira', 'ABC-3', 'status', 'ABC-1', false);
  assert.deepEqual(requests.at(-1), { key: 'ABC-3', refresh: false });
});

it('keeps prefetched status choices separate across root trees', async () => {
  const requests: string[] = [];
  const { pickers } = harness({
    transitions: async (_connection, key) => {
      requests.push(key);
      return [{ id: key, name: 'Next', requiresFields: false }];
    },
  });
  await pickers.prime('jira', 'ABC-1', [issue('ABC-1', 'open')]);
  await pickers.prime('jira', 'ABC-10', [
    issue('ABC-10', 'open'),
    issue('ABC-11', 'open'),
  ]);
  await pickers.open('jira', 'ABC-11', 'status', 'ABC-10', true);
  assert.deepEqual(requests, ['ABC-1', 'ABC-10']);
  assert.equal(pickers.values['jira:ABC-11'].transitions?.[0].id, 'ABC-10');
});

it('uses the active root when one issue appears in overlapping trees', async () => {
  const { pickers } = harness({
    transitions: async (_connection, key) => [
      { id: key, name: 'Next', requiresFields: false },
    ],
  });
  const shared = issue('ABC-2', 'open');
  await pickers.prime('jira', 'ABC-1', [issue('ABC-1', 'open'), shared]);
  await pickers.prime('jira', 'ABC-10', [issue('ABC-10', 'open'), shared]);
  await pickers.open('jira', shared.key, 'status', 'ABC-1', true, shared);
  assert.equal(pickers.values['jira:ABC-2'].transitions?.[0].id, 'ABC-1');
  await pickers.open('jira', shared.key, 'status', 'ABC-10', true, shared);
  assert.equal(pickers.values['jira:ABC-2'].transitions?.[0].id, 'ABC-10');
});

it('loads issue-specific direct choices for statuses absent from the opened tree', async () => {
  const requests: string[] = [];
  let currentStatus = 'open';
  const { pickers } = harness({
    workflowGraph: async () => ({
      open: [{ id: 'metadata-open', name: 'Start', requiresFields: false }],
      done: [{ id: 'reopen', name: 'Reopen', requiresFields: false }],
    }),
    transitions: async (_connection, key) => {
      requests.push(key);
      return [
        {
          id: `verified-${currentStatus}`,
          name: 'Start',
          requiresFields: false,
        },
      ];
    },
  });
  const root = { ...issue('ABC-1', 'open'), projectId: '100', typeId: '200' };
  await pickers.prime('jira', root.key, [root]);
  assert.deepEqual(requests, ['ABC-1']);
  await pickers.open('jira', root.key, 'status', root.key, true);
  assert.equal(
    pickers.values['jira:ABC-1'].transitions?.[0].id,
    'verified-open',
  );
  pickers.observe('jira', [
    { ...root, status: { ...root.status, id: 'done' } },
  ]);
  currentStatus = 'done';
  await pickers.open('jira', root.key, 'status', root.key, true);
  assert.deepEqual(requests, ['ABC-1', 'ABC-1']);
  assert.equal(
    pickers.values['jira:ABC-1'].transitions?.[0].id,
    'verified-done',
  );
});

it('adds graph-only edges after cached status choices when workflow loading recovers', async () => {
  const started = {
    id: 'started',
    name: 'Started',
    category: 'indeterminate' as const,
  };
  const done = { id: 'done', name: 'Done', category: 'done' as const };
  const review = {
    id: 'review',
    name: 'In review',
    category: 'indeterminate' as const,
  };
  let graphCalls = 0;
  const { pickers } = harness({
    workflowGraph: async () => {
      if (++graphCalls === 1) throw new Error('Workflow metadata unavailable');
      return {
        started: [
          {
            id: 'finish',
            name: 'Graph finish',
            to: review,
            requiresFields: false,
          },
          { id: 'review', name: 'Review', to: review, requiresFields: false },
        ],
      };
    },
    transitions: async (_connection, key) =>
      key === 'ABC-1'
        ? [{ id: 'start', name: 'Start', to: started, requiresFields: false }]
        : [{ id: 'finish', name: 'Finish', to: done, requiresFields: false }],
  });
  const root = { ...issue('ABC-1', 'open'), projectId: '100', typeId: '200' };
  const second = {
    ...issue('ABC-2', 'started'),
    projectId: '100',
    typeId: '200',
  };
  await pickers.prime('jira', root.key, [root, second]);
  await pickers.open('jira', root.key, 'status', root.key, true, root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(graphCalls, 2);
  assert.deepEqual(
    pickers
      .paths('jira', root.key, root)
      .map((path) => [path.destination.id, path.steps.map((step) => step.id)]),
    [
      ['done', ['start', 'finish']],
      ['review', ['start', 'review']],
    ],
  );
  await pickers.open('jira', second.key, 'status', root.key, true, second);
  assert.deepEqual(
    pickers.values['jira:ABC-2'].transitions?.map((choice) => choice.id),
    ['finish'],
  );
});
