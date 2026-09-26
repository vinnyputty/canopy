import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  ACTIVE_REFRESH_MS,
  RefreshSchedule,
  RootRefreshGate,
} from '../src/renderer/refresh';

it('keeps the active cadence while background intervals double up to an hour', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['active', 'background'], 'active', 0);
  for (const id of ['active', 'background']) {
    assert.equal(schedule.begin(id, 0), true);
    schedule.finish(id, 0);
  }
  assert.deepEqual(schedule.due(29_999), []);
  assert.deepEqual(schedule.due(30_000), ['active']);
  let time = 0;
  for (const interval of [
    60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
  ]) {
    assert.equal(
      schedule.due(time + interval - 1).includes('background'),
      false,
    );
    time += interval;
    assert.equal(schedule.due(time).includes('background'), true);
    assert.equal(schedule.begin('background', time), true);
    schedule.finish('background', time);
  }
});

it('activation and window return reset cadence and share an in-flight request', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['a', 'b'], 'a', 0);
  assert.deepEqual(schedule.sync(['a', 'b'], 'b', 5000), ['b']);
  assert.equal(schedule.begin('b', 5000), true);
  assert.deepEqual(schedule.sync(['a', 'b'], null, 6000), []);
  assert.deepEqual(schedule.sync(['a', 'b'], 'b', 6100), ['b']);
  assert.equal(schedule.begin('b', 6100), false);
  schedule.finish('b', 7000);
  assert.equal(schedule.due(36_999).includes('b'), false);
  assert.equal(schedule.due(37_000).includes('b'), true);
});

it('coalesces near-simultaneous focus, activation, and timer requests but allows explicit retry', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['a'], 'a', 0);
  assert.equal(schedule.begin('a', 0), true);
  assert.equal(schedule.begin('a', 0, true), false);
  schedule.finish('a', 10);
  assert.equal(schedule.begin('a', 500), false);
  assert.equal(schedule.begin('a', 500, true), true);
  schedule.finish('a', 600);
  schedule.sync([], null, 700);
  assert.equal(schedule.begin('a', 1000, true), false);
  assert.deepEqual(schedule.due(100_000), []);
});

it('starts exponential backoff when a loaded active tab becomes backgrounded', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['a'], 'a', 0);
  schedule.begin('a', 0);
  schedule.finish('a', 0);
  schedule.sync(['a'], null, 10_000);
  let time = 10_000;
  for (const interval of [
    60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
  ]) {
    assert.deepEqual(schedule.due(time + interval - 1), []);
    time += interval;
    assert.deepEqual(schedule.due(time), ['a']);
    schedule.begin('a', time);
    schedule.finish('a', time);
  }
  assert.deepEqual(schedule.sync(['a'], 'a', time + 1), ['a']);
  schedule.begin('a', time + 1000);
  schedule.finish('a', time + 1000);
  assert.deepEqual(schedule.due(time + 30_999), []);
  assert.deepEqual(schedule.due(time + 31_000), ['a']);
});

it('uses a one-minute first wait when an active request finishes in the background', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['a'], 'a', 0);
  schedule.begin('a', 0);
  schedule.sync(['a'], null, 1000);
  assert.deepEqual(schedule.due(500_000), []);
  schedule.finish('a', 500_000);
  assert.deepEqual(schedule.due(559_999), []);
  assert.deepEqual(schedule.due(560_000), ['a']);
  schedule.begin('a', 560_000);
  schedule.finish('a', 560_000);
  assert.deepEqual(schedule.due(679_999), []);
  assert.deepEqual(schedule.due(680_000), ['a']);
});

it('forgets a closed in-flight tab and gives its reopened identity a fresh schedule', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['closed', 'remaining'], 'closed', 0);
  assert.equal(schedule.begin('closed', 0), true);
  schedule.forget('closed');
  assert.equal(schedule.begin('closed', 1000, true), false);
  assert.deepEqual(schedule.due(1000), ['remaining']);
  schedule.sync(['closed', 'remaining'], 'closed', 2000);
  assert.equal(schedule.begin('closed', 2000), true);
  schedule.finish('closed', 2000);
  assert.equal(schedule.due(31_999).includes('closed'), false);
  assert.equal(schedule.due(32_000).includes('closed'), true);
});

