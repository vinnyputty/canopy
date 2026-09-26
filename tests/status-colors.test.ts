import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StatusColors } from '../src/renderer/status-colors';
import type { Status } from '../src/shared/types';

const status = (
  id: string,
  category: Status['category'] = 'indeterminate',
): Status => ({
  id,
  name: id,
  category,
});

test('familiar status names use the same semantic colors across registries', () => {
  const jira = new StatusColors().include([
    { ...status('jira-open', 'new'), name: ' To  Do ' },
    { ...status('jira-progress'), name: 'In Progress' },
    { ...status('jira-review'), name: 'In Review' },
    { ...status('jira-blocked'), name: 'Blocked' },
    { ...status('jira-done', 'done'), name: 'Resolved' },
  ]);
  const other = new StatusColors().include([
    { ...status('github-open', 'new'), name: 'Open' },
    { ...status('other-progress'), name: 'in progress' },
    { ...status('other-review'), name: 'Review' },
    { ...status('other-blocked'), name: 'Blocked' },
    { ...status('github-closed', 'done'), name: 'Closed' },
  ]);
  assert.equal(jira.get('jira-open'), other.get('github-open'));
  assert.equal(jira.get('jira-progress'), other.get('other-progress'));
  assert.equal(jira.get('jira-review'), other.get('other-review'));
  assert.equal(jira.get('jira-blocked'), other.get('other-blocked'));
  assert.equal(jira.get('jira-done'), other.get('github-closed'));
  assert.equal(new Set(jira.values()).size, 5);
});

test('a familiar label with a mismatched category uses a custom color', () => {
  const colors = new StatusColors().include([
    { ...status('done-new', 'new'), name: 'Done' },
    { ...status('done-done', 'done'), name: 'Done' },
    { ...status('review-new', 'new'), name: 'Review' },
    { ...status('review-progress'), name: 'Review' },
  ]);
  assert.match(colors.get('done-new')!, /^hsl\(/);
  assert.notEqual(colors.get('done-new'), colors.get('done-done'));
  assert.match(colors.get('review-new')!, /^hsl\(/);
  assert.notEqual(colors.get('review-new'), colors.get('review-progress'));
});

test('inherited object property names use custom colors', () => {
  const colors = new StatusColors().include([
    { ...status('constructor'), name: 'Constructor' },
    { ...status('to-string', 'done'), name: 'toString' },
  ]);
  assert.match(colors.get('constructor')!, /^hsl\(/);
  assert.match(colors.get('to-string')!, /^hsl\(/);
});

test('custom statuses get distinct stable category colors across refreshes and restarts', () => {
  const statuses = Array.from({ length: 30 }, (_, i) => status(String(i)));
  const registry = new StatusColors();
  const original = new Map(registry.include(statuses));
  assert.equal(new Set(original.values()).size, statuses.length);
  registry.include([status('new'), statuses[1]]);
  const refreshed = registry.include([...statuses].reverse());
  for (const [id, color] of original) assert.equal(refreshed.get(id), color);
  const restarted = new StatusColors().include([...statuses].reverse());
  for (const [id, color] of original) assert.equal(restarted.get(id), color);
  assert.equal(
    registry
      .include([{ ...statuses[0], name: 'Renamed custom status' }])
      .get('0'),
    original.get('0'),
  );
  assert.notEqual(
    new StatusColors().include([status('0', 'new')]).get('0'),
    original.get('0'),
  );
});

function contrastWithWhite(color: string): number {
  let rgb: number[];
  if (color.startsWith('#')) {
    rgb = [1, 3, 5].map(
      (index) => parseInt(color.slice(index, index + 2), 16) / 255,
    );
  } else {
    const [, hue, saturation, lightness] = color.match(
      /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/,
    )!;
    const h = Number(hue) / 30;
    const s = Number(saturation) / 100;
    const l = Number(lightness) / 100;
    const a = s * Math.min(l, 1 - l);
    rgb = [0, 8, 4].map((n) => {
      const k = (n + h) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    });
  }
  const [red, green, blue] = rgb.map((component) =>
    component <= 0.04045
      ? component / 12.92
      : ((component + 0.055) / 1.055) ** 2.4,
  );
  return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
}

test('semantic and custom badges keep white text readable in both themes', () => {
  const categories: Status['category'][] = ['new', 'indeterminate', 'done'];
  const statuses = categories.flatMap((category) =>
    Array.from({ length: 100 }, (_, i) => status(`${category}-${i}`, category)),
  );
  statuses.push(
    { ...status('open', 'new'), name: 'Open' },
    { ...status('progress'), name: 'In Progress' },
    { ...status('review'), name: 'Review' },
    { ...status('blocked'), name: 'Blocked' },
    { ...status('done', 'done'), name: 'Done' },
  );
  for (const color of new StatusColors().include(statuses).values()) {
    assert.ok(
      contrastWithWhite(color) >= 4.5,
      `${color} has insufficient contrast`,
    );
  }
});
