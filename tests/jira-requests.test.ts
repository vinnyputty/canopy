import assert from 'node:assert/strict';
import { it } from 'node:test';
import { JiraRateLimitError, JiraRequests } from '../src/main/jira-requests';

function gate() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('shares identical in-flight reads within a connection, including read-only POST bodies', async () => {
  const requests = new JiraRequests();
  const pending = gate();
  let calls = 0;
  const send = () => {
    calls++;
    return pending.promise;
  };
  const init = {
    method: 'POST',
    body: JSON.stringify({ jql: 'parent in ("A-1")', nextPageToken: 'page-2' }),
  };
  const a = requests.run('a', '/rest/api/3/search/jql', init, send);
  assert.equal(requests.run('a', '/rest/api/3/search/jql', init, send), a);
  const b = requests.run('b', '/rest/api/3/search/jql', init, send);
  const page = requests.run(
    'a',
    '/rest/api/3/search/jql',
    { ...init, body: '{}' },
    send,
  );
  await Promise.resolve();
  assert.equal(calls, 3);
  pending.resolve({ issues: [] });
  await Promise.all([a, b, page]);
  await requests.run('a', '/rest/api/3/search/jql', init, send);
  assert.equal(calls, 4, 'successful responses are not cached');
});

it('isolates cancelable reads and puts mutation dispatch and settlement between read generations', async () => {
  const requests = new JiraRequests();
  const pending = gate();
  const send = () => pending.promise;
  const path = '/rest/api/3/issue/A-1';
  const before = requests.run('a', path, {}, send);
  const signaled = requests.run(
    'a',
    path,
    { signal: new AbortController().signal },
    send,
  );
  assert.notEqual(before, signaled);
  const write = requests.run(
    'a',
    path,
    { method: 'PUT', body: '{}' },
    async () => {},
  );
  const during = requests.run('a', path, {}, send);
  assert.notEqual(before, during);
  await write;
  const after = requests.run('a', path, {}, send);
  assert.notEqual(during, after);
  pending.resolve({});
  await Promise.all([before, signaled, during, after]);
});

it('honors seconds and HTTP-date cooldowns across all operations without replaying writes', async () => {
  let now = Date.UTC(2026, 0, 1);
  const requests = new JiraRequests(() => now);
  let calls = 0;
  const send = async () => {
    calls++;
  };
  const error = requests.rateLimited('a', '10');
  assert.equal(error.retryAt, now + 10_000);
  for (const method of ['GET', 'POST', 'PUT'])
    await assert.rejects(
      requests.run('a', '/rest/api/3/issue/A-1', { method }, send),
      JiraRateLimitError,
    );
  assert.equal(calls, 0);
  await requests.run('b', '/rest/api/3/issue/A-1', {}, send);
  assert.equal(calls, 1);
  now += 10_000;
  assert.deepEqual(requests.syncStatus('a'), { retryAt: null });
  await requests.run('a', '/rest/api/3/issue/A-1', {}, send);
  assert.equal(calls, 2);
  const date = new Date(now + 60_000).toUTCString();
  assert.equal(requests.rateLimited('a', date).retryAt, now + 60_000);
});

it('backs off malformed headers exponentially, caps fallback, and resets after successful recovery', async () => {
  let now = 1000;
  const requests = new JiraRequests(() => now);
  for (const delay of [
    30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
  ]) {
    const error = requests.rateLimited('a', 'invalid');
    assert.equal(error.retryAt, now + delay);
    assert.equal(
      requests.rateLimited('a', null).retryAt,
      error.retryAt,
      'concurrent failures share one backoff step',
    );
    now = error.retryAt;
  }
  await requests.run('a', '/rest/api/3/myself', {}, async () => ({}));
  assert.equal(requests.rateLimited('a', null).retryAt, now + 30_000);
  requests.forget('a');
  assert.equal(requests.syncStatus('a').retryAt, null);
});

it('a read started before a rate limit cannot clear the cooldown when it completes', async () => {
  let now = 1000;
  const requests = new JiraRequests(() => now);
  const pending = gate();
  const read = requests.run(
    'a',
    '/rest/api/3/myself',
    {},
    () => pending.promise,
  );
  now++;
  const error = requests.rateLimited('a', '30');
  pending.resolve({});
  await read;
  assert.equal(requests.syncStatus('a').retryAt, error.retryAt);
});
