import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  RefreshAnnouncements,
  RootRefreshGate,
  treeRefreshError,
  type RefreshAnnouncement,
} from '../src/renderer/refresh';
import type { TreeSnapshot } from '../src/shared/types';
import { ControlledDemoProvider } from './fixtures/controlled';

it('presents the recorded tree IPC failure while preserving other error messages', () => {
  const failure =
    "Error invoking remote method 'canopy:tree': Error: Sample refresh failure";
  assert.equal(treeRefreshError(new Error(failure)), 'Sample refresh failure');
  assert.equal(treeRefreshError(failure), 'Sample refresh failure');
  for (const message of [
    'Provider unavailable',
    "Error invoking remote method 'canopy:update': Error: Update failed",
    "Error invoking remote method 'canopy:tree': Error: ",
    "Error invoking remote method 'canopy:tree': TypeError: Invalid input",
    `Provider detail: ${failure}`,
  ])
    assert.equal(treeRefreshError(new Error(message)), message);
  assert.equal(treeRefreshError(null), 'null');
});

it('retains real sample data through wrapped failure and reports held explicit retry completion', async () => {
  const provider = new ControlledDemoProvider();
  const previous = await provider.tree('CAN-100');
  const gate = new RootRefreshGate<TreeSnapshot>(() => previous.fetchedAt);
  const messages: RefreshAnnouncement[] = [];
  const feedback = new RefreshAnnouncements((message) =>
    messages.push(message),
  );
  feedback.activate('a');
  provider.hold('failure', 'tree', 'CAN-100');
  feedback.request('a');
  const request = feedback.begin('a', 'CAN-100', previous);
  const load = gate.load('demo/CAN-100', true, false, async () => {
    try {
      return await provider.tree('CAN-100');
    } catch (error) {
      // Faithful envelope recorded by actual Electron canopy:tree acceptance.
      throw new Error(
        `Error invoking remote method 'canopy:tree': ${String(error)}`,
      );
    }
  });
  assert.ok('promise' in load);
  const rejected = assert.rejects(load.promise, (error) => {
    feedback.fail(request, 'CAN-100', treeRefreshError(error));
    return true;
  });
  while (!provider.started('failure'))
    await new Promise((resolve) => setImmediate(resolve));
  provider.release('failure', 'Sample refresh failure');
  await rejected;
  assert.equal(
    messages.at(-1)?.text,
    `Couldn’t refresh CAN-100: Sample refresh failure; ${previous.issues.length} issues retained, last updated at ${new Date(previous.fetchedAt).toLocaleTimeString()}`,
  );
  assert.equal(previous.issues.length, 15);
  provider.hold('retry', 'tree', 'CAN-100');
  feedback.request('a');
  const retry = feedback.begin('a', 'CAN-100', previous);
  const retryLoad = gate.load('demo/CAN-100', true, false, () =>
    provider.tree('CAN-100'),
  );
  assert.ok('promise' in retryLoad);
  while (!provider.started('retry'))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1)?.text, 'Checking CAN-100 for changes');
  assert.equal(provider.completed('retry'), false);
  provider.release('retry');
  const delivered = await retryLoad.promise;
  feedback.complete(retry, delivered);
  assert.equal(provider.completed('retry'), true);
  assert.match(messages.at(-1)!.text, /CAN-100: 15 issues, last updated at/);
});
