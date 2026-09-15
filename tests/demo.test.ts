import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoProvider } from './fixtures/demo';

test('demo supports edits and sibling ranking without crossing tree boundaries', async () => {
  const provider = new DemoProvider();
  const first = await provider.tree('CAN-100');
  assert.equal(
    first.issues.some((i) => i.key === 'CAN-200'),
    false,
  );
  await provider.update('CAN-101', {
    summary: 'Updated story',
    assigneeId: null,
    transitionId: 'done',
  });
  assert.equal(
    (await provider.tree('CAN-100')).issues.find((i) => i.key === 'CAN-101')
      ?.summary,
    'Updated story',
  );
  assert.equal(
    first.issues.find((i) => i.key === 'CAN-101')?.summary,
    'Build the workspace foundation',
    'Snapshots must not mutate after edits.',
  );
  await provider.rank('CAN-110', 'CAN-101');
  const tree = await provider.tree('CAN-100');
  assert.ok(
    tree.issues.findIndex((i) => i.key === 'CAN-110') <
      tree.issues.findIndex((i) => i.key === 'CAN-101'),
  );
  await assert.rejects(provider.rank('CAN-102', 'CAN-110'), /siblings/);
});
