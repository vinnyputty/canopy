import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Pickers } from '../src/renderer/pickers';
import type { CanopyAPI, Choice } from '../src/shared/types';
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
  assert.match(pickers.values['a:ABC-1'].status?.error ?? '', /Jira rejected/);
  assert.equal(pickers.values['a:ABC-1'].transitions, undefined);
});
