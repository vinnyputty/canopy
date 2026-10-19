// Run the actual bundled audit entry/callback under Node, with inert Electron
// and launch boundaries. No native clipboard method or Electron process exists.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const [sourcePath, profile, scenario] = process.argv.slice(2);
const mockApp = Object.assign(new EventEmitter(), { isPackaged: false });
let callback!: () => Promise<any>;
let originalCalls = 0;
const native = () => {
  originalCalls++;
};
const clipboard = { writeText: native, readText: native };
const shell = { openExternal: native };
Object.defineProperty(globalThis, 'fetch', {
  value: native,
  configurable: true,
  writable: true,
});
const original = Object.getOwnPropertyDescriptors(clipboard);
const beforeExit = new Set(process.listeners('exit'));
Object.assign(globalThis, {
  handoffRecreationBoundary: {
    app: mockApp,
    clipboard,
    shell,
    launch(fn: typeof callback) {
      callback = fn;
    },
  },
});
process.env.CANOPY_USER_DATA = profile;
const argv = process.argv;
process.argv = ['/electron', '/sample', '--canopy-demo'];
try {
  createRequire(sourcePath)(sourcePath);
} finally {
  process.argv = argv;
}
const ownedExit = process.listeners('exit').filter((fn) => !beforeExit.has(fn));
assert.equal(ownedExit.length, 1);
const state = () => (globalThis as any).handoffAuditCopy;
(async () => {
  if (scenario.startsWith('inspection-')) {
    const foreign = Object.freeze({ inspect: () => 'foreign' });
    const descriptor =
      scenario === 'inspection-accessor'
        ? { get: () => foreign, configurable: true }
        : {
            value: foreign,
            writable: true,
            configurable: scenario !== 'inspection-fixed',
          };
    Object.defineProperty(globalThis, 'handoffAuditCopy', descriptor);
    const before = Object.getOwnPropertyDescriptor(
      globalThis,
      'handoffAuditCopy',
    );
    await assert.rejects(callback(), /inspection ownership changed/);
    assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), original);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, 'handoffAuditCopy'),
      before,
    );
    assert.equal(originalCalls, 0);
    mockApp.emit('quit');
    console.log('PASS foreign inspection descriptor retained before UI');
    return;
  }
  const first = await callback();
  assert.equal(first.connection.provider, 'jira');
  await assert.rejects(
    (shell.openExternal as any)('https://example.invalid'),
    /External access denied/,
  );
  await assert.rejects(
    fetch('https://example.invalid'),
    /External access denied/,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(shell, 'openExternal')!.configurable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, 'fetch')!.configurable,
    false,
  );
  const sink = state();
  const installed = Object.getOwnPropertyDescriptors(clipboard);
  assert.deepEqual(Reflect.ownKeys(sink), ['inspect']);
  assert.equal(Object.isFrozen(sink), true);
  assert.equal(sink.restore, undefined);
  assert.throws(() => sink.restore(), TypeError);
  assert.equal(
    Reflect.set(sink, 'restore', () => {}),
    false,
  );
  assert.equal(
    Reflect.set(sink, 'inspect', () => {}),
    false,
  );
  assert.equal(Reflect.set(globalThis, 'handoffAuditCopy', {}), false);
  assert.equal(Reflect.deleteProperty(globalThis, 'handoffAuditCopy'), false);
  assert.throws(
    () => Object.defineProperty(globalThis, 'handoffAuditCopy', { value: {} }),
    TypeError,
  );
  assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), installed);
  const receipt = sink.inspect();
  receipt.count = 100;
  assert.deepEqual(sink.inspect(), { count: 0, text: undefined });
  assert.throws(() => clipboard.readText(), /denied/);
  const failures: Record<string, unknown> = {
    error: new Error('RESET_FIXTURE_FAILURE'),
    undefined: undefined,
    null: null,
    false: false,
    zero: 0,
    empty: '',
    foreign: new Error('RESET_FIXTURE_FAILURE'),
  };
  const primary = failures[scenario];
  const clone = globalThis.structuredClone;
  let rejected = false;
  globalThis.structuredClone = () => {
    throw primary;
  };
  try {
    await callback();
  } catch (error) {
    rejected = true;
    assert.equal(error, primary);
  } finally {
    globalThis.structuredClone = clone;
  }
  assert(
    rejected,
    'Actual DemoProvider constructor must reject the second callback',
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(clipboard),
    installed,
    'Live reset rejection must retain the installed sink',
  );
  assert.equal(mockApp.listenerCount('quit'), 1);
  assert(process.listeners('exit').includes(ownedExit[0]));
  assert.throws(() => clipboard.readText(), /denied/);
  // The live copy dispatcher still resolves writeText to the isolated sink.
  (clipboard.writeText as (...args: unknown[]) => void)(
    'Reviewed after failed reset',
  );
  assert.deepEqual(sink.inspect(), {
    count: 1,
    text: 'Reviewed after failed reset',
  });
  assert.equal(originalCalls, 0);
  const third = await callback();
  assert.equal(third.connection.url, 'https://example.invalid');
  assert.equal(
    state(),
    sink,
    'Subsequent successful reset must reuse active isolation',
  );
  assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), installed);
  assert.deepEqual(sink.inspect(), {
    count: 1,
    text: 'Reviewed after failed reset',
  });
  assert.throws(() => clipboard.readText(), /denied/);
  assert.equal(originalCalls, 0);
  if (scenario === 'foreign') {
    const foreign = () => {};
    clipboard.readText = foreign;
    assert.throws(() => mockApp.emit('quit'), /ownership changed/);
    assert.equal(clipboard.readText, foreign);
    assert.equal(clipboard.writeText, original.writeText.value);
    assert.equal(mockApp.listenerCount('quit'), 0);
    assert(!process.listeners('exit').includes(ownedExit[0]));
  } else if (scenario === 'error') {
    mockApp.emit('quit');
    assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), original);
    assert.equal(mockApp.listenerCount('quit'), 0);
    assert(!process.listeners('exit').includes(ownedExit[0]));
    // The retained callback is inert after its first terminal invocation.
    const foreign = () => {};
    clipboard.writeText = foreign;
    ownedExit[0](0);
    mockApp.emit('quit');
    assert.equal(clipboard.writeText, foreign);
    assert.throws(() => sink.inspect(), /isolation changed/);
  } else {
    // A real natural Node exit calls the retained fixture listener first. This
    // observer then checks exact restoration and listener cleanup without ever
    // invoking an original clipboard API.
    process.once('exit', () => {
      assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), original);
      assert.equal(mockApp.listenerCount('quit'), 0);
      assert(!process.listeners('exit').includes(ownedExit[0]));
      assert.equal(originalCalls, 0);
      console.log('PASS natural Node exit restoration');
    });
  }
  assert.equal(originalCalls, 0);
  console.log(
    JSON.stringify({
      scenario,
      actualFixtureCallback: true,
      resetFailureIsolated: true,
      activeSinkReused: true,
      nativeCalls: 0,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
