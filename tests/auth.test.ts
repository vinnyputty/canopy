import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth, brokerOrigin } from '../src/main/auth';
import type { Storage } from '../src/main/storage';

test('token connections verify scoped credentials before persistence and keep secrets out of renderer metadata', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const persisted: unknown[] = [];
  const store = {
    assertSecure() {},
    async writeSecrets(value: unknown) {
      persisted.push(structuredClone(value));
    },
  } as unknown as Storage;
  const auth = new Auth(store, async () => {
    throw new Error('Token sign-in must not open a browser.');
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/_edge/tenant_info'))
      return Response.json({ cloudId: 'cloud-123' });
    if (String(url).endsWith('/myself'))
      return Response.json({ accountId: 'account-1', displayName: 'Alex' });
    return Response.json({ issues: [] });
  };
  try {
    const connections = await auth.connect({
      siteUrl: 'https://example.atlassian.net',
      email: 'alex@example.com',
      token: 'token-secret',
      scoped: true,
    });
    assert.equal(
      calls[0].init?.headers,
      undefined,
      'Site discovery must not receive credentials.',
    );
    assert.equal(
      calls[1].url,
      'https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/myself',
    );
    assert.match(JSON.stringify(calls[1].init?.headers), /Basic /);
    assert.equal(persisted.length, 1);
    assert.equal(JSON.stringify(connections).includes('token-secret'), false);
    await auth.request(connections[0].id, '/rest/api/3/search/jql');
    assert.equal(
      calls[2].url,
      'https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/search/jql',
    );
    await auth.disconnect(connections[0].id);
    assert.deepEqual(auth.connections(), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('classic tokens use the site API and rejected credentials are never saved', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  const auth = new Auth(
    {
      assertSecure() {},
      async writeSecrets() {
        writes++;
      },
    } as unknown as Storage,
    async () => {},
  );
  globalThis.fetch = async (url) => {
    assert.equal(
      String(url),
      'https://example.atlassian.net/rest/api/3/myself',
    );
    return new Response(null, { status: 401 });
  };
  try {
    await assert.rejects(
      auth.connect({
        siteUrl: 'https://example.atlassian.net',
        email: 'alex@example.com',
        token: 'bad-secret',
        scoped: false,
      }),
      /Jira rejected/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(auth.connections(), []);
    await assert.rejects(
      auth.connect({
        siteUrl: 'https://attacker.example',
        email: 'alex@example.com',
        token: 'secret-token',
        scoped: false,
      }),
      /Jira Cloud site/,
    );
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('OAuth service origins require HTTPS except loopback and prohibit credentials or paths', () => {
  assert.equal(
    brokerOrigin('https://auth.example.com'),
    'https://auth.example.com',
  );
  assert.equal(brokerOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const origin of [
    'http://auth.example.com',
    'https://user:pass@auth.example.com',
    'https://auth.example.com/path',
    '',
  ])
    assert.throws(() => brokerOrigin(origin));
});
