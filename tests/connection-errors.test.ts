import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  providerFetch,
  verificationError,
} from '../src/main/connection-errors';

test('Jira verification distinguishes credentials, scopes, rate limits, and transient provider failure', async () => {
  for (const [status, expected] of [
    [401, /email.*token type/],
    [403, /scopes.*Browse projects.*policy/],
    [429, /rate limit/],
    [503, /Retry later/],
  ] as const)
    assert.match(
      (await verificationError('Jira', new Response(null, { status }))).message,
      expected,
    );
});

test('caller cancellation stays cancellation while timeouts have connectivity recovery', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      throw init!.signal!.reason;
    };
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(
      providerFetch('https://fixture.invalid', { signal: canceled.signal }),
      { name: 'AbortError' },
    );
    const timeout = new AbortController();
    timeout.abort(new DOMException('fixture timeout', 'TimeoutError'));
    await assert.rejects(
      providerFetch('https://fixture.invalid', { signal: timeout.signal }),
      /internet connection.*timeout/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('GitHub secondary rate limits use recovery steps without exposing the response body', async () => {
  const error = await verificationError(
    'GitHub',
    Response.json(
      { message: 'secondary rate limit private-fixture' },
      { status: 403, headers: { 'retry-after': '120' } },
    ),
  );
  assert.match(error.message, /rate limit.*Retry after/);
  assert.doesNotMatch(error.message, /private-fixture/);
});
