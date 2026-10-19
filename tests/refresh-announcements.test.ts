import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  RefreshAnnouncements,
  RootRefreshGate,
  type RefreshAnnouncement,
} from '../src/renderer/refresh';
import type { TreeSnapshot } from '../src/shared/types';

const tree = (fetchedAt: number, warnings: string[] = []): TreeSnapshot => ({
  rootKey: 'CAN-100',
  issues: [],
  warnings,
  fetchedAt,
});
const setup = () => {
  const messages: RefreshAnnouncement[] = [];
  const feedback = new RefreshAnnouncements((message) =>
    messages.push(message),
  );
  feedback.activate('a');
  return { feedback, messages };
};

it('keeps unchanged timer/focus polls quiet, including forced automatic recovery reads', () => {
  const { feedback, messages } = setup();
  for (const fetchedAt of [30_000, 60_000, 60_001]) {
    const request = feedback.begin('a', 'CAN-100', tree(0));
    feedback.complete(request, tree(fetchedAt));
  }
  assert.equal(messages.length, 0);
  const changed = feedback.begin('a', 'CAN-100', tree(60_001));
  feedback.complete(changed, tree(90_000, ['Partial result']));
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /CAN-100: 0 issues, last updated/);
});

it('publishes requested progress, retained failure, held Retry and actual completion', () => {
  const { feedback, messages } = setup();
  feedback.request('a');
  const manual = feedback.begin('a', 'CAN-100', tree(1000));
  assert.equal(messages.at(-1)?.text, 'Checking CAN-100 for changes');
  feedback.fail(manual, 'CAN-100', 'Sample failure');
  assert.match(
    messages.at(-1)!.text,
    /Sample failure; 0 issues retained, last updated/,
  );
  feedback.request('a');
  const retry = feedback.begin('a', 'CAN-100', tree(1000));
  assert.equal(messages.at(-1)?.text, 'Checking CAN-100 for changes');
  assert.equal(messages.length, 3); // Held request has no completion yet.
  feedback.complete(retry, tree(2000));
  assert.match(messages.at(-1)!.text, /CAN-100: 0 issues, last updated/);
  assert.equal(messages.length, 4);
  feedback.request('a');
  const emptyRetry = feedback.begin('a', 'CAN-100');
  assert.equal(messages.at(-1)?.text, 'Checking CAN-100 for changes');
  feedback.complete(emptyRetry, tree(3000));
  assert.equal(messages.length, 6);
});

it('announces automatic failure and recovery once, without poll progress or timestamp chatter', () => {
  const { feedback, messages } = setup();
  for (let i = 0; i < 2; i++) {
    const request = feedback.begin('a', 'CAN-100', tree(1000));
    feedback.fail(request, 'CAN-100', 'Offline');
    assert.ok(
      messages.every((message) => !message.text.startsWith('Checking')),
    );
  }
  assert.equal(messages[0].text, messages[1].text); // Identical DOM text, no new speech claim.
  const recovery = feedback.begin('a', 'CAN-100', tree(1000));
  feedback.complete(recovery, tree(2000));
  assert.match(messages.at(-1)!.text, /last updated/);
  const poll = feedback.begin('a', 'CAN-100', tree(2000));
  feedback.complete(poll, tree(3000));
  assert.equal(messages.length, 3);
});

it('retains a manual request deferred behind a poll and rejects superseded root generations', async () => {
  const { feedback, messages } = setup();
  const gate = new RootRefreshGate<TreeSnapshot>();
  let release!: (snapshot: TreeSnapshot) => void;
  const old = gate.load(
    'root',
    false,
    false,
    () =>
      new Promise<TreeSnapshot>((resolve) => {
        release = resolve;
      }),
  );
  assert.ok('promise' in old);
  const automatic = feedback.begin('a', 'CAN-100', tree(0));
  assert.equal(feedback.request('a'), true);
  // Old automatic delivery must not consume the queued user request.
  feedback.complete(automatic, tree(1000));
  assert.equal(messages.length, 0);
  const fresh = gate.load('root', true, false, async () => tree(2000));
  assert.ok('promise' in fresh);
  const manual = feedback.begin('a', 'CAN-100', tree(1000));
  assert.equal(feedback.request('a'), false); // Repeated command coalesces.
  release(tree(1000));
  await old.promise;
  assert.equal(gate.isCurrent('root', old.generation), false);
  feedback.complete(automatic, tree(1000, ['Obsolete result']));
  assert.equal(messages.length, 1);
  const result = await fresh.promise;
  assert.equal(gate.isCurrent('root', fresh.generation), true);
  feedback.complete(manual, result);
  assert.equal(messages.length, 2);
});

it('scopes completion/failure to the current navigation and forgets closed identities', () => {
  const { feedback, messages } = setup();
  feedback.request('a');
  const departed = feedback.begin('a', 'CAN-100', tree(0));
  const oldScope = feedback.scope;
  feedback.activate('b');
  feedback.complete(departed, tree(1000, ['New data']));
  const background = feedback.begin('a', 'CAN-100', tree(1000));
  feedback.fail(background, 'CAN-100', 'Background error');
  feedback.activate('a');
  assert.notEqual(feedback.scope, oldScope);
  feedback.request('a');
  const closing = feedback.begin('a', 'CAN-100', tree(1000));
  feedback.forget('a');
  feedback.fail(closing, 'CAN-100', 'Closed error');
  assert.equal(messages.length, 2); // Only the two requested starts while current.
  const reopened = feedback.begin('a', 'CAN-100', tree(1000));
  feedback.complete(reopened, tree(2000));
  assert.equal(messages.length, 2);
});

it('removes abandoned requested progress without inventing a completion', () => {
  const { feedback, messages } = setup();
  feedback.request('a');
  const request = feedback.begin('a', 'CAN-100', tree(0));
  feedback.end(request);
  assert.equal(messages.at(-1)?.text, '');
  assert.equal(feedback.request('a'), true);
});

it('suppresses late completion after leaving and returning to the same tab identity', () => {
  const { feedback, messages } = setup();
  feedback.request('a');
  const request = feedback.begin('a', 'CAN-100', tree(0));
  feedback.activate('b');
  feedback.activate('a');
  feedback.complete(request, tree(1000, ['Late result']));
  assert.equal(messages.length, 1);
});

it('announces meaningful delivered data only for the active alias of a shared root', () => {
  const { feedback, messages } = setup();
  feedback.receive('background', tree(1000, ['New data']), tree(0));
  feedback.receive('a', tree(1000), tree(0));
  assert.equal(messages.length, 0);
  feedback.receive('a', tree(2000, ['New data']), tree(1000));
  assert.match(messages.at(-1)!.text, /^Changes found\./);
  assert.equal(messages.length, 1);
});
