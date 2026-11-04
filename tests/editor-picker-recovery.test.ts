import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { Pickers, type PickerOptions } from '../src/renderer/pickers';
import { callback, execute, findNode, sourceFile } from './source-probe';

const app = sourceFile(
  process.env.CANOPY_EDITOR_PICKER_SOURCE ??
    new URL('../src/renderer/App.tsx', import.meta.url),
);
const recovery = findNode(
  app,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.arguments[0]?.getText().includes('pickers.open(') &&
    node.arguments[0]?.getText().includes('options['),
).arguments[0].getText();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Editor = {
  tabId: string;
  connectionId: string;
  key: string;
  field: 'summary' | 'priority' | 'assignee' | 'status';
};

function fixture() {
  const choice = { id: 'high', name: 'High' };
  const fresh = deferred<(typeof choice)[]>();
  let priorityReads = 0;
  const pending: Promise<void>[] = [];
  const opened: unknown[][] = [];
  const scope = {
    useCallback: (run: unknown) => run,
    editor: null as Editor | null,
    options: {} as Record<string, PickerOptions>,
    activeTab: { id: 'tab', connectionId: 'work', rootKey: 'CAN-100' },
    activeConnection: { provider: 'jira' },
    view: { assumeMatchingStatusTransitions: true },
    snapshot: { issues: [] },
    editSession: { current: 0 },
    activeIdRef: { current: 'tab' },
    mutations: { update: async () => true },
    setEditor: (
      next: Editor | null | ((current: Editor | null) => Editor | null),
    ) => {
      scope.editor = typeof next === 'function' ? next(scope.editor) : next;
    },
    pickers: null as unknown as Pickers,
  };
  const pickers = new Pickers(
    {
      priorities: async () =>
        ++priorityReads === 1 ? [choice] : fresh.promise,
      transitions: async () => [],
      cachedUsers: async () => [choice],
      assignees: async () => ({ users: [choice] }),
      validateAssignee: async () => choice,
    },
    (values) => {
      scope.options = values;
    },
  );
  const open = pickers.open.bind(pickers);
  pickers.open = (...args) => {
    opened.push(args);
    const result = open(...args);
    pending.push(result);
    return result;
  };
  scope.pickers = pickers;
  const run = () => execute(recovery, scope)();
  const begin = execute(callback(app, 'beginEdit'), scope);
  const update = execute(callback(app, 'updateIssue'), scope);
  return { scope, pickers, run, begin, update, pending, opened, fresh, choice };
}

for (const outcome of ['success', 'error', 'closed', 'other issue'] as const)
  test(`a late status completion reloads an active priority picker: ${outcome}`, async () => {
    const f = fixture();
    const picker = (): PickerOptions | undefined =>
      f.scope.options['work:CAN-111'];
    const status = deferred<boolean>();
    f.scope.mutations.update = () => status.promise;
    const saving = f.update('CAN-111', { transitionId: 'progress' });
    f.begin('CAN-111', 'priority');
    await f.pending[0];
    assert.deepEqual(picker()?.priorities, [f.choice]);
    f.run();
    assert.equal(f.opened.length, 1);

    status.resolve(true);
    await saving;
    assert.equal(picker(), undefined);
    f.run();
    assert.equal(f.opened.length, 2);
    assert.equal(picker()?.priority?.loading, true);
    f.run();
    assert.equal(f.opened.length, 2, 'loading metadata must not load again');

    if (outcome === 'closed') f.scope.editor = null;
    if (outcome === 'other issue')
      f.scope.editor = {
        tabId: 'tab',
        connectionId: 'work',
        key: 'CAN-112',
        field: 'summary',
      };
    const editor = f.scope.editor;
    if (outcome === 'error')
      f.fresh.reject(new Error('Priority access denied'));
    else f.fresh.resolve([{ id: 'low', name: 'Low' }]);
    await f.pending[1];
    assert.equal(
      f.scope.editor,
      editor,
      'a late load must not reopen an editor',
    );
    if (outcome === 'error')
      assert.equal(picker()?.priority?.error, 'Priority access denied');
    else assert.deepEqual(picker()?.priorities, [{ id: 'low', name: 'Low' }]);
    f.run();
    assert.equal(
      f.opened.length,
      2,
      'ready and failed loads must not auto-retry',
    );
  });

for (const field of ['priority', 'assignee', 'status'] as const)
  for (const state of [
    'missing',
    'loading',
    'error',
    'ready',
    'empty',
    'data only',
  ] as const)
    test(`recovery loads only absent ${field} metadata: ${state}`, async () => {
      const f = fixture();
      f.scope.editor = {
        tabId: 'tab',
        connectionId: 'work',
        key: 'CAN-111',
        field,
      };
      const data =
        field === 'priority'
          ? 'priorities'
          : field === 'assignee'
            ? 'assignees'
            : 'transitions';
      const value =
        state === 'missing'
          ? {}
          : state === 'loading'
            ? { [field]: { loading: true } }
            : state === 'error'
              ? { [field]: { error: 'Denied' } }
              : state === 'ready'
                ? { [field]: {} }
                : { [data]: state === 'empty' ? [] : [f.choice] };
      f.scope.options['work:CAN-111'] = value;
      f.run();
      assert.equal(f.opened.length, state === 'missing' ? 1 : 0);
      await Promise.all(f.pending);
      f.run();
      assert.equal(f.opened.length, state === 'missing' ? 1 : 0);
    });

for (const owner of [
  'none',
  'summary',
  'other tab',
  'other connection',
] as const)
  test(`metadata recovery respects editor ownership: ${owner}`, () => {
    const f = fixture();
    f.scope.editor =
      owner === 'none'
        ? null
        : {
            tabId: owner === 'other tab' ? 'other' : 'tab',
            connectionId: owner === 'other connection' ? 'other' : 'work',
            key: 'CAN-111',
            field: owner === 'summary' ? 'summary' : 'priority',
          };
    f.run();
    assert.equal(f.opened.length, 0);
  });
