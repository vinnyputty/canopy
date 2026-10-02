import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { get } from 'node:https';
import { it } from 'node:test';
import {
  compatibleAsset,
  compareVersions,
  eligibleReleases,
  parseVersion,
  releaseTransport,
  releaseUrl,
  RELEASE_API,
  ReleaseRequestError,
} from '../src/main/releases';

import { release } from './fixtures/releases';
it('orders SemVer including numeric prerelease identifiers and ignores build metadata', () => {
  const ordered = [
    '0.1.0-alpha',
    '0.1.0-alpha.2',
    '0.1.0-alpha.10',
    '0.1.0-beta',
    '0.1.0-rc.1',
    '0.1.0',
    '0.2.0',
    '1.0.0',
  ];
  for (let i = 1; i < ordered.length; i++)
    assert.equal(
      compareVersions(parseVersion(ordered[i - 1])!, parseVersion(ordered[i])!),
      -1,
    );
  assert.equal(
    compareVersions(parseVersion('1.0.0+one')!, parseVersion('1.0.0+two')!),
    0,
  );
  for (const invalid of [
    'v1.0.0',
    '1.0',
    '01.0.0',
    '1.0.0-01',
    '1.0.0-',
    '1.0.0+',
    'dev',
    '1.0.0/evil',
    '1.0.0\n',
    '1.0.0\r\n',
  ])
    assert.equal(parseVersion(invalid), null);
  assert.ok(parseVersion('999999999999999999999999.0.0'));
});
it('requires explicit matching OS/CPU/version installer names', () => {
  for (const [os, arch, suffix] of [
    ['darwin', 'arm64', 'mac-arm64.dmg'],
    ['darwin', 'x64', 'mac-x64.zip'],
    ['win32', 'x64', 'win-x64.exe'],
    ['win32', 'arm64', 'win-arm64.exe'],
    ['linux', 'x64', 'linux-x86_64.AppImage'],
    ['linux', 'x64', 'linux-amd64.deb'],
    ['linux', 'arm64', 'linux-arm64.deb'],
  ]) {
    assert.equal(
      compatibleAsset(`Canopy-1.0.0-${suffix}`, '1.0.0', os, arch),
      true,
    );
    assert.equal(
      compatibleAsset(`Canopy-0.9.0-${suffix}`, '1.0.0', os, arch),
      false,
    );
  }
  for (const name of [
    'Canopy-1.0.0-arm64.dmg',
    'Canopy-1.0.0.dmg',
    'Canopy-1.0.0-mac-x64.dmg',
    'Canopy-1.0.0-win-arm64.exe',
    'Canopy-1.0.0-linux-amd64.deb',
    'SHA256SUMS',
    'source.zip',
  ])
    assert.equal(compatibleAsset(name, '1.0.0', 'darwin', 'arm64'), false);
  assert.equal(
    compatibleAsset('Canopy-1.0.0-mac-arm64.dmg', '1.0.0', 'darwin', 'riscv64'),
    false,
  );
});
it('selects by semantic version and channel with strict publication/asset/link validation', () => {
  const rc = release('0.3.0-rc.1');
  const flagged = { ...release('0.4.0'), prerelease: true };
  const rows = [release('0.1.0'), release('0.2.0'), rc, flagged];
  assert.equal(
    eligibleReleases(rows, 'darwin', 'arm64', false)[0].version,
    '0.2.0',
  );
  assert.equal(
    eligibleReleases(rows, 'darwin', 'arm64', true)[0].version,
    '0.4.0',
  );
  for (const row of [
    { ...release(), draft: true },
    { ...release(), published_at: null },
    { ...release(), published_at: 'bad' },
    { ...release(), tag_name: 'garbage' },
    {
      ...release(),
      html_url: 'https://github.com/evil/canopy/releases/tag/v0.2.0',
    },
    { ...release(), html_url: 'https://github.com@evil.test/v0.2.0' },
    { ...release(), html_url: `${releaseUrl('v0.2.0')}#evil` },
    release('0.2.0', 'mac-x64.dmg'),
    { ...release(), assets: [] },
    { ...release(), assets: [{ ...release().assets[0], state: 'new' }] },
    { ...release(), assets: [{ ...release().assets[0], size: 0 }] },
    {
      ...release(),
      assets: [
        {
          ...release().assets[0],
          browser_download_url: 'https://evil.test/download',
        },
      ],
    },
  ])
    assert.deepEqual(eligibleReleases([row], 'darwin', 'arm64', true), []);
  assert.throws(() => releaseUrl('v1.0.0/../../evil'));
});

