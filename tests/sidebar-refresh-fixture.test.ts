import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ControlledDemoProvider } from './fixtures/controlled';

it('holds changed refresh data until release and records completion only after the response is available', async () => {
  const provider = new ControlledDemoProvider();
  const original = await provider.tree('CAN-100');
  await provider.remoteUpdate('CAN-100', {
    summary: 'Completed sidebar refresh',
  });
  provider.hold('sidebar-refresh', 'tree', 'CAN-100');
  let responded = false;
  const response = provider.tree('CAN-100').then((snapshot) => {
    responded = true;
    return snapshot;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.started('sidebar-refresh'), true);
  assert.equal(responded, false);
  assert.equal(provider.completed('sidebar-refresh'), false);
  assert.notEqual(
    original.issues.find((issue) => issue.key === 'CAN-100')?.summary,
    'Completed sidebar refresh',
  );
  provider.release('sidebar-refresh');
  const refreshed = await response;
  assert.equal(responded, true);
  assert.equal(
    refreshed.issues.find((issue) => issue.key === 'CAN-100')?.summary,
    'Completed sidebar refresh',
  );
  assert.equal(provider.completed('sidebar-refresh'), true);
});
