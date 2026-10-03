import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { callback, execute, findNode, sourceFile } from './source-probe';

const renderer = sourceFile(
  process.env.CANOPY_RESET_RENDERER_SOURCE ??
    new URL('../src/renderer/App.tsx', import.meta.url),
);
const main = sourceFile(new URL('../src/main/app.ts', import.meta.url));
const handler = (name: string) =>
  findNode(
    main,
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText() === name,
  ).initializer.getText();
const saveEffect = findNode(
  renderer,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.getText().includes('Couldn’t save workspace:'),
).arguments[0].getText();

function harness() {
  const initial = { tabs: [{ expanded: [], selectedKey: undefined }] };
  const explored = {
    tabs: [{ expanded: ['CAN-100', 'CAN-110'], selectedKey: 'CAN-111' }],
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let resets = 0;
  let rejectReset = false;
  let inflight: (() => void) | undefined;
  let restored: (() => void) | undefined;
  const workspaceSaveTimer = { current: null as number | null };
  const pendingWorkspaceSave = { current: Promise.resolve() };
  const demoResetting = { current: false };
  const backend = execute(
    `function() {
    let fixture; const demoMode = true;
    const demoWorkspace = initial;
    let demoWorkspaceState = structuredClone(explored);
    return {load: ${handler('loadWorkspace')}, save: ${handler('saveWorkspace')}, reset: ${handler('resetDemo')}};
  }`,
    {
      initial,
      explored,
      structuredClone,
      workspace: (value: unknown) => value,
      createFixture: async () => {
        resets++;
        if (rejectReset) throw new Error('fixture reset rejected');
        return {};
      },
      storage: {},
      window: { webContents: { reload: () => {} } },
    },
  )();
  const window = {
    clearTimeout: (id: number) => timers.delete(id),
    setTimeout: (fn: () => void) => {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    canopy: {
      saveWorkspace: async (value: unknown) => {
        await new Promise<void>((resolve) => {
          inflight = resolve;
        });
        backend.save(value);
      },
      resetDemo: backend.reset,
    },
  };
  const context = {
    window,
    pendingWorkspaceSave,
    workspaceSaveTimer,
    demoResetting,
    useCallback: (fn: unknown) => fn,
    sessionStorage: { setItem: () => {}, removeItem: () => {} },
  };
  const functions = execute(
    `function() {
    let navigating = false; const paused = false;
    const restoreWork = new Promise(resolve => { setRestored(resolve); });
    const stop = () => {};
    const saveWorkspace = ${callback(renderer, 'saveWorkspace')};
    const seek = ${callback(renderer, 'seek')};
    return {saveWorkspace, seek};
  }`,
    {
      ...context,
      setRestored: (resolve: () => void) => {
        restored = resolve;
      },
    },
  )();
  const schedule = () =>
    execute(saveEffect, {
      ...context,
      ready: true,
      workspace: explored,
      saveWorkspace: functions.saveWorkspace,
      setErrors: () => {},
    })();
  return {
    initial,
    explored,
    backend,
    functions,
    schedule,
    timers,
    demoResetting,
    resets: () => resets,
    rejectReset: () => {
      rejectReset = true;
    },
    finishSave: () => {
      assert.ok(inflight);
      inflight();
    },
    finishIfSaving: () => inflight?.(),
    finishRestore: () => {
      assert.ok(restored);
      restored();
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('demo reset cancels the pending production autosave and refuses late old-document writes', async () => {
  const h = harness();
  h.schedule();
  const late = [...h.timers.values()][0];
  const reset = h.functions.seek(0, false);
  h.finishRestore();
  await reset;
  late(); // A callback already dispatched before clearTimeout must also be harmless.
  await tick();
  h.finishIfSaving();
  await tick();
  assert.deepEqual(
    await h.backend.load(),
    h.initial,
    'old document overwrote the reset root',
  );
  assert.equal(h.timers.size, 0, 'old autosave timer survives reset');
  await h.functions.saveWorkspace(h.explored);
  assert.deepEqual(await h.backend.load(), h.initial);
});

test('demo reset waits for an already dispatched IPC save before installing its fresh workspace', async () => {
  const h = harness();
  const saving = h.functions.saveWorkspace(h.explored);
  await tick();
  const reset = h.functions.seek(0, false);
  h.finishRestore();
  await tick();
  assert.equal(h.resets(), 0, 'reset raced the in-flight old workspace save');
  h.finishSave();
  await saving;
  await reset;
  assert.deepEqual(await h.backend.load(), h.initial);
});

test('failed fixture reset releases the save barrier and permits ordinary subsequent saves', async () => {
  const h = harness();
  h.rejectReset();
  const reset = h.functions.seek(0, false);
  h.finishRestore();
  await assert.rejects(reset, /fixture reset rejected/);
  assert.equal(h.demoResetting.current, false);
  const saving = h.functions.saveWorkspace(h.explored);
  await tick();
  h.finishSave();
  await saving;
  assert.deepEqual(await h.backend.load(), h.explored);
});

test('demo reset suppresses queued saves and autosaves scheduled while priority restoration is pending', async () => {
  const h = harness();
  const queued = h.functions.saveWorkspace(h.explored);
  const reset = h.functions.seek(0, false);
  await queued;
  h.schedule();
  const late = [...h.timers.values()][0];
  late();
  await tick();
  h.finishRestore();
  await reset;
  assert.deepEqual(await h.backend.load(), h.initial);
});

test('ordinary workspace saves still reach the production main handler', async () => {
  const h = harness();
  const saving = h.functions.saveWorkspace(h.initial);
  await tick();
  h.finishSave();
  await saving;
  assert.deepEqual(await h.backend.load(), h.initial);
  assert.equal(h.resets(), 0);
  assert.equal(h.demoResetting.current, false);
});
