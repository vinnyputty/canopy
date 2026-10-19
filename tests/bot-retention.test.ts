import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { MutationView } from '../src/renderer/mutations';
import type { Issue, TabState, TreeSnapshot } from '../src/shared/types';
import {
  boundRoots,
  markRootSeen,
  markIssueSeen,
  seenRootKey,
  seedOrExtend,
  unseenChanges,
} from '../src/renderer/seen';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source = process.env.CANOPY_BOT_SOURCE;
const require = createRequire(import.meta.url);
const { Mutations } = require(
  source ? `${source}/src/renderer/mutations.ts` : '../src/renderer/mutations',
);
const { RootRefreshGate } = require(
  source ? `${source}/src/renderer/refresh.ts` : '../src/renderer/refresh',
);
const issue = (key: string): Issue => ({
  id: key,
  key,
  summary: 'Unicode 界 😀',
  type: 'Task',
  priority: null,
  assignee: null,
  links: [],
  status: { id: 'open', name: 'Open', category: 'new' },
});
const tab: TabState = {
  id: 'a',
  connectionId: 'work',
  rootKey: 'A-0',
  expanded: [],
  hideDone: false,
  scrollTop: 0,
};
const snap = (issues: Issue[], fetchedAt = 1): TreeSnapshot => ({
  rootKey: 'A-0',
  issues,
  fetchedAt,
  warnings: ['Unicode 界'],
});
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('actual optimistic publishes reuse immutable issue sizes with exact conservative owner accounting', async () => {
  let view!: MutationView, release!: (issue: Issue) => void;
  const rows = Array.from({ length: 2000 }, (_, i) => issue(`A-${i}`));
  const old = snap(rows),
    gate = snap(rows.slice(), 2),
    displayed = issue('old-displayed');
  const mutations = new Mutations(
    { update: () => new Promise<Issue>((r) => (release = r)) } as any,
    (v: MutationView) => (view = v),
    () => {},
    undefined,
    100_000_000,
    () => [gate, gate],
    () => [rows[1], displayed],
  );
  mutations.receive(tab, old, 0);
  mutations.protectSnapshots(['a']);
  const original = JSON.stringify;
  let fullArrays = 0,
    issueEncodes = 0,
    accountingDepth = 0;
  const serializedSize = Reflect.get(mutations, 'serializedSize');
  Reflect.set(
    mutations,
    'serializedSize',
    function (this: unknown, value: unknown) {
      accountingDepth++;
      try {
        return serializedSize.call(this, value);
      } finally {
        accountingDepth--;
      }
    },
  );
  JSON.stringify = ((value: any, ...args: any[]) => {
    if (accountingDepth && value?.issues?.length) fullArrays++;
    if (accountingDepth && value?.key?.startsWith('A-')) issueEncodes++;
    return (original as any)(value, ...args);
  }) as typeof JSON.stringify;
  try {
    const pending = mutations.update('work', 'A-1', { summary: 'pending' });
    await tick();
    for (let i = 0; i < 10; i++) mutations.protectSnapshots(['a']);
    assert.equal(
      fullArrays,
      0,
      'no full retained issue-array serialization during optimistic admission',
    );
    assert.ok(
      issueEncodes <= 12,
      `only changed immutable issues may encode, saw ${issueEncodes}`,
    );
    const owners = new Set<TreeSnapshot>([
      view.confirmedSnapshots.a,
      view.snapshots.a,
      gate,
    ]);
    const exact =
      [...owners].reduce((n, s) => n + Buffer.byteLength(original(s)), 0) +
      Buffer.byteLength(original(displayed));
    assert.equal(Reflect.get(mutations, 'snapshotSizes').get('a'), exact);
    release({ ...rows[1], summary: 'pending' });
    await pending;
  } finally {
    JSON.stringify = original;
  }
});

for (const reject of [false, true])
  test(`actual queued-to-active invalidation releases ${reject ? 'rejected' : 'resolved'} raw promise and allows user retry`, async () => {
    const gate = new RootRefreshGate(() => 0);
    let first!: (v: object) => void, finish!: (v?: any) => void;
    let calls = 0;
    const auto = gate.load('root', false, true, () => {
      calls++;
      return new Promise((r) => (first = r));
    });
    const queued = gate.load('root', true, false, () => {
      calls++;
      return new Promise(
        (resolve, rejectPromise) => (finish = reject ? rejectPromise : resolve),
      );
    });
    assert.ok('promise' in auto && 'promise' in queued);
    first({ auto: true });
    await auto.promise;
    await tick();
    assert.equal(calls, 2);
    gate.invalidateQueued('root');
    const outcome = queued.promise.catch((error: unknown) => error);
    finish(reject ? new Error('cancelled provider') : { complete: true });
    await outcome;
    await tick();
    const retry = gate.load('root', true, false, async () => {
      calls++;
      return { retried: true };
    });
    assert.ok('promise' in retry);
    await retry.promise;
    assert.equal(calls, 3);
  });

