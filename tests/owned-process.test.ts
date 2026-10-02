import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { disposeProcess, withCleanup } from './fixtures/owned-process.js';

const gone = (pid: number) =>
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('owned cleanup handles real already-exited and asynchronously failed launches without a late exit wait', async () => {
  const exited = spawn(process.execPath, ['-e', 'process.exit(9)'], {
    stdio: 'ignore',
  });
  await once(exited, 'close');
  await disposeProcess(exited, () => {
    throw new Error('exited handle must not be signaled');
  });
  gone(exited.pid!);
  await disposeProcess(undefined);
  const failed = spawn(`canopy-missing-owned-${process.pid}`, [], {
    stdio: 'ignore',
  });
  let spawnFailure: unknown;
  failed.on('error', (error) => {
    spawnFailure = error;
  });
  await assert.rejects(
    withCleanup(
      async () => {
        await once(failed, 'spawn');
      },
      () => disposeProcess(failed),
    ),
    (error) => error === spawnFailure,
  );
});

test('owned cleanup reaps a late real exit and preserves every falsy original assertion', async () => {
  for (const primary of [
    new Error('original assertion'),
    null,
    undefined,
    false,
    0,
    '',
  ]) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    let caught = false;
    try {
      await withCleanup(
        async () => {
          throw primary;
        },
        () => disposeProcess(child),
      );
    } catch (error) {
      caught = true;
      assert.equal(error, primary);
    }
    assert.equal(caught, true);
    gone(child.pid!);
  }
});

test('owned cleanup retains original failures and attempts independent cleanup after a secondary fault', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  for (const primary of [
    undefined,
    null,
    false,
    0,
    '',
    new Error('original'),
  ]) {
    let last = false;
    await assert.rejects(
      withCleanup(
        async () => {
          throw primary;
        },
        async () => {
          throw null;
        },
        async () => {
          await disposeProcess(child);
          last = true;
        },
      ),
      (error: AggregateError) => {
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, null]);
        return true;
      },
    );
    assert.equal(last, true);
    gone(child.pid!);
  }
});

test('withheld modeled close is finite and reports cleanup as secondary to the exact primary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    exitCode: null,
    signalCode: null,
  });
  const primary = new Error('original assertion');
  const cleanup = withCleanup(
    async () => {
      throw primary;
    },
    () => disposeProcess(child as ChildProcess, () => true),
  );
  // Let the operation rejection enter cleanup before advancing its owned timer.
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await assert.rejects(cleanup, (error: AggregateError) => {
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.match(error.errors[1].message, /close timed out/);
    return true;
  });
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});
