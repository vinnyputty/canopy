import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const DEFAULT_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'offline_access',
  'write:issue:jira-software',
];
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  host?: string;
  port?: number;
  scopes?: string[];
  sessionTtlMs?: number;
  maxSessions?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  now?: () => number;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Session {
  id: string;
  state: string;
  challenge: string;
  expiresAt: number;
  callbackClaimed: boolean;
  tokens?: TokenSet;
  exchangeFailed?: boolean;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

interface AtlassianTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function validateConfig(config: BrokerConfig): Required<
  Omit<BrokerConfig, 'scopes' | 'now'>
> & {
  scopes: string[];
  now: () => number;
} {
  if (!config.clientId.trim() || !config.clientSecret.trim()) {
    throw new Error('Atlassian client ID and client secret are required');
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(config.publicUrl);
  } catch {
    throw new Error('publicUrl must be an absolute URL');
  }
  const localHttp =
    publicUrl.protocol === 'http:' &&
    (publicUrl.hostname === 'localhost' ||
      publicUrl.hostname === '127.0.0.1' ||
      publicUrl.hostname === '::1');
  if (publicUrl.protocol !== 'https:' && !localHttp) {
    throw new Error(
      'publicUrl must use HTTPS (HTTP is allowed only for loopback development)',
    );
  }
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/'
  ) {
    throw new Error(
      'publicUrl must be an origin without credentials, a path, a query, or a fragment',
    );
  }

  const scopes = config.scopes ?? DEFAULT_SCOPES;
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[a-z][a-z0-9:._-]*$/.test(scope))
  ) {
    throw new Error('scopes must contain valid OAuth scope names');
  }

  const positiveInteger = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };

  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    publicUrl: publicUrl.origin,
    host: config.host ?? '127.0.0.1',
    port: positiveInteger(config.port ?? 8787, 'port'),
    scopes: [...new Set(scopes)],
    sessionTtlMs: positiveInteger(
      config.sessionTtlMs ?? 10 * 60_000,
      'sessionTtlMs',
    ),
    maxSessions: positiveInteger(config.maxSessions ?? 1_000, 'maxSessions'),
    rateLimitWindowMs: positiveInteger(
      config.rateLimitWindowMs ?? 60_000,
      'rateLimitWindowMs',
    ),
    rateLimitMaxRequests: positiveInteger(
      config.rateLimitMaxRequests ?? 120,
      'rateLimitMaxRequests',
    ),
    now: config.now ?? Date.now,
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
}

function sendHtml(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  const encoded = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p><p>You may close this window.</p></main></body></html>`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(encoded);
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw new HttpError(415, 'Content-Type must be application/json');

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large');
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES)
      throw new HttpError(413, 'Request body is too large');
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function parseTokenResponse(
  payload: AtlassianTokenResponse,
  now: number,
  previousRefreshToken?: string,
): TokenSet {
  if (
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0 ||
    payload.access_token.length > 16_384
  ) {
    throw new Error('Atlassian returned an invalid access token');
  }
  const refreshToken =
    typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : previousRefreshToken;
  if (!refreshToken || refreshToken.length > 16_384)
    throw new Error('Atlassian returned an invalid refresh token');
  if (
    typeof payload.expires_in !== 'number' ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new Error('Atlassian returned an invalid token lifetime');
  }
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: now + Math.floor(payload.expires_in * 1_000),
  };
}

async function exchangeToken(
  fetchImpl: typeof fetch,
  body: Record<string, string>,
  now: number,
  previousRefreshToken?: string,
): Promise<TokenSet> {
  const response = await fetchImpl(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Atlassian token exchange failed with HTTP ${response.status}`,
    );
  const payload = (await response.json()) as AtlassianTokenResponse;
  return parseTokenResponse(payload, now, previousRefreshToken);
}

