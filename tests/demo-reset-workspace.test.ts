import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
  'App.tsx',
  readFileSync('src/renderer/App.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function callback(name: string) {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      initializer = node.initializer;
    if (
      name === 'workspaceEffect' &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[1]?.getText(source) === '[workspace, ready, saveWorkspace]'
    )
      initializer = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert(initializer);
  if (ts.isCallExpression(initializer)) initializer = initializer.arguments[0];
  return ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

for (const failure of [false, true]) {
  test(`demo reset drains outgoing workspace saves${failure ? ' and recovers after failure' : ''}`, async () => {
    const events: string[] = [];
    let finishSave!: () => void;
    let expanded = true;
    const pendingWorkspaceSave = { current: Promise.resolve() };
    const demoResetting = { current: false };
    const workspaceSaveTimer = { current: 42 as number | null };
    const store = new Map<string, string>();
    const context = {
      navigating: false,
      paused: false,
      demoResetting,
      workspaceSaveTimer,
      pendingWorkspaceSave,
      restoreWork: null,
      workspaceRef: { current: { expanded: ['CAN-100', 'CAN-110'] } },
      setErrors: () => assert.fail('Unexpected workspace save failure'),
      stop: () => events.push('stop'),
      sessionStorage: {
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      window: {
        clearTimeout: (id: number) => {
          assert.equal(id, 42);
          events.push('cancel-timer');
        },
        canopy: {
          saveWorkspace: () => {
            events.push('save-start');
            if (events.includes('reset')) {
              events.push('save-end');
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              finishSave = () => {
                expanded = true;
                events.push('save-end');
                resolve();
              };
            });
          },
          resetDemo: async () => {
            events.push('reset');
            if (failure) throw new Error('Reset failed');
            expanded = false;
          },
        },
      },
    };
    const save = runInNewContext(callback('saveWorkspace'), context);
    Object.assign(context, { saveWorkspace: save });
    const seek = runInNewContext(callback('seek'), context);
    const inFlight = save({ expanded: ['CAN-100'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['save-start']);
    const queued = save({ expanded: ['CAN-100', 'CAN-110'] });
    const reset = seek(0, false);
    // A late debounce callback must also stay behind the reset barrier.
    const late = save({ expanded: ['CAN-100'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.includes('reset'), false);
    assert.equal(workspaceSaveTimer.current, null);
    finishSave();
    if (failure) await assert.rejects(reset, /Reset failed/);
    else await reset;
    await Promise.all([inFlight, queued, late]);
    assert.deepEqual(events, [
      'save-start',
      'cancel-timer',
      'stop',
      'save-end',
      'reset',
      ...(failure ? ['save-start', 'save-end'] : []),
    ]);
    assert.equal(expanded, failure);
    if (failure) {
      assert.equal(demoResetting.current, false);
      assert.equal(store.size, 0);
    } else {
      assert.equal(demoResetting.current, true);
      assert.equal(store.get('canopy-demo-step'), '0');
      assert.equal(store.get('canopy-demo-paused'), 'false');
    }
  });
}

for (const saveFails of [false, true]) {
  for (const changesDuringReset of [false, true]) {
    test(`failed demo reset saves the ${changesDuringReset ? 'updated' : 'unchanged'} debounced workspace${saveFails ? ' and preserves the reset error when saving fails' : ''}`, async () => {
      const timers = new Map<number, () => void>();
      const saved: unknown[] = [];
      const resetError = new Error('Reset failed');
      let rejectReset!: (error: Error) => void;
      let errors: Record<string, string> = { app: 'Existing error' };
      const initial = { expanded: ['CAN-100'] };
      const latest = { expanded: ['CAN-100', 'CAN-110'], palette: 'forest' };
      const context = {
        Error,
        navigating: false,
        paused: false,
        ready: true,
        workspace: initial,
        workspaceRef: { current: initial },
        pendingWorkspaceSave: { current: Promise.resolve() },
        demoResetting: { current: false },
        workspaceSaveTimer: { current: null as number | null },
        restoreWork: null,
        stop() {},
        sessionStorage: { setItem() {}, removeItem() {} },
        setErrors: (update: (value: typeof errors) => typeof errors) => {
          errors = update(errors);
        },
        window: {
          setTimeout: (callback: () => void) => {
            timers.set(42, callback);
            return 42;
          },
          clearTimeout: (id: number) => timers.delete(id),
          canopy: {
            saveWorkspace: async (value: unknown) => {
              saved.push(value);
              if (saveFails) throw new Error('Save failed');
            },
            resetDemo: () =>
              new Promise<void>((_resolve, reject) => {
                rejectReset = reject;
              }),
          },
        },
      };
      const save = runInNewContext(callback('saveWorkspace'), context);
      Object.assign(context, { saveWorkspace: save });
      const effect = runInNewContext(callback('workspaceEffect'), context);
      const seek = runInNewContext(callback('seek'), context);
      effect();
      assert.equal(timers.size, 1);
      const reset = seek(0, false);
      const rejected = assert.rejects(reset, (error) => error === resetError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(timers.size, 0);
      // A workspace change while reset is pending schedules a new debounce.
      if (changesDuringReset) {
        context.workspace = latest;
        context.workspaceRef.current = latest;
        effect();
        assert.equal(timers.size, 1);
      }
      rejectReset(resetError);
      await rejected;
      for (const timer of timers.values()) timer();
      await context.pendingWorkspaceSave.current.catch(() => {});
      assert.equal(timers.size, 0);
      assert.deepEqual(saved, [changesDuringReset ? latest : initial]);
      assert.equal(context.demoResetting.current, false);
      assert.equal(context.navigating, false);
      assert.equal(errors.app, 'Existing error');
      if (saveFails)
        assert.match(errors.workspace, /Couldn’t save workspace: Save failed/);
      else assert.equal(errors.workspace, undefined);
    });
  }
}
