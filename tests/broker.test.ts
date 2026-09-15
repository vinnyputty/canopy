import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import type { Server } from 'node:http';
import { createBroker, type BrokerConfig } from '../broker/server.js';

const servers: Server[] = [];
const verifier = 'canopy-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
const challenge = createHash('sha256')
  .update(verifier, 'ascii')
  .digest('base64url');

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startBroker(
  overrides: Partial<BrokerConfig> = {},
  fetchImpl: typeof fetch = async () => {
    throw new Error('Unexpected token request');
  },
): Promise<string> {
  const server = createBroker(
    {
      clientId: 'client-id',
      clientSecret: 'server-only-secret',
      publicUrl: 'http://127.0.0.1',
      ...overrides,
    },
    fetchImpl,
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function createSession(
  baseUrl: string,
): Promise<{ id: string; authorizeUrl: string }> {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string; authorizeUrl: string }>;
}

test('rejects an invalid callback state without contacting Atlassian', async () => {
  let tokenRequests = 0;
  const baseUrl = await startBroker({}, async () => {
    tokenRequests += 1;
    return new Response(null, { status: 500 });
  });
  await createSession(baseUrl);

  const callback = await fetch(
    `${baseUrl}/callback?state=wrong-state&code=authorization-code`,
  );

  assert.equal(callback.status, 400);
  assert.equal(tokenRequests, 0);
  assert.match(await callback.text(), /invalid, expired, or already used/);
});

test('keeps a session pending and rejects a mismatched verifier', async () => {
  const baseUrl = await startBroker();
  const session = await createSession(baseUrl);

  const mismatch = await fetch(`${baseUrl}/sessions/${session.id}`, {
    headers: { authorization: `Bearer ${'x'.repeat(43)}` },
  });
  assert.equal(mismatch.status, 401);

  const pending = await fetch(`${baseUrl}/sessions/${session.id}`, {
    headers: { authorization: `Bearer ${verifier}` },
  });
  assert.equal(pending.status, 202);
  assert.equal(
    ((await pending.json()) as { status: string }).status,
    'pending',
  );
});

test('exchanges a callback once and permits one verifier-guarded redemption', async () => {
  const requests: Array<Record<string, string>> = [];
  const baseUrl = await startBroker({}, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, string>);
    return Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });
  });
  const session = await createSession(baseUrl);
  const state = new URL(session.authorizeUrl).searchParams.get('state');
  assert.ok(state);

  const callback = await fetch(
    `${baseUrl}/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
  );
  assert.equal(callback.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].client_secret, 'server-only-secret');
  assert.equal(requests[0].code, 'authorization-code');

  const replayedCallback = await fetch(
    `${baseUrl}/callback?state=${encodeURIComponent(state)}&code=another-code`,
  );
  assert.equal(replayedCallback.status, 400);
  assert.equal(requests.length, 1);

  const redemption = await fetch(`${baseUrl}/sessions/${session.id}`, {
    headers: { authorization: `Bearer ${verifier}` },
  });
  assert.equal(redemption.status, 200);
  const tokens = (await redemption.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
  assert.equal(tokens.accessToken, 'access-token');
  assert.equal(tokens.refreshToken, 'refresh-token');
  assert.ok(tokens.expiresAt > Date.now());

  const replayedRedemption = await fetch(`${baseUrl}/sessions/${session.id}`, {
    headers: { authorization: `Bearer ${verifier}` },
  });
  assert.equal(replayedRedemption.status, 404);
});

test('expires abandoned sessions', async () => {
  let now = 1_000;
  const baseUrl = await startBroker({ sessionTtlMs: 500, now: () => now });
  const session = await createSession(baseUrl);
  now += 501;

  const response = await fetch(`${baseUrl}/sessions/${session.id}`, {
    headers: { authorization: `Bearer ${verifier}` },
  });

  assert.equal(response.status, 404);
});

test('refreshes and returns a rotated token set', async () => {
  let requestBody: Record<string, string> | undefined;
  const baseUrl = await startBroker({}, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, string>;
    return Response.json({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 60,
    });
  });

  const response = await fetch(`${baseUrl}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'old-refresh' }),
  });

  assert.equal(response.status, 200);
  assert.equal(requestBody?.grant_type, 'refresh_token');
  assert.equal(requestBody?.refresh_token, 'old-refresh');
  assert.deepEqual(Object.keys((await response.json()) as object).sort(), [
    'accessToken',
    'expiresAt',
    'refreshToken',
  ]);
});
