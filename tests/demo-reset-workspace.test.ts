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
    ]);
    assert.equal(expanded, failure);
    if (failure) {
      assert.equal(demoResetting.current, false);
      assert.equal(store.size, 0);
      const recovered = save({ expanded: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(events.at(-1), 'save-start');
      finishSave();
      await recovered;
    } else {
      assert.equal(demoResetting.current, true);
      assert.equal(store.get('canopy-demo-step'), '0');
      assert.equal(store.get('canopy-demo-paused'), 'false');
    }
  });
}
