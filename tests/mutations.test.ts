import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mutations, type MutationView } from '../src/renderer/mutations';
import type {
  CanopyAPI,
  EditOptions,
  Issue,
  TabState,
  TreeSnapshot,
} from '../src/shared/types';

const issue = (key: string, parentKey?: string): Issue => ({
  id: key,
  key,
  parentKey,
  summary: key,
  type: 'Task',
  priority: { id: '1', name: 'High' },
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
});
const tab = (id = 'one', connectionId = 'jira'): TabState => ({
  id,
  connectionId,
  rootKey: 'A-1',
  expanded: ['A-1'],
  hideDone: false,
  scrollTop: 0,
});
const snapshot = (): TreeSnapshot => ({
  rootKey: 'A-1',
  issues: [
    issue('A-1'),
    issue('A-2', 'A-1'),
    issue('A-3', 'A-1'),
    issue('A-4', 'A-1'),
  ],
  warnings: [],
  fetchedAt: 1,
});
const options: EditOptions = {
  priorities: [
    { id: '1', name: 'High' },
    { id: '2', name: 'Low' },
  ],
  assignees: [{ id: 'ada', name: 'Ada' }],
  transitions: [
    {
      id: 'finish',
      name: 'Finish',
      requiresFields: false,
      to: { id: 'done', name: 'Done', category: 'done' },
    },
  ],
};
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
  let view!: MutationView;
  const errors: string[] = [];
  const api = {
    update: async (_connection: string, key: string) => issue(key, 'A-1'),
    rank: async () => {},
    tree: async () => snapshot(),
    editOptions: async () => options,
    ...overrides,
  };
  const mutations = new Mutations(
    api,
    (next) => (view = next),
    (message) => errors.push(message),
  );
  mutations.receive(tab(), snapshot(), 0);
  mutations.receive(tab('two'), snapshot(), 0);
  mutations.receive(tab('other', 'other'), snapshot(), 0);
  return {
    mutations,
    errors,
    get view() {
      return view;
    },
    get current() {
      return view.snapshots.one.issues.find((value) => value.key === 'A-2')!;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('optimistic mutation reconciliation', () => {
  it('applies fields to every matching tab, scopes pending by connection, and restores a failed edit', async () => {
    const request = deferred<Issue>();
    const h = harness({ update: () => request.promise });
    const saving = h.mutations.update('jira', 'A-2', { summary: 'Draft' });
    assert.equal(h.current.summary, 'Draft');
    assert.equal(h.view.snapshots.two.issues[1].summary, 'Draft');
    assert.equal(h.view.snapshots.other.issues[1].summary, 'A-2');
    assert.deepEqual([...h.view.saving], ['jira:A-2']);
    request.reject(new Error('Permission denied'));
    assert.equal(await saving, false);
    assert.equal(h.current.summary, 'A-2');
    assert.equal(h.view.snapshots.two.issues[1].summary, 'A-2');
    assert.equal(h.view.saving.size, 0);
    assert.match(h.errors[0], /Permission denied/);
  });

  it('serializes rapid same-issue edits and protects a newer edit from an older failure', async () => {
    const first = deferred<Issue>();
    const second = deferred<Issue>();
    let calls = 0;
    const h = harness({
      update: () => (++calls === 1 ? first.promise : second.promise),
    });
    const a = h.mutations.update('jira', 'A-2', { summary: 'First' });
    const b = h.mutations.update('jira', 'A-2', { summary: 'Second' });
    await tick();
    assert.equal(calls, 1);
    first.reject(new Error('Failed'));
    await a;
    await tick();
    assert.equal(calls, 2);
    assert.equal(h.current.summary, 'Second');
    assert.equal(h.view.saving.size, 1);
    second.resolve({ ...issue('A-2', 'A-1'), summary: 'Second' });
    await b;
    assert.equal(h.current.summary, 'Second');
  });

  it('allows independent issues to save concurrently', async () => {
    const a = deferred<Issue>();
    const b = deferred<Issue>();
    const calls: string[] = [];
    const h = harness({
      update: (_id, key) => {
        calls.push(key);
        return key === 'A-2' ? a.promise : b.promise;
      },
    });
    const one = h.mutations.update('jira', 'A-2', { summary: 'One' });
    const two = h.mutations.update('jira', 'A-3', { summary: 'Two' });
    await tick();
    assert.deepEqual(calls, ['A-2', 'A-3']);
    b.resolve({ ...issue('A-3', 'A-1'), summary: 'Two' });
    await two;
    a.resolve({ ...issue('A-2', 'A-1'), summary: 'One' });
    await one;
    assert.equal(h.current.summary, 'One');
  });

  it('reconciles an old refresh through failed and successful successive edits', async () => {
    const first = deferred<Issue>();
    const second = deferred<Issue>();
    let calls = 0;
    const h = harness({
      update: () => (++calls === 1 ? first.promise : second.promise),
    });
    const refresh = h.mutations.beginRefresh();
    const a = h.mutations.update('jira', 'A-2', { summary: 'Failed' });
    const b = h.mutations.update('jira', 'A-2', { summary: 'Kept' });
    first.reject(new Error('Failed'));
    await a;
    h.mutations.receive(tab(), snapshot(), refresh);
    assert.equal(h.current.summary, 'Kept');
    second.resolve({ ...issue('A-2', 'A-1'), summary: 'Kept' });
    await b;
    h.mutations.receive(tab(), snapshot(), refresh);
    assert.equal(h.current.summary, 'Kept');
    h.mutations.endRefresh(refresh);
  });

  it('rolls back to the last confirmed value when a later edit fails', async () => {
    const second = deferred<Issue>();
    let calls = 0;
    const h = harness({
      update: async () =>
        ++calls === 1
          ? { ...issue('A-2', 'A-1'), summary: 'First' }
          : second.promise,
    });
    const a = h.mutations.update('jira', 'A-2', { summary: 'First' });
    const b = h.mutations.update('jira', 'A-2', { summary: 'Second' });
    await a;
    assert.equal(h.current.summary, 'Second');
    second.reject(new Error('Failed'));
    await b;
    assert.equal(h.current.summary, 'First');
  });

  it('reconciles refreshes begun before and during writes without losing unrelated remote fields', async () => {
    const request = deferred<Issue>();
    const h = harness({ update: () => request.promise });
    const before = h.mutations.beginRefresh();
    const saving = h.mutations.update('jira', 'A-2', { summary: 'Local' });
    const during = h.mutations.beginRefresh();
    const remote = snapshot();
    remote.issues[1].assignee = { id: 'ada', name: 'Ada' };
    h.mutations.receive(tab(), remote, before);
    assert.equal(h.current.summary, 'Local');
    assert.equal(h.current.assignee?.name, 'Ada');
    request.resolve({ ...issue('A-2', 'A-1'), summary: 'Local' });
    await saving;
    assert.equal(h.current.assignee?.name, 'Ada');
    h.mutations.receive(tab(), remote, during);
    assert.equal(h.current.summary, 'Local');
    assert.equal(h.view.snapshots.two.issues[1].summary, 'Local');
    h.mutations.endRefresh(before);
    h.mutations.endRefresh(during);
    const latest = h.mutations.revision;
    h.mutations.receive(tab(), remote, latest);
    assert.equal(h.current.summary, 'A-2');
  });

  it('optimistically resolves priority, assignee and status from edit metadata', async () => {
    const request = deferred<Issue>();
    const h = harness({ update: () => request.promise });
    const saving = h.mutations.update(
      'jira',
      'A-2',
      { priorityId: '2', assigneeId: 'ada', transitionId: 'finish' },
      options,
    );
    assert.equal(h.current.priority?.name, 'Low');
    assert.equal(h.current.assignee?.name, 'Ada');
    assert.equal(h.current.status.name, 'Done');
    request.reject(new Error('Workflow changed'));
    await saving;
    assert.equal(h.current.priority?.name, 'High');
    assert.equal(h.current.assignee, null);
    assert.equal(h.current.status.name, 'Open');
  });

  it('rolls back rank across tabs without rolling back a subsequent field edit', async () => {
    const request = deferred<void>();
    const h = harness({
      rank: () => request.promise,
      update: async () => ({ ...issue('A-2', 'A-1'), summary: 'New' }),
    });
    const rank = h.mutations.rank('jira', 'A-4', 'A-2');
    const edit = h.mutations.update('jira', 'A-2', { summary: 'New' });
    assert.deepEqual(
      h.view.snapshots.two.issues.map((value) => value.key),
      ['A-1', 'A-4', 'A-2', 'A-3'],
    );
    request.reject(new Error('No ranking'));
    await rank;
    await edit;
    assert.deepEqual(
      h.view.snapshots.one.issues.map((value) => value.key),
      ['A-1', 'A-2', 'A-3', 'A-4'],
    );
    assert.equal(h.current.summary, 'New');
  });

  it('does not restore a closed tab when a mutation settles', async () => {
    const request = deferred<Issue>();
    const h = harness({ update: () => request.promise });
    const edit = h.mutations.update('jira', 'A-2', { summary: 'New' });
    h.mutations.forget('one');
    request.resolve({ ...issue('A-2', 'A-1'), summary: 'New' });
    await edit;
    assert.equal(h.view.snapshots.one, undefined);
    assert.equal(h.view.snapshots.two.issues[1].summary, 'New');
  });
});

describe('validated undo', () => {
  it('restores a field after validating Jira and removes the history entry', async () => {
    let current = issue('A-2', 'A-1');
    const patches: unknown[] = [];
    const h = harness({
      update: async (_id, _key, patch) => {
        patches.push(patch);
        current = { ...current, summary: patch.summary! };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
    });
    await h.mutations.update('jira', 'A-2', { summary: 'New' });
    await h.mutations.undo();
    assert.equal(h.current.summary, 'A-2');
    assert.equal(h.view.undoLabel, undefined);
    assert.deepEqual(patches, [{ summary: 'New' }, { summary: 'A-2' }]);
  });

  it('searches for the previous assignee outside the initial suggestions before undoing', async () => {
    const prior = { id: 'sam', name: 'Sam Rivera' };
    let current = {
      ...issue('A-2', 'A-1'),
      assignee: prior as Issue['assignee'],
    };
    const queries: (string | undefined)[] = [];
    const h = harness({
      update: async (_id, _key, patch) => {
        current = {
          ...current,
          assignee: patch.assigneeId === null ? null : prior,
        };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
      editOptions: async (_id, _key, query) => {
        queries.push(query);
        return query === prior.name
          ? { ...options, assignees: [prior] }
          : options;
      },
    });
    const original = snapshot();
    original.issues[1] = current;
    h.mutations.receive(tab(), original, h.mutations.revision);
    await h.mutations.update('jira', 'A-2', { assigneeId: null }, options);
    await h.mutations.undo();
    assert.deepEqual(queries, [undefined, 'Sam Rivera']);
    assert.equal(h.current.assignee?.id, 'sam');
    assert.equal(h.view.undoLabel, undefined);
    assert.deepEqual(h.errors, []);
  });

  it('refuses to overwrite a remotely changed field', async () => {
    let calls = 0;
    const h = harness({
      update: async () => {
        calls++;
        return { ...issue('A-2', 'A-1'), summary: 'New' };
      },
    });
    await h.mutations.update('jira', 'A-2', { summary: 'New' });
    await h.mutations.undo();
    assert.equal(calls, 1);
    assert.match(h.errors[0], /field changed in Jira/);
  });

  it('restores the final sibling using rank-after and rejects changed sibling order', async () => {
    const ranks: unknown[] = [];
    let remote = snapshot();
    const h = harness({
      rank: async (_id, key, anchor, position) => {
        ranks.push([key, anchor, position]);
      },
      tree: async () => remote,
    });
    await h.mutations.rank('jira', 'A-4', 'A-2');
    remote = h.view.snapshots.one;
    await h.mutations.undo();
    assert.deepEqual(ranks, [
      ['A-4', 'A-2', 'before'],
      ['A-4', 'A-3', 'after'],
    ]);
    assert.deepEqual(
      h.view.snapshots.two.issues.map((value) => value.key),
      ['A-1', 'A-2', 'A-3', 'A-4'],
    );
    await h.mutations.rank('jira', 'A-4', 'A-2');
    remote = snapshot();
    await h.mutations.undo();
    assert.match(h.errors.at(-1)!, /Sibling order changed/);
    assert.equal(ranks.length, 3);
  });

  it('requires a current supported reverse workflow transition', async () => {
    let current = issue('A-2', 'A-1');
    let calls = 0;
    const h = harness({
      update: async () => {
        calls++;
        current = { ...current, status: options.transitions[0].to! };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
    });
    await h.mutations.update(
      'jira',
      'A-2',
      { transitionId: 'finish' },
      options,
    );
    await h.mutations.undo();
    assert.equal(calls, 1);
    assert.match(h.errors[0], /no supported transition back/);
    assert.equal(h.view.undoLabel, undefined);
  });

  it('aborts undo if another local edit starts during remote validation', async () => {
    const validation = deferred<TreeSnapshot>();
    let calls = 0;
    const h = harness({
      update: async (_id, key, patch) => {
        calls++;
        return { ...issue(key, 'A-1'), summary: patch.summary! };
      },
      tree: () => validation.promise,
    });
    await h.mutations.update('jira', 'A-2', { summary: 'New' });
    const undo = h.mutations.undo();
    await h.mutations.update('jira', 'A-3', { summary: 'Other' });
    validation.resolve({
      ...snapshot(),
      issues: [{ ...issue('A-2', 'A-1'), summary: 'New' }],
    });
    await undo;
    assert.equal(calls, 2);
    assert.match(h.errors[0], /Another edit started/);
  });
});