function mockRequest(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  hold = false,
) {
  const calls: { url: string; options: any; timeout?: number }[] = [];
  let timeout: (() => void) | undefined;
  let req: EventEmitter & {
    destroy: (error: Error) => void;
    setTimeout: (ms: number, callback: () => void) => void;
  };
  const request = ((
    url: string,
    options: any,
    callback: (res: any) => void,
  ) => {
    const call = { url, options, timeout: undefined as number | undefined };
    calls.push(call);
    req = Object.assign(new EventEmitter(), {
      destroy(error: Error) {
        req.emit('error', error);
      },
      setTimeout(ms: number, fn: () => void) {
        call.timeout = ms;
        timeout = fn;
      },
    });
    options.signal.addEventListener(
      'abort',
      () => req.destroy(new Error('aborted')),
      { once: true },
    );
    queueMicrotask(() => {
      if (hold) return;
      const res = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers,
        destroy() {},
      });
      callback(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return req;
  }) as unknown as typeof get;
  return {
    transport: releaseTransport(request, () => 1_000_000),
    calls,
    timeout: () => timeout?.(),
  };
}
it('production transport uses only public canonical GET with finite timeout and no credentials', async () => {
  const mock = mockRequest(200, JSON.stringify([release()]));
  const result = await mock.transport(1, new AbortController().signal);
  assert.equal(result.rows.length, 1);
  assert.equal(result.more, false);
  assert.equal(mock.calls[0].url, `${RELEASE_API}?per_page=30&page=1`);
  assert.deepEqual(Object.keys(mock.calls[0].options).sort(), [
    'headers',
    'signal',
  ]);
  assert.deepEqual(mock.calls[0].options.headers, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Canopy-release-discovery',
    'X-GitHub-Api-Version': '2026-03-10',
  });
  assert.equal(mock.calls[0].timeout, 10_000);
  await assert.rejects(mock.transport(4, new AbortController().signal));
  assert.equal(mock.calls.length, 1);
});
it('production transport rejects redirects, malformed/oversize responses, offline errors and aborts', async () => {
  for (const [status, body] of [
    [302, '[]'],
    [500, '[]'],
    [200, '{}'],
    [200, 'bad'],
    [200, 'x'.repeat(2 * 1024 * 1024 + 1)],
    [200, JSON.stringify(Array(31).fill(release()))],
  ] as const) {
    await assert.rejects(
      mockRequest(status, body).transport(1, new AbortController().signal),
    );
  }
  const abort = mockRequest(200, '[]', {}, true),
    controller = new AbortController();
  const promise = abort.transport(1, controller.signal);
  controller.abort();
  await assert.rejects(promise, /aborted/);
  const stalled = mockRequest(200, '[]', {}, true);
  const pending = stalled.transport(1, new AbortController().signal);
  stalled.timeout();
  await assert.rejects(pending, /timed out/);
});
it('production transport honors primary reset, secondary retry-after and fallback backoff', async () => {
  for (const [status, headers, at] of [
    [429, { 'retry-after': '120' }, 1_120_000],
    [
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1200' },
      1_200_000,
    ],
    [403, {}, 1_060_000],
  ] as [number, Record<string, string>, number][]) {
    await assert.rejects(
      mockRequest(status, '{}', headers).transport(
        1,
        new AbortController().signal,
      ),
      (e: unknown) => e instanceof ReleaseRequestError && e.retryAt === at,
    );
  }
});
