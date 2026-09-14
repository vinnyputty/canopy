import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StatusColors } from '../src/renderer/status-colors';
import type { Status } from '../src/shared/types';

const status = (id: string): Status => ({
  id,
  name: id,
  category: 'indeterminate',
});

test('statuses in the same Jira category get distinct colors, including beyond the palette', () => {
  const colors = new StatusColors().include(
    Array.from({ length: 30 }, (_, i) => status(String(i))),
  );
  assert.equal(new Set(colors.values()).size, 30);
});

test('refresh order, new statuses, and filtering do not recolor existing statuses', () => {
  const registry = new StatusColors();
  const original = new Map(
    registry.include([status('review'), status('progress')]),
  );
  registry.include([status('new'), status('progress')]);
  const refreshed = registry.include([
    status('progress'),
    { ...status('review'), name: 'Renamed review' },
  ]);
  for (const [id, color] of original) assert.equal(refreshed.get(id), color);
});
