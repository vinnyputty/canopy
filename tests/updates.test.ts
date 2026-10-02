import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Updates } from '../src/main/updates';
import {
  ReleaseRequestError,
  type ReleaseTransport,
} from '../src/main/releases';
import { release } from './fixtures/releases';
const WEEK = 7 * 24 * 60 * 60 * 1000;
function fixture(
  rows: unknown[] = [release()],
  packaged = true,
  version = '0.1.0',
) {
  let time = 2 * WEEK;
  let value: unknown = null;
  let failWrite = false;
  let failRead = false;
  const calls: number[] = [];
  let transport: ReleaseTransport = async (page) => {
    calls.push(page);
    return { rows, more: false };
  };
  const store = {
    async read<T>() {
      if (failRead) throw new Error('corrupt');
      return structuredClone(value) as T | null;
    },
    async write(name: string, input: unknown) {
      assert.equal(name, 'updates');
      if (failWrite) throw new Error('disk');
      value = structuredClone(input);
    },
  };
  const create = () =>
    new Updates(
      store,
      version,
      'darwin',
      'arm64',
      packaged,
      (page, signal) => transport(page, signal),
      () => time,
    );
  return {
    create,
    calls,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
    transport: (fn: ReleaseTransport) => {
      transport = fn;
    },
    failWrite: () => {
      failWrite = true;
    },
    failRead: () => {
      failRead = true;
    },
    saved: () => value,
  };
}
it('defaults to no notices/no background network; manual discovery works and browser handoff is canonical', async () => {
  const f = fixture(),
    updates = f.create();
  assert.deepEqual((await updates.snapshot()).preferences, {
    notifications: false,
    prereleases: false,
  });
  await updates.check(true);
  assert.equal(f.calls.length, 0);
  const state = await updates.check();
  assert.match(state.message, /newer compatible/);
  assert.equal(state.notice, false);
  assert.equal(state.release?.version, '0.2.0');
  let url = '';
  await updates.open('v0.2.0', async (value) => {
    url = value;
  });
  assert.equal(url, 'https://github.com/vinnyputty/canopy/releases/tag/v0.2.0');
  await assert.rejects(updates.open('https://evil.test', async () => {}));
  await updates.check();
  assert.equal(f.calls.length, 1);
});
it('persists opt-in/channel and weekly attempts/notices/dismissal across restart', async () => {
  const f = fixture(),
    updates = f.create();
  await updates.preferences({ notifications: true, prereleases: false });
  assert.equal((await updates.check(true)).notice, true);
  const restarted = f.create();
  await restarted.check(true);
  assert.equal(f.calls.length, 1);
  await updates.dismiss();
  f.advance(WEEK);
  assert.equal((await f.create().check(true)).notice, false);
  f.transport(async (page) => {
    f.calls.push(page);
    return { rows: [release('0.3.0')], more: false };
  });
  f.advance(WEEK);
  assert.equal((await f.create().check(true)).notice, true);
  assert.equal((f.saved() as any).preferences.notifications, true);
});
it('errors/no release/no compatible/current version never trigger notices', async () => {
  for (const rows of [
    [],
    [release('0.2.0', 'mac-x64.dmg')],
    [release('0.1.0')],
    [release('0.0.9')],
  ]) {
    const f = fixture(rows),
      updates = f.create();
    await updates.preferences({ notifications: true, prereleases: false });
    assert.equal((await updates.check(true)).notice, false);
  }
  const f = fixture(),
    updates = f.create();
  await updates.preferences({ notifications: true, prereleases: false });
  f.transport(async () => {
    throw new Error('offline secret-token');
  });
  const state = await updates.check(true);
  assert.equal(state.notice, false);
  assert.match(state.message, /offline/);
  assert.ok(!state.message.includes('secret-token'));
  f.advance(60 * 60 * 1000);
  await f.create().check(true);
  assert.equal(f.calls.length, 0);
});
it('development/unparseable/unpublished versions and scan limits are described honestly', async () => {
  for (const version of ['dev', '0.1.0']) {
    const f = fixture([release()], false, version),
      updates = f.create();
    await updates.preferences({ notifications: true, prereleases: false });
    await updates.check(true);
    assert.equal(f.calls.length, 0);
    const state = await updates.check();
    assert.match(state.message, /Development build/);
    if (version === 'dev') assert.match(state.message, /cannot be compared/);
    assert.equal(state.notice, false);
  }
  const f = fixture(),
    updates = f.create();
  assert.match((await updates.check()).message, /not found among.*published/);
  const bounded = fixture(),
    service = bounded.create();
  bounded.transport(async (page) => {
    bounded.calls.push(page);
    return { rows: [release('0.1.0')], more: true };
  });
  const state = await service.check();
  assert.deepEqual(bounded.calls, [1, 2, 3]);
  assert.match(state.message, /first 90/);
  assert.equal(state.notice, false);
});
it('channel changes clear old results and reuse bounded cache without treating prereleases as stable', async () => {
  const f = fixture([release('0.3.0-rc.1'), release('0.2.0')]),
    updates = f.create();
  assert.equal((await updates.check()).release?.version, '0.2.0');
  await updates.preferences({ notifications: false, prereleases: true });
  assert.equal((await updates.snapshot()).release, undefined);
  assert.equal((await updates.check()).release?.version, '0.3.0-rc.1');
  await updates.preferences({ notifications: false, prereleases: false });
  assert.equal((await updates.check()).release?.version, '0.2.0');
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    updates.preferences({ notifications: 'false', prereleases: false }),
  );
});
it('retains a labeled last success on failures, enforces rate backoff and drops week-old results', async () => {
  const f = fixture(),
    updates = f.create();
  await updates.check();
  f.advance(60 * 60 * 1000);
  let calls = 0;
  f.transport(async () => {
    calls++;
    throw new ReleaseRequestError(
      'GitHub is limiting release checks.',
      f.now() + 120000,
    );
  });
  const failed = await updates.check();
  assert.equal(failed.release?.version, '0.2.0');
  assert.equal(failed.stale, true);
  assert.equal(failed.notice, false);
  await updates.check();
  assert.equal(calls, 1);
  f.advance(120001);
  await updates.check();
  assert.equal(calls, 2);
  f.advance(WEEK);
  const expired = await updates.check();
  assert.equal(expired.release, undefined);
  assert.equal(expired.checkedAt, undefined);
});
it('preference changes/cancel invalidate in-flight results and deduplicate simultaneous checks', async () => {
  const f = fixture(),
    updates = f.create();
  let resolve!: (value: { rows: unknown[]; more: boolean }) => void;
  let signal!: AbortSignal;
  let calls = 0;
  f.transport((_page, input) => {
    calls++;
    signal = input;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = updates.check();
  await new Promise((done) => setImmediate(done));
  const duplicate = updates.check();
  await new Promise((done) => setImmediate(done));
  await updates.preferences({ notifications: false, prereleases: true });
  assert.equal(signal.aborted, true);
  resolve({ rows: [release()], more: false });
  await pending;
  await duplicate;
  assert.equal(calls, 1);
  assert.equal((await updates.snapshot()).release, undefined);
  const cancelled = updates.check();
  await new Promise((done) => setImmediate(done));
  updates.cancel();
  resolve({ rows: [release()], more: false });
  await cancelled;
  assert.equal((await updates.snapshot()).release, undefined);
});
it('corrupt settings fail closed; save failure preserves preferences and stops background requests', async () => {
  const f = fixture();
  f.failRead();
  const updates = f.create();
  assert.match((await updates.snapshot()).message, /could not be read/);
  await updates.check(true);
  assert.equal(f.calls.length, 0);
  assert.equal((await updates.check()).release?.version, '0.2.0');
  f.failWrite();
  await assert.rejects(
    updates.preferences({ notifications: true, prereleases: false }),
  );
  assert.equal((await updates.snapshot()).preferences.notifications, false);
  const g = fixture(),
    service = g.create();
  await service.preferences({ notifications: true, prereleases: false });
  g.failWrite();
  const result = await service.check(true);
  assert.equal(g.calls.length, 0);
  assert.equal(result.notice, false);
});

it('serializes preference writes before checks and keeps the final channel after overlapping changes', async () => {
  const f = fixture([release('0.3.0-rc.1'), release('0.2.0')]);
  const updates = f.create();
  const first = updates.preferences({ notifications: true, prereleases: true });
  const second = updates.preferences({
    notifications: false,
    prereleases: false,
  });
  const check = updates.check();
  await Promise.all([first, second]);
  assert.equal((await check).release?.version, '0.2.0');
  assert.deepEqual((await updates.snapshot()).preferences, {
    notifications: false,
    prereleases: false,
  });
  assert.deepEqual((f.saved() as any).preferences, {
    notifications: false,
    prereleases: false,
  });
});
it('total deadline aborts a held production-style request without a notice', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let aborted = false;
  f.transport(
    (_page, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('timeout'));
          },
          { once: true },
        );
      }),
  );
  const updates = f.create();
  const pending = updates.check();
  await new Promise((done) => setImmediate(done));
  context.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.notice, false);
  assert.match(result.message, /timed out/);
});