test('unread admission pressure retains referenced and unknown baselines across close/reopen and refresh', () => {
  const roots = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `work:A-${i}`,
      markRootSeen(snap([issue(`A-${i}`)]), undefined, 1),
    ]),
  );
  const changed = { ...issue('A-0'), summary: 'remote unread' };
  const workspace = {
    tabs: [tab],
    closedTabs: [{ ...tab, id: 'closed', rootKey: 'A-1' }],
    pinnedRoots: [{ connectionId: 'work', rootKey: 'A-2' }],
    savedViews: [{ roots: [{ connectionId: 'work', rootKey: 'A-3' }] }],
    seenRoots: roots,
  };
  const proposed = {
    ...roots,
    'work:new': seedOrExtend(undefined, snap([issue('new')])),
  };
  const retained = boundRoots(proposed, workspace.seenRoots);
  assert.deepEqual(retained, roots);
  assert.equal(
    unseenChanges(retained['work:A-0'].issues['A-0'], changed).fields.length,
    1,
  );
  const closed = {
    ...workspace,
    tabs: [],
    closedTabs: [...workspace.closedTabs, tab],
    seenRoots: retained,
  };
  assert.deepEqual(boundRoots(proposed, closed.seenRoots), roots);
  const full = markRootSeen(
    snap(Array.from({ length: 1000 }, (_, i) => issue(`A-${i}`))),
    undefined,
    1,
  );
  const extended = boundRoots(
    { 'work:full': seedOrExtend(full, snap([issue('A-new')])) },
    { 'work:full': full },
  );
  assert.equal(Object.keys(extended['work:full'].issues).length, 1000);
  assert.deepEqual(extended['work:full'].issues, full.issues);
  // Real App always supplies the previous map at refresh, issue and root marks.
  const text = readFileSync(
      new URL('../src/renderer/App.tsx', import.meta.url),
      'utf8',
    ),
    ast = ts.createSourceFile(
      'App.tsx',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  const admissionCallbacks: ts.ArrowFunction[] = [];
  let calls = 0,
    banner: ts.JsxElement | undefined;
  function walk(n: ts.Node) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'boundRoots') {
      assert.equal(n.arguments[1].getText(ast), 'current.seenRoots ?? {}');
      let parent: ts.Node = n.parent;
      while (!ts.isArrowFunction(parent)) parent = parent.parent;
      admissionCallbacks.push(parent);
      calls++;
    }
    if (
      ts.isJsxElement(n) &&
      n.openingElement.getText(ast).includes('role="status"') &&
      n.getText(ast).includes('Closing tabs or marking issues')
    )
      banner = n;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  assert.equal(calls, 3);
  for (const callback of admissionCallbacks) {
    const update = vm.runInNewContext(
      ts.transpileModule(`(${callback.getText(ast)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        boundRoots,
        markIssueSeen,
        markRootSeen,
        seedOrExtend,
        seenRootKey,
        rootKey: 'work:new',
        tab: { ...tab, rootKey: 'new' },
        issue: issue('new'),
        confirmed: snap([issue('new')]),
        confirmedSnapshot: snap([issue('new')]),
        Date,
      },
    );
    const result = update(closed);
    assert.deepEqual(result.seenRoots, roots);
    assert.deepEqual(result.closedTabs, closed.closedTabs);
    assert.deepEqual(result.pinnedRoots, closed.pinnedRoots);
    assert.deepEqual(result.savedViews, closed.savedViews);
  }
  assert.ok(banner);
  const rendered = vm.runInNewContext(
    ts.transpileModule(`(${banner!.getText(ast)})`, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      React: {
        createElement: (
          _tag: unknown,
          _props: unknown,
          ...children: unknown[]
        ) => children.join(''),
      },
    },
  );
  assert.match(rendered, /new roots or issues cannot be tracked/);
  assert.match(rendered, /does not release space/);
});
