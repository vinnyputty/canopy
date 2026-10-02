import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Updates } from '../src/main/updates';
import type { UpdateState } from '../src/shared/updates';

function source(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return {
    ast,
    find(predicate: (n: ts.Node) => boolean) {
      let result: ts.Node | undefined;
      function visit(n: ts.Node) {
        if (predicate(n)) result = n;
        ts.forEachChild(n, visit);
      }
      visit(ast);
      assert.ok(result);
      return result;
    },
    execute(node: ts.Node, context: object) {
      return vm.runInNewContext(
        ts.transpileModule(`(${node.getText(ast)})`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
      );
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const storage = {
  read: async <T>() => null as T | null,
  write: async () => {},
};

test('actual main teardown cancels both an in-flight update check and tree/search controllers', async () => {
  let release!: () => void,
    updateSignal: AbortSignal | undefined,
    treeSignal: AbortSignal | undefined,
    finishTree!: (value: object) => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updates = new Updates(
    storage,
    '0.1.0',
    'darwin',
    'arm64',
    true,
    async (_page, signal) => {
      updateSignal = signal;
      await held;
      return { rows: [], more: false };
    },
  );
  const updateRead = updates.check();
  await tick();
  assert.ok(updateSignal);
  assert.equal(updateSignal.aborted, false);
  const main = source('../src/main/app.ts');
  const tree = (
    main.find(
      (n) => ts.isPropertyAssignment(n) && n.name.getText(main.ast) === 'tree',
    ) as ts.PropertyAssignment
  ).initializer;
  const destroyed = (
    main.find(
      (n) =>
        ts.isCallExpression(n) &&
        n.expression.getText(main.ast) === 'created.webContents.on' &&
        n.arguments[0].getText(main.ast) === "'destroyed'",
    ) as ts.CallExpression
  ).arguments[1];
  const trees = new Map(),
    searches = new Map([['search', new AbortController()]]),
    searchController = searches.get('search')!;
  const context = {
    updates,
    clearRelationshipRequests: () => {},
    trees,
    searches,
    AbortController,
    text: (value: string) => value,
    normalizedRoot: (_id: string, key: string) => key,
    provider: () => ({
      tree: (_key: string, options: { signal: AbortSignal }) => {
        treeSignal = options.signal;
        return new Promise((resolve) => {
          finishTree = resolve;
        });
      },
    }),
    window: {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error('Late progress must be suppressed');
        },
      },
    },
  };
  const treeRead = main.execute(tree, context)(
    'fixture',
    'ROOT-1',
    'tree-request',
  );
  assert.equal(trees.size, 1);
  assert.ok(treeSignal);
  assert.equal(treeSignal.aborted, false);
  main.execute(destroyed, context)();
  assert.equal(updateSignal.aborted, true);
  assert.equal(treeSignal.aborted, true);
  assert.equal(searchController.signal.aborted, true);
  assert.equal(trees.size, 0);
  assert.equal(searches.size, 0);
  release();
  finishTree({ rootKey: 'ROOT-1', issues: [], fetchedAt: 1, warnings: [] });
  await Promise.all([updateRead, treeRead]);
  assert.equal((await updates.snapshot()).release, undefined);
});

test('actual renderer update effect preserves default-off privacy and cleanup alongside issue-tree source hooks', async () => {
  let requests = 0;
  const updates = new Updates(
    storage,
    '0.1.0',
    'darwin',
    'arm64',
    true,
    async () => {
      requests++;
      throw new Error('Default-off must not reach release transport');
    },
  );
  const ui = source('../src/renderer/Updates.tsx');
  const effect = (
    ui.find(
      (n) =>
        ts.isCallExpression(n) && n.expression.getText(ui.ast) === 'useEffect',
    ) as ts.CallExpression
  ).arguments[0];
  const published: UpdateState[] = [];
  let interval: (() => void) | undefined,
    cleared = 0;
  const context = {
    generation: { current: 0 },
    setState: (state: UpdateState) => published.push(state),
    window: {
      canopy: {
        updateState: () => updates.snapshot(),
        checkUpdates: (background: boolean) => updates.check(background),
      },
      setInterval: (callback: () => void) => {
        interval = callback;
        return 1;
      },
      clearInterval: () => {
        cleared++;
      },
    },
  };
  const cleanup = ui.execute(effect, context)();
  await tick();
  assert.ok(published.length > 0);
  assert.deepEqual(published.at(-1)?.preferences, {
    notifications: false,
    prereleases: false,
  });
  assert.equal(requests, 0);
  const count = published.length;
  cleanup();
  assert.equal(cleared, 1);
  assert.ok(interval);
  interval();
  await tick();
  assert.equal(published.length, count);
  assert.equal(requests, 0);
});
