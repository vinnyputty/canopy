import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WindowStateSaver } from '../src/main/window-state-saver';
import { restoreWindow, type WindowState } from '../src/main/window-state';

const state = (x: number, maximized = false): WindowState => ({
  bounds: { x, y: 30, width: 1100 + x, height: 700 },
  maximized,
});
const settle = async () => {
  // Allow the writer and its catch/finally chain to complete without wall time.
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('move and resize bursts debounce to the latest snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
    },
    (error) => assert.fail(String(error)),
  );
  for (let x = 0; x < 100; x++) {
    saver.update(state(x));
    t.mock.timers.tick(10);
  }
  await settle();
  assert.deepEqual(writes, []);
  t.mock.timers.tick(190);
  await settle();
  assert.deepEqual(writes, [state(99)]);
  await saver.flush();
  assert.equal(writes.length, 1);
});

test('a blocked write retains one latest successor instead of a bounds backlog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blocked = deferred();
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
      if (writes.length === 1) await blocked.promise;
    },
    (error) => assert.fail(String(error)),
  );
  saver.update(state(0));
  t.mock.timers.tick(200);
  await settle();
  for (let x = 1; x <= 100; x++) {
    saver.update(state(x));
    t.mock.timers.tick(200);
    await settle();
  }
  assert.deepEqual(writes, [state(0)]);
  let closed = false;
  const close = saver.flush().then(() => {
    closed = true;
  });
  // An event while close is waiting must also be included in the drain.
  saver.update(state(101));
  await settle();
  assert.equal(closed, false);
  blocked.resolve();
  await close;
  assert.deepEqual(writes, [state(0), state(101)]);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(writes.length, 2);
});

test('finishing a write preserves the remaining debounce time for newer events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blocked = deferred();
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
      if (writes.length === 1) await blocked.promise;
    },
    (error) => assert.fail(String(error)),
  );
  saver.update(state(0));
  t.mock.timers.tick(200);
  await settle();
  saver.update(state(1));
  t.mock.timers.tick(100);
  blocked.resolve();
  await settle();
  assert.deepEqual(writes, [state(0)]);
  saver.update(state(2));
  t.mock.timers.tick(199);
  await settle();
  assert.deepEqual(writes, [state(0)]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(writes, [state(0), state(2)]);
  await saver.flush();
});

test('immediate quit saves normal bounds and the final maximize state without waiting for debounce', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
    },
    (error) => assert.fail(String(error)),
  );
  saver.update(state(10));
  saver.update(state(20, true));
  await saver.flush();
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(restoreWindow(writes[0], [display]), state(20, true));
  saver.update(state(20, false));
  await saver.flush();
  assert.deepEqual(restoreWindow(writes[1], [display]), state(20));
});

test('invalid bounds retain the latest valid position and removed-monitor restoration stays reachable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
    },
    (error) => assert.fail(String(error)),
  );
  const valid = {
    bounds: { x: 2200, y: 50, width: 1200, height: 800 },
    maximized: true,
  };
  saver.update(valid);
  for (const bounds of [
    { ...valid.bounds, x: NaN },
    { ...valid.bounds, y: Infinity },
    { ...valid.bounds, width: 0 },
    { ...valid.bounds, height: -1 },
  ])
    saver.update({ bounds, maximized: false });
  valid.bounds.x = 9999; // Capture the event's snapshot, not a mutable reference.
  await saver.flush();
  assert.equal(writes[0].bounds.x, 2200);
  assert.deepEqual(
    restoreWindow(writes[0], [{ x: 0, y: 0, width: 1440, height: 900 }]),
    {
      bounds: { x: 240, y: 50, width: 1200, height: 800 },
      maximized: true,
    },
  );
});

test('a failed write reports once, drains the latest state, and allows close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blocked = deferred();
  const error = new Error('bounds disk failure');
  const errors: unknown[] = [];
  const writes: WindowState[] = [];
  const saver = new WindowStateSaver(
    async (value) => {
      writes.push(value);
      if (writes.length === 1) await blocked.promise;
    },
    (value) => {
      errors.push(value);
    },
  );
  saver.update(state(0));
  t.mock.timers.tick(200);
  await settle();
  saver.update(state(40));
  const close = saver.flush();
  blocked.reject(error);
  await close;
  assert.deepEqual(errors, [error]);
  assert.deepEqual(writes, [state(0), state(40)]);
});

test('a final failed or synchronously throwing bounds write still completes close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const synchronous of [false, true]) {
    const error = new Error('final bounds failure');
    const errors: unknown[] = [];
    const saver = new WindowStateSaver(
      () => {
        if (synchronous) throw error;
        return Promise.reject(error);
      },
      (value) => {
        errors.push(value);
      },
    );
    saver.update(state(10));
    await saver.flush();
    assert.deepEqual(errors, [error]);
  }
});
