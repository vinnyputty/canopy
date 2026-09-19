import assert from 'node:assert/strict';
import { it } from 'node:test';
import { JiraConsistency } from '../src/main/jira-consistency';
import type { Issue } from '../src/shared/types';

const issue = (id: number): Issue => ({
  id: String(id),
  key: `A-${id}`,
  parentKey: 'A-1',
  summary: 'Saved',
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: '1', name: 'Open', category: 'new' },
  links: [],
});

it('bounds reconciliation to 50 changed issues and expires protection without extending it on reads', (context) => {
  let now = 1000;
  context.mock.method(Date, 'now', () => now);
  const consistency = new JiraConsistency();
  for (let id = 2; id <= 52; id++) {
    consistency.changed(`A-${id}`, id);
    consistency.confirm(issue(id), { summary: 'Saved' });
  }
  assert.equal(consistency.ids().length, 50);
  assert.equal(consistency.ids().includes(2), false);
  const stale = { ...issue(3), summary: 'Stale' };
  assert.equal(consistency.disagrees(stale, consistency.snapshot()), true);
  consistency.moved(issue(3), 'A-4', 'after');
  const captured = consistency.snapshot();
  now += 5 * 60 * 1000 - 1;
  assert.equal(consistency.ids().length, 50);
  now++;
  assert.deepEqual(consistency.ids(), []);
  assert.equal(consistency.disagrees(stale, captured), false);
  assert.deepEqual(
    consistency.rank([issue(3), issue(4)], captured).parents,
    [],
  );
});

it('protects overlapping responses captured before another response observes rank convergence', () => {
  const consistency = new JiraConsistency();
  consistency.moved(issue(4), 'A-2', 'before');
  const older = consistency.snapshot();
  consistency.rank([issue(4), issue(2), issue(3)], consistency.snapshot());
  assert.equal(consistency.snapshot().moves.length, 0);
  const result = consistency.rank([issue(2), issue(3), issue(4)], older);
  assert.deepEqual(
    result.issues.map((issue) => issue.key),
    ['A-4', 'A-2', 'A-3'],
  );
});

it('keeps the successful-write deadline when a later direct read confirms the fields', (context) => {
  let now = 1000;
  context.mock.method(Date, 'now', () => now);
  const consistency = new JiraConsistency();
  consistency.changed('A-2', 2);
  now += 4 * 60 * 1000;
  consistency.confirm(issue(2), { summary: 'Saved' });
  assert.deepEqual(consistency.ids(), [2]);
  now += 60 * 1000;
  assert.deepEqual(consistency.ids(), []);
});