export function createBroker(
  configInput: BrokerConfig,
  fetchImpl: typeof fetch = fetch,
): Server {
  const config = validateConfig(configInput);
  const sessions = new Map<string, Session>();
  const sessionIdByState = new Map<string, string>();
  const rateBuckets = new Map<string, RateBucket>();

  const removeSession = (session: Session): void => {
    sessions.delete(session.id);
    sessionIdByState.delete(session.state);
  };

  const cleanExpired = (): void => {
    const currentTime = config.now();
    for (const session of sessions.values()) {
      if (session.expiresAt <= currentTime) removeSession(session);
    }
    for (const [key, bucket] of rateBuckets) {
      if (bucket.resetAt <= currentTime) rateBuckets.delete(key);
    }
  };

  const checkRateLimit = (
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean => {
    const currentTime = config.now();
    const key = request.socket.remoteAddress ?? 'unknown';
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + config.rateLimitWindowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    response.setHeader('ratelimit-limit', config.rateLimitMaxRequests);
    response.setHeader(
      'ratelimit-remaining',
      Math.max(0, config.rateLimitMaxRequests - bucket.count),
    );
    response.setHeader('ratelimit-reset', Math.ceil(bucket.resetAt / 1_000));
    if (bucket.count <= config.rateLimitMaxRequests) return true;
    response.setHeader(
      'retry-after',
      Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1_000)),
    );
    sendJson(response, 429, { error: 'Too many requests' });
    return false;
  };

  return createServer(async (request, response) => {
    try {
      cleanExpired();
      if (!checkRateLimit(request, response)) return;

      const url = new URL(request.url ?? '/', config.publicUrl);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(request);
        if (
          typeof body.challenge !== 'string' ||
          !CHALLENGE_PATTERN.test(body.challenge)
        ) {
          throw new HttpError(
            400,
            'challenge must be a base64url-encoded SHA-256 digest',
          );
        }
        if (sessions.size >= config.maxSessions)
          throw new HttpError(503, 'Too many pending sessions');

        const session: Session = {
          id: randomBytes(24).toString('base64url'),
          state: randomBytes(32).toString('base64url'),
          challenge: body.challenge,
          expiresAt: config.now() + config.sessionTtlMs,
          callbackClaimed: false,
        };
        sessions.set(session.id, session);
        sessionIdByState.set(session.state, session.id);

        const authorizeUrl = new URL(ATLASSIAN_AUTHORIZE_URL);
        authorizeUrl.search = new URLSearchParams({
          audience: 'api.atlassian.com',
          client_id: config.clientId,
          scope: config.scopes.join(' '),
          redirect_uri: `${config.publicUrl}/callback`,
          state: session.state,
          response_type: 'code',
          prompt: 'consent',
        }).toString();
        sendJson(response, 201, {
          id: session.id,
          authorizeUrl: authorizeUrl.toString(),
        });
        return;
      }

      const pollMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && pollMatch) {
        const id = pollMatch[1];
        if (!SESSION_ID_PATTERN.test(id))
          throw new HttpError(404, 'Session not found');
        const session = sessions.get(id);
        if (!session) throw new HttpError(404, 'Session not found');

        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer '))
          throw new HttpError(401, 'A verifier bearer token is required');
        const verifier = authorization.slice('Bearer '.length);
        if (
          !VERIFIER_PATTERN.test(verifier) ||
          !secureEqual(challengeFor(verifier), session.challenge)
        ) {
          throw new HttpError(401, 'Invalid verifier');
        }
        if (session.exchangeFailed) {
          removeSession(session);
          throw new HttpError(
            502,
            'Atlassian authorization failed; start a new sign-in session',
          );
        }
        if (!session.tokens) {
          sendJson(response, 202, {
            status: 'pending',
            expiresAt: session.expiresAt,
          });
          return;
        }

        const tokens = session.tokens;
        removeSession(session);
        sendJson(response, 200, tokens);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/callback') {
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (!state || !code || state.length > 512 || code.length > 4_096) {
          sendHtml(
            response,
            400,
            'Canopy sign-in failed',
            'The authorization response was invalid or incomplete.',
          );
          return;
        }
        const id = sessionIdByState.get(state);
        const session = id ? sessions.get(id) : undefined;
        if (
          !session ||
          !secureEqual(state, session.state) ||
          session.callbackClaimed
        ) {
          sendHtml(
            response,
            400,
            'Canopy sign-in failed',
            'This sign-in session is invalid, expired, or already used.',
          );
          return;
        }

        session.callbackClaimed = true;
        sessionIdByState.delete(session.state);
        try {
          session.tokens = await exchangeToken(
            fetchImpl,
            {
              grant_type: 'authorization_code',
              client_id: config.clientId,
              client_secret: config.clientSecret,
              code,
              redirect_uri: `${config.publicUrl}/callback`,
            },
            config.now(),
          );
          sendHtml(
            response,
            200,
            'Canopy is connected',
            'Authorization succeeded. Return to Canopy to continue.',
          );
        } catch {
          session.exchangeFailed = true;
          sendHtml(
            response,
            502,
            'Canopy sign-in failed',
            'Atlassian could not complete authorization. Return to Canopy and try again.',
          );
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/refresh') {
        const body = await readJson(request);
        if (
          typeof body.refreshToken !== 'string' ||
          body.refreshToken.length < 1 ||
          body.refreshToken.length > 16_384
        ) {
          throw new HttpError(400, 'refreshToken is required');
        }
        try {
          const tokens = await exchangeToken(
            fetchImpl,
            {
              grant_type: 'refresh_token',
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: body.refreshToken,
            },
            config.now(),
            body.refreshToken,
          );
          sendJson(response, 200, tokens);
        } catch {
          throw new HttpError(502, 'Atlassian token refresh failed');
        }
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : 'Internal server error';
      sendJson(response, status, { error: message });
    }
  });
}

if (typeof require !== 'undefined' && require.main === module) {
  const server = createBroker({
    clientId: process.env.ATLASSIAN_CLIENT_ID ?? '',
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET ?? '',
    publicUrl: process.env.CANOPY_BROKER_URL ?? '',
    host: process.env.HOST,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ? Number(process.env.PORT) : 8787;
  server.listen(port, host, () => {
    process.stdout.write(`Canopy OAuth broker listening on ${host}:${port}\n`);
  });
}
