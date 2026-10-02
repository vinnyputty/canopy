import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function probe(
  t: TestContext,
  close: () => Promise<void>,
  options: {
    exited?: boolean;
    kill?: 'hang' | 'throw';
    removeFails?: boolean;
    success?: boolean;
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = new assert.AssertionError({
    message: 'original fixture assertion',
  });
  const profile = await mkdtemp(join(tmpdir(), 'canopy-window-cleanup-test-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), {
    exitCode: options.exited ? 0 : (null as number | null),
    signalCode: null as string | null,
    stderr: new EventEmitter(),
    kill(signal: string) {
      signals.push(signal);
      if (options.kill === 'throw') throw new Error('owned child kill failed');
      if (options.kill === 'hang') return false;
      this.signalCode = signal;
      child.emit('exit', null, signal);
      return true;
    },
  });
  const signals: string[] = [];
  const cleanupErrors: unknown[][] = [];
  let removals = 0;
  let closes = 0;
  const source = await readFile(
    new URL('../tools/window-check.mjs', import.meta.url),
    'utf8',
  );
  // Execute the actual harness, substituting bindings before evaluation. No
  // Playwright/Electron module is loaded and no real process receives signals.
  let harness = source.replace(/^import .*;$/gm, '');
  if (options.success)
    harness = harness.replace('try {\n  await launch();', 'try {\n  return;');
  assert.ok(
    !harness.includes('import '),
    'All harness imports must be substituted',
  );
  const result = (
    runInNewContext(`(async () => { ${harness} })()`, {
      assert,
      electron: {
        launch: async () => ({
          process: () => child,
          firstWindow: async () => ({
            waitForLoadState: async () => {
              throw original;
            },
          }),
          close: () => {
            closes++;
            return close();
          },
        }),
      },
      mkdtemp: async () => profile,
      rm: async (path: string, flags: Parameters<typeof rm>[1]) => {
        assert.equal(path, profile);
        removals++;
        if (options.removeFails) throw new Error('profile removal failed');
        await rm(path, flags);
      },
      tmpdir,
      join,
      process: {
        env: {
          CANOPY_APP_PATH: '/fixture-app',
          CANOPY_ELECTRON_PATH: '/unused-electron',
        },
      },
      console: {
        log() {},
        error: (...args: unknown[]) => cleanupErrors.push(args),
      },
      setTimeout,
      clearTimeout,
    }) as Promise<void>
  ).catch((error: unknown) => error);
  await settle();
  return {
    original,
    profile,
    child,
    signals,
    cleanupErrors,
    result,
    counts: () => ({ removals, closes }),
  };
}

test('close rejection removes the disposable profile and preserves the assertion identity', async (t) => {
  const cleanup = new Error('transport close rejected');
  const check = await probe(t, async () => {
    throw cleanup;
  });
  assert.equal(await check.result, check.original);
  assert.deepEqual(check.signals, ['SIGKILL']);
  assert.deepEqual(check.counts(), { removals: 1, closes: 1 });
  assert.equal(check.cleanupErrors.at(-1)?.[1], cleanup);
  await assert.rejects(stat(check.profile), { code: 'ENOENT' });
  assert.equal(check.child.listenerCount('exit'), 0);
});

test('a hung close is bounded before terminating only the owned child and removing its profile', async (t) => {
  const check = await probe(t, () => new Promise<void>(() => {}));
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual(check.signals, []);
  assert.equal(check.counts().removals, 0);
  t.mock.timers.tick(1);
  assert.equal(await check.result, check.original);
  assert.deepEqual(check.signals, ['SIGKILL']);
  await assert.rejects(stat(check.profile), { code: 'ENOENT' });
});

test('a child that never acknowledges termination cannot block profile removal or mask the assertion', async (t) => {
  const check = await probe(t, () => new Promise<void>(() => {}), {
    kill: 'hang',
  });
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(check.signals, ['SIGKILL']);
  assert.equal(check.counts().removals, 0);
  t.mock.timers.tick(5000);
  assert.equal(await check.result, check.original);
  await assert.rejects(stat(check.profile), { code: 'ENOENT' });
  assert.equal(check.child.listenerCount('exit'), 0);
});

test('an already exited child is never signalled after a transport failure', async (t) => {
  const check = await probe(
    t,
    async () => {
      throw new Error('disconnected');
    },
    { exited: true },
  );
  assert.equal(await check.result, check.original);
  assert.deepEqual(check.signals, []);
  await assert.rejects(stat(check.profile), { code: 'ENOENT' });
});

test('termination and removal errors retain the original failure and still attempt independent cleanup', async (t) => {
  const check = await probe(
    t,
    async () => {
      throw new Error('close rejected');
    },
    { kill: 'throw', removeFails: true },
  );
  assert.equal(await check.result, check.original);
  assert.deepEqual(check.counts(), { removals: 1, closes: 1 });
  assert.deepEqual(check.signals, ['SIGKILL']);
  assert.equal(check.cleanupErrors.length, 3); // completed checks and both cleanup errors
  assert.equal(check.child.listenerCount('exit'), 0);
});

test('successful completion removes the profile without failure cleanup or termination', async (t) => {
  const check = await probe(
    t,
    async () => {
      assert.fail('Successful fixture must not enter failure cleanup');
    },
    { success: true },
  );
  assert.equal(await check.result, undefined);
  assert.deepEqual(check.counts(), { removals: 1, closes: 0 });
  assert.deepEqual(check.signals, []);
  assert.deepEqual(check.cleanupErrors, []);
  await assert.rejects(stat(check.profile), { code: 'ENOENT' });
});
