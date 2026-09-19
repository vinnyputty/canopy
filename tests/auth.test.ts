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
    const controller = new AbortController();
    await auth.request(connections[0].id, '/rest/api/3/search/jql', {
      signal: controller.signal,
    });
    const forwarded = calls.at(-1)!.init!.signal!;
    assert.equal(forwarded.aborted, false);
    controller.abort();
    assert.equal(forwarded.aborted, true);
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

function transportHarness() {
  const connection = {
    id: 'test-a',
    name: 'A',
    url: 'https://example.atlassian.net',
    provider: 'jira',
  };
  const other = { ...connection, id: 'test-b' };
  const auth = new Auth(
    {
      readSecrets: async () => ({
        accounts: [connection, other].map((connection) => ({
          connection,
          email: 'test@example.com',
          token: 'fixture-token',
          apiBase: 'https://example.atlassian.net',
        })),
        grants: [],
      }),
      writeSecrets: async () => {},
    } as unknown as Storage,
    async () => {},
  );
  return auth;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Auth shares overlapping reads and enforces rate limits across reads and writes with connection isolation', async () => {
  const original = globalThis.fetch;
  const auth = transportHarness();
  await auth.load();
  const response = deferred<Response>();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response.promise;
  };
  try {
    const a = auth.request('test-a', '/rest/api/3/myself');
    const b = auth.request('test-a', '/rest/api/3/myself');
    await Promise.resolve();
    assert.equal(calls, 1);
    response.resolve(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    );
    await Promise.all([
      assert.rejects(a, /rate limit/),
      assert.rejects(b, /rate limit/),
    ]);
    assert.ok(auth.syncStatus('test-a').retryAt! > Date.now());
    await assert.rejects(
      auth.request('test-a', '/rest/api/3/issue/A-1', {
        method: 'PUT',
        body: '{}',
      }),
      /rate limit/,
    );
    assert.equal(calls, 1);
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ id: 'b' });
    };
    assert.deepEqual(await auth.request('test-b', '/rest/api/3/myself'), {
      id: 'b',
    });
    assert.equal(calls, 2);
    await auth.disconnect('test-a');
    assert.deepEqual(auth.syncStatus('test-a'), { retryAt: null });
  } finally {
    globalThis.fetch = original;
  }
});

test('disconnect rejects late response bodies and late rate limits without recreating connection state', async () => {
  const original = globalThis.fetch;
  const auth = transportHarness();
  await auth.load();
  const body = deferred<string>();
  const response = Response.json({});
  response.text = () => body.promise;
  const arrived = deferred<void>();
  globalThis.fetch = async () => {
    arrived.resolve();
    return response;
  };
  try {
    const request = auth.request('test-a', '/rest/api/3/myself');
    await arrived.promise;
    await Promise.resolve();
    await auth.disconnect('test-a');
    body.resolve('{}');
    await assert.rejects(request, /connection changed/);
    const late = deferred<Response>();
    globalThis.fetch = () => late.promise;
    const limited = auth.request('test-b', '/rest/api/3/myself');
    await Promise.resolve();
    await auth.disconnect('test-b');
    late.resolve(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    );
    await assert.rejects(limited, /connection changed/);
    assert.deepEqual(auth.syncStatus('test-b'), { retryAt: null });
  } finally {
    globalThis.fetch = original;
  }
});

test('canceling a caller signal does not cancel a shared unsignaled read', async () => {
  const original = globalThis.fetch;
  const auth = transportHarness();
  await auth.load();
  const pending = deferred<Response>();
  const controller = new AbortController();
  const started = deferred<void>();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) return pending.promise;
    started.resolve();
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => reject(init!.signal!.reason),
        { once: true },
      );
    });
  };
  try {
    const ordinary = auth.request('test-a', '/rest/api/3/myself');
    const canceled = auth.request('test-a', '/rest/api/3/myself', {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await assert.rejects(canceled, /abort/i);
    pending.resolve(Response.json({ id: 'success' }));
    assert.deepEqual(await ordinary, { id: 'success' });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a write waiting for OAuth refresh checks a newly established cooldown before dispatch', async () => {
  const original = globalThis.fetch;
  const grant = {
    id: 'grant',
    brokerUrl: 'https://broker.example.com',
    tokens: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000,
    },
    connections: [
      {
        id: 'grant:cloud',
        name: 'Fixture',
        url: 'https://fixture.atlassian.net',
        provider: 'jira',
      },
    ],
  };
  const auth = new Auth(
    {
      readSecrets: async () => ({ grants: [grant], accounts: [] }),
      writeSecrets: async () => {},
    } as unknown as Storage,
    async () => {},
  );
  await auth.load();
  const readResponse = deferred<Response>();
  const tokenResponse = deferred<Response>();
  const refreshing = deferred<void>();
  let writes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/refresh')) {
      refreshing.resolve();
      return tokenResponse.promise;
    }
    if (init?.method === 'PUT') {
      writes++;
      return new Response(null, { status: 204 });
    }
    return readResponse.promise;
  };
  try {
    const read = auth.request('grant:cloud', '/rest/api/3/myself');
    await Promise.resolve();
    grant.tokens.expiresAt = 0;
    const write = auth.request('grant:cloud', '/rest/api/3/issue/A-1', {
      method: 'PUT',
      body: '{}',
    });
    await refreshing.promise;
    readResponse.resolve(
      new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    await assert.rejects(read, /rate limit/);
    tokenResponse.resolve(
      Response.json({
        accessToken: 'new-fixture-access',
        refreshToken: 'new-fixture-refresh',
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await assert.rejects(write, /rate limit/);
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = original;
  }
});
