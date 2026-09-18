import assert from 'node:assert/strict';
import { it } from 'node:test';
import { RefreshSchedule } from '../src/renderer/refresh';

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
