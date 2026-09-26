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
  ranking: { state: 'supported', issueKeys: ['A-2', 'A-3', 'A-4'] },
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
function harness(
  overrides: Partial<CanopyAPI> = {},
  confirmed?: (connectionId: string, issue: Issue, fields: string[]) => void,
) {
  let view!: MutationView;
  const errors: string[] = [];
  const api = {
    update: async (_connection: string, key: string) => issue(key, 'A-1'),
    rank: async () => {},
    tree: async () => snapshot(),
    priorities: async () => options.priorities,
    transitions: async () => options.transitions,
    validateAssignee: async (
      _connection: string,
      _key: string,
      id: string,
    ) => ({ id, name: id }),
    ...overrides,
  };
  const mutations = new Mutations(
    api,
    (next) => (view = next),
    (message) => errors.push(message),
    confirmed,
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
  it('skips a queued restoration when a manual edit saved first', async () => {
    const manual = deferred<Issue>();
    const writes: string[] = [];
    const h = harness({
      update: async (_connection, _key, patch) => {
        writes.push(patch.priorityId!);
        return manual.promise;
      },
    });
    const edit = h.mutations.update(
      'jira',
      'A-2',
      { priorityId: '2' },
      options,
    );
    const restore = h.mutations.update(
      'jira',
      'A-2',
      { priorityId: '1' },
      undefined,
      false,
      undefined,
      (current) => current?.priority?.id === '1',
    );
    manual.resolve({
      ...issue('A-2', 'A-1'),
      priority: options.priorities[1],
    });
    await Promise.all([edit, restore]);
    assert.deepEqual(writes, ['2']);
    assert.equal(h.current.priority?.id, '2');
  });

  it('undoes a selected issue without consuming another issue’s history', async () => {
    const remote = snapshot();
    const h = harness({
      update: async (_connection, key, patch) => {
        const current = remote.issues.find((value) => value.key === key)!;
        const changed = {
          ...current,
          summary: patch.summary ?? current.summary,
        };
        remote.issues = remote.issues.map((value) =>
          value.key === key ? changed : value,
        );
        return changed;
      },
      tree: async () => remote,
    });
    assert.equal(
      await h.mutations.update('jira', 'A-2', { summary: 'Second' }),
      true,
    );
    assert.equal(
      await h.mutations.update('jira', 'A-3', { summary: 'Third' }),
      true,
    );
    assert.equal(h.mutations.canUndo('jira', 'A-2'), true);
    assert.equal(await h.mutations.undo('jira', 'A-2'), true);
    assert.equal(
      remote.issues.find((value) => value.key === 'A-2')?.summary,
      'A-2',
    );
    assert.equal(
      remote.issues.find((value) => value.key === 'A-3')?.summary,
      'Third',
    );
    assert.equal(h.mutations.canUndo('jira', 'A-2'), false);
    assert.equal(h.mutations.canUndo('jira', 'A-3'), true);
  });
  it('keeps a bulk Undo bound to its saved edit when the issue is edited again', async () => {
    const remote = snapshot();
    const writes: string[] = [];
    const h = harness({
      update: async (_connection, key, patch) => {
        writes.push(patch.summary!);
        const current = remote.issues.find((value) => value.key === key)!;
        const changed = { ...current, summary: patch.summary! };
        remote.issues = remote.issues.map((value) =>
          value.key === key ? changed : value,
        );
        return changed;
      },
      tree: async () => remote,
    });
    const bulk = Symbol('bulk edit');
    assert.equal(
      await h.mutations.update(
        'jira',
        'A-2',
        { summary: 'Bulk' },
        undefined,
        true,
        bulk,
      ),
      true,
    );
    assert.equal(h.mutations.canUndo('jira', 'A-2', bulk), true);
    assert.equal(
      await h.mutations.update('jira', 'A-2', { summary: 'Manual' }),
      true,
    );
    assert.equal(h.mutations.canUndo('jira', 'A-2', bulk), false);
    assert.equal(await h.mutations.undo('jira', 'A-2', bulk), false);
    assert.equal(h.current.summary, 'Manual');
    assert.deepEqual(writes, ['Bulk', 'Manual']);
    assert.equal(await h.mutations.undo('jira', 'A-2'), true);
    assert.equal(h.mutations.canUndo('jira', 'A-2', bulk), true);
    assert.equal(await h.mutations.undo('jira', 'A-2', bulk), true);
    assert.equal(h.current.summary, 'A-2');
    assert.deepEqual(writes, ['Bulk', 'Manual', 'Bulk', 'A-2']);
  });
  it('reports confirmed own fields only after the provider accepts a write', async () => {
    const request = deferred<Issue>();
    const confirmed: Array<{ summary: string; fields: string[] }> = [];
    const h = harness(
      { update: () => request.promise },
      (_connection, value, fields) =>
        confirmed.push({ summary: value.summary, fields }),
    );
    // The rendered state is optimistic; confirmed state stays at the prior value.
    const writing = h.mutations.update('jira', 'A-2', { summary: 'Draft' });
    assert.equal(h.current.summary, 'Draft');
    assert.equal(h.view.confirmedSnapshots.one.issues[1].summary, 'A-2');
    assert.equal(h.mutations.pending('jira'), true);
    assert.deepEqual(confirmed, []);
    request.resolve({ ...issue('A-2', 'A-1'), summary: 'Saved' });
    assert.equal(await writing, true);
    assert.equal(h.current.summary, 'Saved');
    assert.equal(h.view.confirmedSnapshots.one.issues[1].summary, 'Saved');
    assert.deepEqual(confirmed, [{ summary: 'Saved', fields: ['summary'] }]);
  });
  it('inserts a created child across overlapping tabs and keeps it through a stale refresh', () => {
    const h = harness();
    h.mutations.insertCreated('jira', issue('A-5', 'A-2'));
    for (const id of ['one', 'two'])
      assert.ok(
        h.view.snapshots[id].issues.some((value) => value.key === 'A-5'),
      );
    assert.equal(
      h.view.snapshots.other.issues.some((value) => value.key === 'A-5'),
      false,
    );
    h.mutations.receive(tab(), snapshot(), h.mutations.revision);
    assert.ok(h.view.snapshots.one.issues.some((value) => value.key === 'A-5'));
    const current = snapshot();
    current.issues.push(issue('A-5', 'A-2'));
    h.mutations.receive(tab(), current, h.mutations.revision);
    h.mutations.receive(tab('two'), snapshot(), h.mutations.revision);
    assert.ok(h.view.snapshots.two.issues.some((value) => value.key === 'A-5'));
  });
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

  it('serializes sibling ranks and preserves a newer move when the earlier rank fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const calls: string[] = [];
    const h = harness({
      rank: async (_id, key) => {
        calls.push(key);
        return calls.length === 1 ? first.promise : second.promise;
      },
    });
    const a = h.mutations.rank('jira', 'A-4', 'A-2');
    const b = h.mutations.rank('jira', 'A-3', 'A-2');
    await tick();
    assert.deepEqual(calls, ['A-4']);
    first.reject(new Error('First rank rejected'));
    await a;
    await tick();
    assert.deepEqual(calls, ['A-4', 'A-3']);
    assert.deepEqual(
      h.view.snapshots.two.issues.map((value) => value.key),
      ['A-1', 'A-3', 'A-2', 'A-4'],
    );
    second.resolve();
    await b;
    assert.deepEqual(
      h.view.snapshots.one.issues.map((value) => value.key),
      ['A-1', 'A-3', 'A-2', 'A-4'],
    );
    assert.equal(h.view.saving.size, 0);
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
      validateAssignee: async (_id, _key, accountId, refresh) => {
        queries.push(accountId);
        assert.equal(refresh, true);
        return prior;
      },
    });
    const original = snapshot();
    original.issues[1] = current;
    h.mutations.receive(tab(), original, h.mutations.revision);
    await h.mutations.update('jira', 'A-2', { assigneeId: null }, options);
    await h.mutations.undo();
    assert.deepEqual(queries, ['sam']);
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

  it('rejects rank undo when a former sibling was removed remotely', async () => {
    let ranks = 0;
    let remote = snapshot();
    const h = harness({
      rank: async () => {
        ranks++;
      },
      tree: async () => remote,
    });
    await h.mutations.rank('jira', 'A-4', 'A-2');
    remote = {
      ...h.view.snapshots.one,
      issues: h.view.snapshots.one.issues.filter(
        (value) => value.key !== 'A-3',
      ),
    };
    await h.mutations.undo();
    assert.equal(ranks, 1);
    assert.match(h.errors[0], /Sibling order changed/);
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

describe('undo audit regressions', () => {
  it('preserves older history when a newer same-field edit finishes during validation', async () => {
    let current = issue('A-2', 'A-1');
    const validation = deferred<TreeSnapshot>();
    let reads = 0;
    const h = harness({
      update: async (_id, _key, patch) => {
        current = { ...current, summary: patch.summary! };
        return current;
      },
      tree: async () =>
        ++reads === 1
          ? validation.promise
          : { ...snapshot(), issues: [current] },
    });
    await h.mutations.update('jira', 'A-2', { summary: 'First' });
    const undo = h.mutations.undo();
    await h.mutations.update('jira', 'A-2', { summary: 'Second' });
    validation.resolve({ ...snapshot(), issues: [current] });
    await undo;
    assert.match(h.errors[0], /Another edit started/);
    await h.mutations.undo();
    assert.equal(h.current.summary, 'First');
    await h.mutations.undo();
    assert.equal(h.current.summary, 'A-2');
  });

  it('preserves history when another edit completes during workflow-option validation', async () => {
    let current = issue('A-2', 'A-1');
    const validation = deferred<EditOptions['priorities']>();
    let reads = 0;
    const h = harness({
      update: async (_id, _key, patch) => {
        current = {
          ...current,
          priority: options.priorities.find(
            (choice) => choice.id === patch.priorityId,
          )!,
        };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
      priorities: async () =>
        ++reads === 1 ? validation.promise : options.priorities,
    });
    await h.mutations.update('jira', 'A-2', { priorityId: '2' }, options);
    const undo = h.mutations.undo();
    await tick();
    await h.mutations.update('jira', 'A-2', { priorityId: '1' }, options);
    validation.resolve([]);
    await undo;
    assert.match(h.errors[0], /Another edit started/);
    await h.mutations.undo();
    assert.equal(h.current.priority?.id, '2');
    await h.mutations.undo();
    assert.equal(h.current.priority?.id, '1');
  });

  it('retries transient undo reads and inverse write failures without losing history', async () => {
    let current = issue('A-2', 'A-1');
    let readFailures = 1;
    let writeFailures = 0;
    const h = harness({
      update: async (_id, _key, patch) => {
        if (writeFailures-- > 0) throw new Error('Write unavailable');
        current = { ...current, summary: patch.summary! };
        return current;
      },
      tree: async () => {
        if (readFailures-- > 0) throw new Error('Read unavailable');
        return { ...snapshot(), issues: [current] };
      },
    });
    await h.mutations.update('jira', 'A-2', { summary: 'New' });
    await h.mutations.undo();
    assert.match(h.errors[0], /Read unavailable/);
    assert.ok(h.view.undoLabel);
    writeFailures = 1;
    await h.mutations.undo();
    assert.match(h.errors[1], /Write unavailable/);
    assert.equal(h.current.summary, 'New');
    assert.ok(h.view.undoLabel);
    await h.mutations.undo();
    assert.equal(h.current.summary, 'A-2');
    assert.equal(h.view.undoLabel, undefined);
  });

  it('uses a safe reverse transition and skips one that requires additional fields', async () => {
    let current = issue('A-2', 'A-1');
    const transitions: string[] = [];
    const open = current.status;
    const h = harness({
      update: async (_id, _key, patch) => {
        transitions.push(patch.transitionId!);
        current = {
          ...current,
          status:
            patch.transitionId === 'finish' ? options.transitions[0].to! : open,
        };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
      transitions: async () => [
        {
          id: 'requires-fields',
          name: 'Reopen with fields',
          requiresFields: true,
          to: open,
        },
        {
          id: 'safe-reopen',
          name: 'Reopen',
          requiresFields: false,
          to: open,
        },
      ],
    });
    await h.mutations.update(
      'jira',
      'A-2',
      { transitionId: 'finish' },
      options,
    );
    await h.mutations.undo();
    assert.deepEqual(transitions, ['finish', 'safe-reopen']);
    assert.equal(h.current.status.id, 'open');
  });

  it('skips an unsupported inverse so an earlier supported edit remains undoable', async () => {
    let current = {
      ...issue('A-2', 'A-1'),
      priority: null as Issue['priority'],
    };
    const h = harness({
      update: async (_id, _key, patch) => {
        current = {
          ...current,
          ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
          ...(patch.priorityId
            ? {
                priority: options.priorities.find(
                  (choice) => choice.id === patch.priorityId,
                )!,
              }
            : {}),
        };
        return current;
      },
      tree: async () => ({ ...snapshot(), issues: [current] }),
    });
    const original = snapshot();
    original.issues[1] = current;
    h.mutations.receive(tab(), original, 0);
    await h.mutations.update('jira', 'A-2', { summary: 'New' });
    await h.mutations.update('jira', 'A-2', { priorityId: '2' }, options);
    await h.mutations.undo();
    assert.match(h.errors[0], /empty priority/);
    await h.mutations.undo();
    assert.equal(h.current.summary, 'A-2');
    assert.equal(h.current.priority?.id, '2');
  });

  it('keeps earlier confirmed values under a queued edit and late refresh responses', async () => {
    const first = deferred<Issue>();
    const second = deferred<Issue>();
    let calls = 0;
    const h = harness({
      update: () => (++calls === 1 ? first.promise : second.promise),
    });
    const refresh1 = h.mutations.beginRefresh();
    const a = h.mutations.update('jira', 'A-2', { summary: 'First' });
    const b = h.mutations.update('jira', 'A-2', { summary: 'Second' });
    first.resolve({ ...issue('A-2', 'A-1'), summary: 'First' });
    await a;
    assert.equal(h.current.summary, 'Second');
    const refresh2 = h.mutations.beginRefresh();
    h.mutations.receive(tab('two'), snapshot(), refresh1);
    h.mutations.endRefresh(refresh1);
    assert.equal(h.view.snapshots.two.issues[1].summary, 'Second');
    second.resolve({ ...issue('A-2', 'A-1'), summary: 'Second' });
    await b;
    h.mutations.receive(tab(), snapshot(), refresh2);
    h.mutations.endRefresh(refresh2);
    assert.equal(h.current.summary, 'Second');
    assert.equal(h.view.saving.size, 0);
  });
});

describe('ranking capability integration', () => {
  for (const state of [
    'unsupported',
    'unknown',
    'missing',
    'excluded',
  ] as const) {
    it(`does not send inverse rank after fresh capability becomes ${state}`, async () => {
      let calls = 0;
      let fresh = snapshot();
      const h = harness({
        rank: async () => {
          calls++;
        },
        tree: async () => fresh,
      });
      await h.mutations.rank('jira', 'A-4', 'A-2');
      fresh = {
        ...h.view.snapshots.one,
        ranking:
          state === 'missing'
            ? undefined
            : {
                state: state === 'excluded' ? 'supported' : state,
                issueKeys: [],
              },
      };
      await h.mutations.undo();
      assert.equal(calls, 1);
      assert.match(h.errors[0], /Ranking is no longer available/);
    });
    it(`does not optimistically reorder or write with ${state} cached capability`, async () => {
      let calls = 0;
      const h = harness({
        rank: async () => {
          calls++;
        },
      });
      const next = {
        ...snapshot(),
        ranking:
          state === 'missing'
            ? undefined
            : {
                state: state === 'excluded' ? ('supported' as const) : state,
                issueKeys: [],
              },
      };
      h.mutations.receive(tab(), next, h.mutations.revision);
      const attempt = h.mutations.rank('jira', 'A-4', 'A-2');
      assert.deepEqual(
        h.view.snapshots.one.issues.map((issue) => issue.key),
        ['A-1', 'A-2', 'A-3', 'A-4'],
      );
      await attempt;
      assert.equal(calls, 0);
      assert.deepEqual(
        h.view.snapshots.one.issues.map((issue) => issue.key),
        ['A-1', 'A-2', 'A-3', 'A-4'],
      );
    });
  }
});

describe('refresh deferral contract', () => {
  it('scopes pending writes and inverse writes to their connection until settled', async () => {
    const write = deferred<Issue>();
    const inverse = deferred<Issue>();
    const undoStarted = deferred<void>();
    let updates = 0;
    const changed = { ...issue('A-2', 'A-1'), summary: 'Changed' };
    const h = harness({
      update: async () => {
        if (++updates === 1) return write.promise;
        undoStarted.resolve();
        return inverse.promise;
      },
      tree: async () => ({ ...snapshot(), issues: [changed] }),
    });
    const pending = h.mutations.update('jira', 'A-2', { summary: 'Changed' });
    assert.equal(h.mutations.pending('jira'), true);
    assert.equal(h.mutations.pending('other'), false);
    assert.equal(h.current.summary, 'Changed');
    write.resolve(changed);
    await pending;
    assert.equal(h.mutations.pending('jira'), false);
    const undo = h.mutations.undo();
    await undoStarted.promise;
    assert.equal(h.mutations.pending('jira'), true);
    assert.equal(h.mutations.pending('other'), false);
    assert.equal(h.current.summary, 'A-2');
    inverse.resolve(issue('A-2', 'A-1'));
    await undo;
    assert.equal(h.mutations.pending('jira'), false);
    assert.equal(h.view.undoLabel, undefined);
  });
});

it('skips an unassignable assignee inverse but retains transient lookup failures for retry', async () => {
  for (const transient of [false, true]) {
    const before = { id: 'prior', name: 'Prior' };
    let current = {
      ...issue('A-2', 'A-1'),
      assignee: before as Issue['assignee'],
    };
    const h = harness({
      update: async () => (current = { ...current, assignee: null }),
      tree: async () => ({ ...snapshot(), issues: [current] }),
      validateAssignee: async () => {
        if (transient) throw new Error('Lookup unavailable');
        return null;
      },
    });
    const original = snapshot();
    original.issues[1] = current;
    h.mutations.receive(tab(), original, 0);
    await h.mutations.update('jira', 'A-2', { assigneeId: null }, options);
    await h.mutations.undo();
    assert.equal(Boolean(h.view.undoLabel), transient);
    assert.match(
      h.errors[0],
      transient ? /Lookup unavailable/ : /no longer assignable/,
    );
  }
});
it('undoes summaries without any picker metadata dependency', async () => {
  let current = issue('A-2', 'A-1');
  const unavailable = async () => {
    throw new Error('Picker lookup must not run');
  };
  const h = harness({
    update: async (_id, _key, patch) =>
      (current = { ...current, summary: patch.summary! }),
    tree: async () => ({ ...snapshot(), issues: [current] }),
    priorities: unavailable,
    transitions: unavailable,
    validateAssignee: unavailable,
  });
  await h.mutations.update('jira', 'A-2', { summary: 'Changed' });
  await h.mutations.undo();
  assert.equal(h.current.summary, 'A-2');
  assert.deepEqual(h.errors, []);
});

it('keeps rank undo retryable while the provider preserves lagging sibling order', async () => {
  let catchingUp = true;
  let writes = 0;
  const h = harness({
    rank: async () => {
      writes++;
    },
    tree: async () => {
      const fresh = snapshot();
      fresh.issues = [
        fresh.issues[0]!,
        fresh.issues[3]!,
        fresh.issues[1]!,
        fresh.issues[2]!,
      ];
      if (catchingUp) fresh.reconcilingRankParents = ['A-1'];
      return fresh;
    },
  });
  await h.mutations.rank('jira', 'A-4', 'A-2');
  await h.mutations.undo();
  assert.equal(writes, 1);
  assert.match(h.errors.at(-1)!, /still catching up/);
  assert.ok(h.view.undoLabel);
  catchingUp = false;
  await h.mutations.undo();
  assert.equal(writes, 2);
  assert.equal(h.view.undoLabel, undefined);
});
