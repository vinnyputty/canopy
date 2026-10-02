import { get } from 'node:https';
import type { AvailableRelease } from '../shared/updates';

export const RELEASE_ORIGIN = 'https://github.com/vinnyputty/canopy/releases';
export const RELEASE_API =
  'https://api.github.com/repos/vinnyputty/canopy/releases';
const MAX_BODY = 2 * 1024 * 1024;
export const PAGE_SIZE = 30;
export const MAX_PAGES = 3;

type Version = { core: bigint[]; pre: string[]; text: string };
export function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match || match[0] !== value) return null;
  const pre = match[4]?.split('.') ?? [];
  if (
    pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')
  )
    return null;
  return { core: match.slice(1, 4).map(BigInt), pre, text: value };
}
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++)
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function releaseUrl(tag: unknown): string {
  if (typeof tag !== 'string' || !parseVersion(tag.replace(/^v/, '')))
    throw new Error('Invalid release tag.');
  return `${RELEASE_ORIGIN}/tag/${encodeURIComponent(tag)}`;
}
// Only explicit OS/CPU filenames establish compatibility. Ambiguous builder
// defaults, source archives, checksums and other CPUs do not qualify.
export function compatibleAsset(
  name: string,
  version: string,
  platform: string,
  arch: string,
): boolean {
  const prefixes: Record<string, string[]> = {
    'darwin:arm64': ['mac-arm64.dmg', 'mac-arm64.zip'],
    'darwin:x64': ['mac-x64.dmg', 'mac-x64.zip'],
    'win32:x64': ['win-x64.exe'],
    'win32:arm64': ['win-arm64.exe'],
    'linux:x64': ['linux-x86_64.AppImage', 'linux-amd64.deb'],
    'linux:arm64': ['linux-arm64.AppImage', 'linux-arm64.deb'],
  };
  return (prefixes[`${platform}:${arch}`] ?? []).some(
    (suffix) => name === `Canopy-${version}-${suffix}`,
  );
}
export function eligibleReleases(
  rows: unknown[],
  platform: string,
  arch: string,
  prereleases: boolean,
): AvailableRelease[] {
  const releases: AvailableRelease[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (
      row.draft !== false ||
      typeof row.prerelease !== 'boolean' ||
      typeof row.published_at !== 'string' ||
      !Number.isFinite(Date.parse(row.published_at)) ||
      typeof row.tag_name !== 'string'
    )
      continue;
    const version = row.tag_name.replace(/^v/, '');
    const parsed = parseVersion(version);
    if (!parsed || (!prereleases && (row.prerelease || parsed.pre.length)))
      continue;
    // Do not accept alternate origins, repositories, credentials or fragments.
    if (
      row.html_url !== releaseUrl(row.tag_name) ||
      !Array.isArray(row.assets) ||
      row.assets.length > 100
    )
      continue;
    const assets = row.assets
      .filter((asset) => {
        if (!asset || typeof asset !== 'object') return false;
        const a = asset as Record<string, unknown>;
        return (
          typeof a.name === 'string' &&
          compatibleAsset(a.name, version, platform, arch) &&
          a.state === 'uploaded' &&
          typeof a.size === 'number' &&
          a.size > 0 &&
          Number.isSafeInteger(a.size) &&
          a.browser_download_url ===
            `${RELEASE_ORIGIN}/download/${encodeURIComponent(row.tag_name as string)}/${encodeURIComponent(a.name)}`
        );
      })
      .map((a) => a.name as string);
    if (!assets.length) continue;
    releases.push({
      tag: row.tag_name,
      version,
      prerelease: row.prerelease || !!parsed.pre.length,
      notes:
        typeof row.body === 'string'
          ? row.body.slice(0, 20_000) +
            (row.body.length > 20_000
              ? '\n\n[Notes truncated. Read full notes on the official release page.]'
              : '')
          : '',
      assets,
    });
  }
  return releases.sort((a, b) =>
    compareVersions(parseVersion(b.version)!, parseVersion(a.version)!),
  );
}
export class ReleaseRequestError extends Error {
  constructor(
    message: string,
    public retryAt?: number,
  ) {
    super(message);
  }
}
export type ReleasePage = { rows: unknown[]; more: boolean };
export type ReleaseTransport = (
  page: number,
  signal: AbortSignal,
) => Promise<ReleasePage>;
// Node HTTPS uses no Electron browser session, cookies, issue provider or auth.
// Redirects are rejected; pagination never follows server-supplied URLs.
export function releaseTransport(
  request: typeof get = get,
  now = Date.now,
): ReleaseTransport {
  return (page, signal) =>
    new Promise((resolve, reject) => {
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES)
        return reject(new Error('Invalid release page.'));
      const req = request(
        `${RELEASE_API}?per_page=${PAGE_SIZE}&page=${page}`,
        {
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Canopy-release-discovery',
            'X-GitHub-Api-Version': '2026-03-10',
          },
        },
        (response) => {
          response.on('error', reject);
          const status = response.statusCode;
          if (status !== 200) {
            if (status === 403 || status === 429) {
              const retry = Number(response.headers['retry-after']);
              const reset = Number(response.headers['x-ratelimit-reset']);
              const retryAt = Math.max(
                now() + 60_000,
                Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : 0,
                response.headers['x-ratelimit-remaining'] === '0' &&
                  Number.isFinite(reset)
                  ? reset * 1000
                  : 0,
              );
              reject(
                new ReleaseRequestError(
                  'GitHub is limiting release checks. Try again after the retry time.',
                  retryAt,
                ),
              );
            } else
              reject(
                new ReleaseRequestError(
                  `GitHub release check failed (HTTP ${status ?? 'unknown'}).`,
                ),
              );
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY) {
              const error = new Error('Release response is too large.');
              reject(error);
              req.destroy(error);
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const rows: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              if (!Array.isArray(rows) || rows.length > PAGE_SIZE)
                throw new Error('Invalid release response.');
              resolve({ rows, more: rows.length === PAGE_SIZE });
            } catch {
              reject(
                new ReleaseRequestError(
                  'GitHub returned an invalid release response.',
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10_000, () =>
        req.destroy(new Error('Release check timed out.')),
      );
    });
}
