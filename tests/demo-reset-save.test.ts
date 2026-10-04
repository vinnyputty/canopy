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

function harness({ demo = true, saveGate = false } = {}) {
  const initial = { tabs: [{ expanded: [], selectedKey: undefined }] };
  const explored = {
    tabs: [{ expanded: ['CAN-100', 'CAN-110'], selectedKey: 'CAN-111' }],
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let resets = 0;
  let rejectReset = false;
  let resetFault: unknown = new Error('fixture reset rejected');
  let rejectReload = false;
  let reloadFault: unknown;
  let rejectSave = false;
  let saveFault: unknown;
  let errors: Record<string, string> = {};
  const writes: unknown[] = [];
  const workspaceRef = { current: explored };
  let inflight: (() => void) | undefined;
  let restored: (() => void) | undefined;
  const workspaceSaveTimer = { current: null as number | null };
  const pendingWorkspaceSave = { current: Promise.resolve() };
  const demoResetting = { current: false };
  let stored: unknown = structuredClone(initial);
  const backend = execute(
    `function() {
    let fixture; const demoMode = demo;
    const demoWorkspace = initial;
    let demoWorkspaceState = structuredClone(initial);
    return {load: ${handler('loadWorkspace')}, save: ${handler('saveWorkspace')}, reset: ${handler('resetDemo')}};
  }`,
    {
      initial,
      explored,
      demo,
      structuredClone,
      validateWorkspace: (value: unknown) => value,
      recoverWorkspaceViews: (value: unknown) => value,
      createFixture: async () => {
        resets++;
        if (rejectReset) throw resetFault;
        return {};
      },
      storage: {
        read: async () => stored,
        write: (_name: string, value: unknown) => {
          stored = structuredClone(value);
        },
      },
      window: {
        webContents: {
          reload: () => {
            if (rejectReload) throw reloadFault;
          },
        },
      },
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
        writes.push(structuredClone(value));
        if (saveGate)
          await new Promise<void>((resolve) => {
            inflight = resolve;
          });
        if (rejectSave) throw saveFault;
        await backend.save(value);
      },
      resetDemo: backend.reset,
    },
  };
  const context = {
    window,
    pendingWorkspaceSave,
    workspaceSaveTimer,
    demoResetting,
    workspaceTransferBusy: { current: false },
    workspaceRef,
    setErrors: (
      update: (value: Record<string, string>) => Record<string, string>,
    ) => {
      errors = update(errors);
    },
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
  let cleanup: (() => void) | undefined;
  const schedule = (value = workspaceRef.current) => {
    workspaceRef.current = value;
    cleanup?.();
    cleanup = execute(saveEffect, {
      ...context,
      ready: true,
      workspace: value,
      saveWorkspace: functions.saveWorkspace,
    })();
  };
  return {
    initial,
    explored,
    backend,
    functions,
    schedule,
    timers,
    writes,
    workspaceRef,
    demoResetting,
    errors: () => errors,
    dispatchTimers: () => {
      for (const [id, run] of timers) {
        timers.delete(id);
        run();
      }
    },
    resets: () => resets,
    rejectReset: (fault: unknown) => {
      rejectReset = true;
      resetFault = fault;
    },
    rejectReload: (fault: unknown) => {
      rejectReload = true;
      reloadFault = fault;
    },
    rejectSave: (fault: unknown) => {
      rejectSave = true;
      saveFault = fault;
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
  const h = harness({ saveGate: true });
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

for (const stage of ['fixture', 'reload']) {
  for (const primary of [undefined, null, false, new Error('reset fault')]) {
    test(`failed ${stage} reset automatically persists the canceled autosave: ${String(primary)}`, async () => {
      const h = harness();
      if (stage === 'fixture') h.rejectReset(primary);
      else h.rejectReload(primary);
      h.schedule();
      const reset = h.functions.seek(0, false);
      h.finishRestore();
      let rejected = false;
      try {
        await reset;
      } catch (error) {
        rejected = true;
        assert.equal(error, primary);
      }
      assert.equal(rejected, true);
      assert.equal(h.demoResetting.current, false);
      await tick();
      h.dispatchTimers();
      await tick();
      assert.deepEqual(
        await h.backend.load(),
        h.explored,
        'recovery must not need another user action or saveWorkspace call',
      );
      assert.deepEqual(h.writes, [h.explored]);
    });
  }
}

test('failed reset recovers the latest visible edits after queued and restoration-time saves were consumed', async () => {
  const h = harness();
  const primary = new Error('fixture reset rejected');
  h.rejectReset(primary);
  const queued = h.functions.saveWorkspace(h.explored);
  const reset = h.functions.seek(0, false);
  await queued;
  const latest = {
    tabs: [
      ...h.explored.tabs,
      { expanded: ['CAN-200'], selectedKey: 'CAN-201' },
    ],
  };
  h.schedule(latest);
  h.dispatchTimers();
  await tick();
  assert.equal(h.writes.length, 0, 'restoration-time writes remain suppressed');
  const visible = { ...latest, theme: 'dark' };
  h.schedule(visible); // This newest render still has an outstanding debounce.
  h.finishRestore();
  await assert.rejects(reset, (error) => error === primary);
  await tick();
  assert.deepEqual(await h.backend.load(), visible);
  assert.deepEqual(h.writes, [visible]);
  assert.equal(h.timers.size, 0);
});

for (const secondary of [
  undefined,
  null,
  false,
  new Error('recovery save failed'),
]) {
  test(`automatic recovery save failure preserves the reset primary: ${String(secondary)}`, async () => {
    const h = harness();
    const primary = new Error('original reset rejected');
    h.rejectReload(primary);
    h.rejectSave(secondary);
    h.schedule();
    const reset = h.functions.seek(0, false);
    h.finishRestore();
    await assert.rejects(reset, (error) => error === primary);
    await tick();
    assert.deepEqual(
      h.writes,
      [h.explored],
      'the failure path must actually attempt persistence',
    );
    assert.match(h.errors().workspace, /Couldn’t save workspace:/);
    assert.equal(h.demoResetting.current, false);
  });
}

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
  const h = harness({ saveGate: true });
  const saving = h.functions.saveWorkspace(h.explored);
  await tick();
  h.finishSave();
  await saving;
  assert.deepEqual(await h.backend.load(), h.explored);
  assert.equal(h.resets(), 0);
  assert.equal(h.demoResetting.current, false);
});

test('ordinary non-demo persistence stays active and demo reset remains unavailable', async () => {
  const h = harness({ demo: false });
  h.schedule();
  h.dispatchTimers();
  await tick();
  assert.deepEqual(await h.backend.load(), h.explored);
  assert.deepEqual(h.writes, [h.explored]);
  assert.equal(h.demoResetting.current, false);
  await assert.rejects(
    h.backend.reset(),
    /Reset is available in the demo workspace/,
  );
});

for (const primary of [undefined, null, false]) {
  test(`falsy reset failure stays primary when automatic recovery also rejects: ${String(primary)}`, async () => {
    const h = harness();
    h.rejectReset(primary);
    h.rejectSave(false);
    h.schedule();
    const reset = h.functions.seek(0, false);
    h.finishRestore();
    let rejected = false;
    try {
      await reset;
    } catch (error) {
      rejected = true;
      assert.equal(error, primary);
    }
    assert.equal(rejected, true);
    assert.deepEqual(h.writes, [h.explored]);
    assert.match(h.errors().workspace, /false$/);
  });
}
