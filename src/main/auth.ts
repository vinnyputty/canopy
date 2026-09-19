import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Connection, TokenConnectionInput } from '../shared/types';
import type { Storage } from './storage';

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Grant = {
  id: string;
  brokerUrl: string;
  tokens: Tokens;
  connections: Connection[];
};
type TokenAccount = {
  connection: Connection;
  email: string;
  token: string;
  apiBase: string;
};
export function brokerOrigin(value: string) {
  if (!value)
    throw new Error(
      'Jira sign-in is not configured. Set CANOPY_BROKER_URL to your Canopy OAuth service; see docs/oauth.md.',
    );
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error(
      'The OAuth service must be an HTTPS origin (HTTP loopback is allowed for development).',
    );
  return url.origin;
}
async function json(response: Response) {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.error_description || body.error || '';
    } catch {}
    throw new Error(
      `Sign-in service returned ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}.`,
    );
  }
  return response.json();
}
function tokens(value: Tokens): Tokens {
  if (
    !value ||
    typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    !Number.isFinite(value.expiresAt)
  )
    throw new Error('The sign-in service returned invalid credentials.');
  return value;
}
export class Auth {
  private grants: Grant[] = [];
  private accounts: TokenAccount[] = [];
  private refreshing = new Map<string, Promise<void>>();
  private connecting?: Promise<Connection[]>;
  constructor(
    private storage: Storage,
    private openBrowser: (url: string) => Promise<void>,
  ) {}
  async load() {
    const saved = await this.storage.readSecrets<{
      grants: Grant[];
      accounts: TokenAccount[];
    }>();
    this.grants = saved?.grants ?? [];
    this.accounts = saved?.accounts ?? [];
  }
  private save() {
    return this.storage.writeSecrets({
      grants: this.grants,
      accounts: this.accounts,
    });
  }
  connections() {
    return [
      ...this.accounts.map((a) => a.connection),
      ...this.grants.flatMap((g) => g.connections),
    ];
  }
  connect(input?: TokenConnectionInput) {
    if (input) return this.connectToken(input);
    if (!this.connecting)
      this.connecting = this.startConnect().finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  private async connectToken(input: TokenConnectionInput) {
    this.storage.assertSecure();
    if (
      typeof input.siteUrl !== 'string' ||
      typeof input.email !== 'string' ||
      typeof input.token !== 'string' ||
      typeof input.scoped !== 'boolean'
    )
      throw new Error('Enter your Jira site, Atlassian email, and API token.');
    const site = new URL(input.siteUrl.trim());
    if (
      site.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.atlassian\.net$/.test(site.hostname) ||
      site.port ||
      site.username ||
      site.password ||
      site.search ||
      site.hash ||
      site.pathname !== '/'
    )
      throw new Error(
        'Enter your Jira Cloud site origin, such as https://your-team.atlassian.net.',
      );
    const email = input.email.trim();
    const token = input.token.trim();
    if (
      !/^[^\s:@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      token.length < 8 ||
      token.length > 16384
    )
      throw new Error('Enter a valid Atlassian email and API token.');
    let apiBase = site.origin;
    if (input.scoped) {
      const response = await fetch(`${site.origin}/_edge/tenant_info`, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(
          'Could not discover this Jira Cloud site. Check the site URL.',
        );
      const resource = await response.json();
      if (
        typeof resource.cloudId !== 'string' ||
        !/^[a-zA-Z0-9-]+$/.test(resource.cloudId)
      )
        throw new Error('Jira returned an invalid cloud site identifier.');
      apiBase = `https://api.atlassian.com/ex/jira/${resource.cloudId}`;
    }
    const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    const response = await fetch(`${apiBase}/rest/api/3/myself`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `Jira rejected this connection (${response.status}). Check the email, token type/scopes, site access, and your company’s API-token policy.`,
      );
    const account = await response.json();
    if (typeof account.accountId !== 'string')
      throw new Error('Jira did not return a valid account.');
    const id = `token:${createHash('sha256').update(`${site.origin}:${account.accountId}`).digest('hex').slice(0, 24)}`;
    const connection: Connection = {
      id,
      name: site.hostname.split('.')[0],
      accountName: account.displayName ?? email,
      url: site.origin,
      provider: 'jira',
    };
    const saved = { connection, email, token, apiBase };
    this.accounts = [
      ...this.accounts.filter((a) => a.connection.id !== id),
      saved,
    ];
    await this.save();
    return this.connections();
  }
  private async startConnect() {
    this.storage.assertSecure();
    const origin = brokerOrigin(process.env.CANOPY_BROKER_URL ?? '');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const session = await json(
      await fetch(`${origin}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge }),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      }),
    );
    const authorize = new URL(session.authorizeUrl);
    if (
      authorize.origin !== 'https://auth.atlassian.com' ||
      authorize.pathname !== '/authorize' ||
      !/^[A-Za-z0-9_-]+$/.test(session.id)
    )
      throw new Error(
        'The sign-in service returned an unexpected authorization URL.',
      );
    await this.openBrowser(authorize.href);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await delay(1500);
      const response = await fetch(`${origin}/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${verifier}` },
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (response.status === 202) continue;
      const credentials = tokens(await json(response));
      const resources = await json(
        await fetch(
          'https://api.atlassian.com/oauth/token/accessible-resources',
          {
            headers: { Authorization: `Bearer ${credentials.accessToken}` },
            signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          },
        ),
      );
      if (!Array.isArray(resources))
        throw new Error('Jira returned an invalid list of sites.');
      const grantId = randomUUID();
      const connections: Connection[] = resources
        .filter(
          (r) => Array.isArray(r.scopes) && r.scopes.includes('read:jira-work'),
        )
        .map((r) => {
          const site = new URL(r.url);
          if (site.protocol !== 'https:' || site.username || site.password)
            throw new Error('Jira returned an invalid site URL.');
          return {
            id: `${grantId}:${r.id}`,
            name: String(r.name),
            url: site.origin,
            provider: 'jira' as const,
          };
        });
      if (!connections.length)
        throw new Error(
          'No Jira sites were authorized. Check the selected account, app scopes, and your organization’s app-access policy.',
        );
      this.grants.push({
        id: grantId,
        brokerUrl: origin,
        tokens: credentials,
        connections,
      });
      await this.save();
      return this.connections();
    }
    throw new Error(
      'Sign-in timed out. Try connecting again and finish authorization in your browser.',
    );
  }
  async disconnect(id: string) {
    for (const grant of this.grants)
      grant.connections = grant.connections.filter((c) => c.id !== id);
    this.grants = this.grants.filter((g) => g.connections.length);
    this.accounts = this.accounts.filter((a) => a.connection.id !== id);
    await this.save();
  }
  async request(
    connectionId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<any> {
    const grant = this.grants.find((g) =>
      g.connections.some((c) => c.id === connectionId),
    );
    const account = this.accounts.find((a) => a.connection.id === connectionId);
    if (!grant && !account)
      throw new Error(
        'This Jira connection is unavailable. Connect the site again.',
      );
    if (!/^\/rest\/(api\/3|agile\/1\.0)\//.test(path) || path.includes('..'))
      throw new Error('Invalid Jira API path.');
    if (grant && grant.tokens.expiresAt < Date.now() + 60_000)
      await this.refresh(grant);
    const base =
      account?.apiBase ??
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(connectionId.slice(grant!.id.length + 1))}`;
    const send = () =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: account
            ? `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`
            : `Bearer ${grant!.tokens.accessToken}`,
        },
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    let response = await send();
    if (response.status === 401 && grant) {
      await this.refresh(grant);
      response = await send();
    }
    if (!response.ok) {
      let details = '';
      try {
        const body = await response.json();
        details = [
          ...(body.errorMessages ?? []),
          ...Object.values(body.errors ?? {}),
        ].join(' ');
      } catch {}
      if (response.status === 403)
        throw new Error(
          `Jira denied access. Check issue permissions and your organization’s app-access policy. ${details}`,
        );
      if (response.status === 401)
        throw new Error(
          'Jira authorization expired or was revoked. Reconnect this site.',
        );
      if (response.status === 429)
        throw new Error(
          `Jira rate limit reached. Try again after ${response.headers.get('Retry-After') || 'a short wait'} seconds.`,
        );
      throw new Error(
        `Jira returned ${response.status}. ${details || 'The issue may be unavailable or this action may not be supported.'}`,
      );
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  private async refresh(grant: Grant) {
    if (!this.refreshing.has(grant.id)) {
      const task = (async () => {
        const response = await fetch(
          `${brokerOrigin(grant.brokerUrl)}/refresh`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: grant.tokens.refreshToken }),
            signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          },
        );
        grant.tokens = tokens(await json(response));
        await this.save();
      })().finally(() => this.refreshing.delete(grant.id));
      this.refreshing.set(grant.id, task);
    }
    await this.refreshing.get(grant.id);
  }
}