it('shares duplicate tab reads and preserves the most recent tree during the minimum interval', async () => {
  let now = 0;
  let resolve!: (value: string) => void;
  let requests = 0;
  const gate = new RootRefreshGate<string>(() => now);
  const fetch = () => {
    requests++;
    return new Promise<string>((done) => {
      resolve = done;
    });
  };
  const first = gate.load('connection/root', false, true, fetch);
  const duplicate = gate.load('connection/root', false, true, fetch);
  assert.ok('promise' in first && 'promise' in duplicate);
  assert.equal(first.promise, duplicate.promise);
  assert.equal(requests, 1);
  resolve('first tree');
  assert.equal(await duplicate.promise, 'first tree');
  await Promise.resolve();
  now = ACTIVE_REFRESH_MS - 1;
  const skipped = gate.load('connection/root', false, false, fetch);
  assert.deepEqual(skipped, { due: ACTIVE_REFRESH_MS });
  const freshTab = gate.load('connection/root', false, true, fetch);
  assert.ok('promise' in freshTab);
  assert.equal(await freshTab.promise, 'first tree');
  assert.equal(requests, 1);
  now = ACTIVE_REFRESH_MS;
  const next = gate.load('connection/root', false, false, fetch);
  assert.ok('promise' in next);
  assert.equal(requests, 2);
  resolve('second tree');
  assert.equal(await next.promise, 'second tree');
});

it('allows explicit refresh and failed-load recovery before the interval', async () => {
  let now = 0;
  let requests = 0;
  const gate = new RootRefreshGate<string>(() => now);
  const fetch = () => Promise.resolve(`tree ${++requests}`);
  const first = gate.load('connection/root', false, true, fetch);
  assert.ok('promise' in first);
  assert.equal(await first.promise, 'tree 1');
  await Promise.resolve();
  now = 100;
  const explicit = gate.load('connection/root', true, false, fetch);
  assert.ok('promise' in explicit);
  assert.equal(await explicit.promise, 'tree 2');

  const failed = gate.load('other/root', false, true, () => {
    requests++;
    return Promise.reject(new Error('offline'));
  });
  assert.ok('promise' in failed);
  await assert.rejects(failed.promise, /offline/);
  await Promise.resolve();
  const retry = gate.load('other/root', false, true, fetch);
  assert.ok('promise' in retry);
  assert.equal(await retry.promise, 'tree 4');
});

it('defers a skipped tab until the root interval expires', () => {
  const schedule = new RefreshSchedule();
  schedule.sync(['a'], 'a', 0);
  assert.equal(schedule.begin('a', 0), true);
  schedule.finish('a', 0);
  assert.equal(schedule.begin('a', ACTIVE_REFRESH_MS), true);
  schedule.defer('a', ACTIVE_REFRESH_MS + 500);
  assert.deepEqual(schedule.due(ACTIVE_REFRESH_MS + 499), []);
  assert.deepEqual(schedule.due(ACTIVE_REFRESH_MS + 500), ['a']);
});

it('starts a new read after the last tab for a root closes during an old read', async () => {
  let completeOld!: (value: string) => void;
  const gate = new RootRefreshGate<string>(() => 0);
  const old = gate.load(
    'connection/root',
    true,
    true,
    () => new Promise((resolve) => (completeOld = resolve)),
  );
  assert.ok('promise' in old);
  gate.forget('connection/root');
  const reopened = gate.load('connection/root', false, true, async () => 'new');
  assert.ok('promise' in reopened);
  assert.notEqual(old.promise, reopened.promise);
  assert.equal(await reopened.promise, 'new');
  completeOld('old');
  assert.equal(await old.promise, 'old');
});

it('queues one explicit read behind an automatic read and discards the older generation', async () => {
  let completeOld!: (value: string) => void;
  let completeNew!: (value: string) => void;
  let requests = 0;
  const gate = new RootRefreshGate<string>(() => 0);
  const automatic = gate.load('connection/root', false, true, () => {
    requests++;
    return new Promise((resolve) => (completeOld = resolve));
  });
  assert.ok('promise' in automatic);
  const fresh = () => {
    requests++;
    return new Promise<string>((resolve) => (completeNew = resolve));
  };
  const explicit = gate.load('connection/root', true, false, fresh);
  const secondExplicit = gate.load('connection/root', true, false, fresh);
  assert.ok('promise' in explicit && 'promise' in secondExplicit);
  assert.equal(explicit.promise, secondExplicit.promise);
  assert.equal(requests, 1);
  assert.equal(gate.isCurrent('connection/root', automatic.generation), false);
  completeOld('old tree');
  assert.equal(await automatic.promise, 'old tree');
  await Promise.resolve();
  assert.equal(requests, 2);
  completeNew('fresh tree');
  assert.equal(await explicit.promise, 'fresh tree');
  assert.equal(gate.isCurrent('connection/root', explicit.generation), true);
  const latest = gate.load('connection/root', false, true, fresh);
  assert.ok('promise' in latest);
  assert.equal(await latest.promise, 'fresh tree');
  assert.equal(requests, 2);
});
