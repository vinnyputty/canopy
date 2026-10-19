import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runSetupVerification,
  verifiedSetupConnection,
} from '../src/renderer/connection-setup';
import type { Connection } from '../src/shared/types';

const other: Connection = {
  id: 'token:other',
  provider: 'jira',
  name: 'Other',
  url: 'https://other.atlassian.net',
};
const team: Connection = {
  id: 'token:team',
  provider: 'jira',
  name: 'Team',
  url: 'https://team.atlassian.net',
};

test('canonical Jira reconnect selects the replaced account rather than another site', () => {
  for (const siteUrl of [
    'https://TEAM.atlassian.net',
    'https://team.atlassian.net:443',
    ' https://TEAM.atlassian.net:443/ ',
  ]) {
    const previous = [other, team];
    const replaced = { ...team, accountName: 'Verified fixture account' };
    assert.equal(
      verifiedSetupConnection([other, replaced], previous, {
        provider: 'jira',
        siteUrl,
        repositories: '',
      }),
      replaced,
    );
  }
  const secondAccount = { ...team, id: 'token:second-account' };
  assert.equal(
    verifiedSetupConnection(
      [other, team, secondAccount],
      [other, team, secondAccount],
      {
        provider: 'jira',
        siteUrl: 'https://TEAM.atlassian.net:443',
        repositories: '',
      },
    ),
    secondAccount,
  );
  assert.equal(
    verifiedSetupConnection([other], [other], {
      provider: 'jira',
      siteUrl: team.url,
      repositories: '',
    }),
    undefined,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('dismissed verification cannot reopen setup, replace a newer dialog, or change workspace on late success/failure', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const pending = deferred<Connection[]>();
    let open = true;
    let dialog = 'connect';
    const workspace = { root: 'OTHER-1', selected: 'OTHER-2' };
    let callbacks = 0;
    const attempt = runSetupVerification(() => pending.promise, {
      isOpen: () => open,
      success: () => {
        callbacks++;
        dialog = 'verified';
        workspace.root = 'TEAM-1';
      },
      failure: () => {
        callbacks++;
        dialog = 'error';
      },
      settled: () => {
        callbacks++;
      },
    });
    open = false;
    dialog = 'open'; // The user has already chosen another action.
    if (outcome === 'success') pending.resolve([team]);
    else pending.reject(new Error('Fixture verification failed'));
    await attempt;
    assert.equal(callbacks, 0);
    assert.equal(dialog, 'open');
    assert.deepEqual(workspace, { root: 'OTHER-1', selected: 'OTHER-2' });
  }
});

test('active verification shows the actual verified connection and settles, while failures remain retryable', async () => {
  const events: unknown[] = [];
  const callbacks = {
    isOpen: () => true,
    success: (value: Connection[]) => events.push(value),
    failure: (error: unknown) => events.push(error),
    settled: () => events.push('settled'),
  };
  await runSetupVerification(async () => [team], callbacks);
  assert.deepEqual(events, [[team], 'settled']);
  events.length = 0;
  const error = new Error('Fixture failure');
  await runSetupVerification(async () => {
    throw error;
  }, callbacks);
  assert.deepEqual(events, [error, 'settled']);
});
