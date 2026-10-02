import { spawnSync } from 'node:child_process';
import './windows-lifecycle.test.mjs';
import * as requireFs from 'node:fs';
import {
  fixturePolicy,
  fixtureEnv,
  fixtureSignature,
} from './windows-signing-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  signingConfig,
  signingSource,
  command,
  signWithService,
  servicePolicy,
  authenticode,
  validateSignature,
  validateWindowsReport,
  verifyWindowsInstaller,
} from './windows-signing.mjs';

const identity = fixturePolicy;
const env = fixtureEnv;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signature = (bytes) => fixtureSignature(digest(bytes));
test('signing rejects PRs, non-tags, mismatched versions and incomplete credentials', () => {
  assert.deepEqual(
    signingConfig({}, 'win32', '0.1.0', () => {}),
    {},
  );
  for (const key of Object.keys(env)) {
    if (key === 'CANOPY_WINDOWS_SIGN') continue;
    assert.throws(
      () => signingConfig({ ...env, [key]: '' }, 'win32', '0.1.0', () => {}),
      key,
    );
  }
  for (const patch of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/v0.1.0' },
    { GITHUB_REF: 'refs/tags/v0.2.0' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
  ])
    assert.throws(() =>
      signingConfig({ ...env, ...patch }, 'win32', '0.1.0', () => {}),
    );
  assert.throws(() => signingConfig(env, 'darwin', '0.1.0', () => {}));
  assert.equal(
    signingConfig(env, 'win32', '0.1.0', () => {}).forceCodeSigning,
    true,
  );
});
test('unsigned, expired, altered, wrong publisher and missing timestamp evidence fails closed', () => {
  const bytes = 'signed fixture';
  const valid = signature(bytes);
  validateSignature(valid, digest(bytes), identity);
  for (const patch of [
    { status: 'NotSigned' },
    { status: 'NotTrusted' },
    { status: 'HashMismatch' },
    { status: 'UnknownError' },
    { subject: 'CN=Someone else' },
    { thumbprint: 'invalid' },
    { rootSha256: 'B'.repeat(64) },
    { timestampRootSha256: 'B'.repeat(64) },
    { timestampThumbprint: 'invalid' },
    { timestampNotAfter: '2020-01-01T00:00:00Z' },
    { ekus: ['1.3.6.1.5.5.7.3.3', identity.profileEku] },
    { ekus: valid.ekus.join(',') },
    { ekus: valid.ekus.filter((eku) => eku !== identity.profileEku) },
    { revocation: 'offline' },
    { verifiedAt: '2099-01-01T00:00:00Z' },
    { timestamp: false },
    { notAfter: '2020-01-01T00:00:00Z' },
    { notBefore: '2099-01-01T00:00:00Z' },
    { notAfter: 'invalid' },
    { sha256: digest('altered') },
  ])
    assert.throws(() =>
      validateSignature({ ...valid, ...patch }, digest(bytes), identity),
    );
  for (const report of [
    undefined,
    {},
    { policy: 'unsigned' },
    {
      policy: 'Authenticode signed and timestamped',
      service: identity,
      installer: valid,
    },
  ])
    assert.throws(() => validateWindowsReport(report, digest(bytes)));
});
test('embedded executable verification and extraction failures remove only the owned temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-signing-fixture-'));
  const previous = process.env.CANOPY_WINDOWS_POLICY;
  process.env.CANOPY_WINDOWS_POLICY = JSON.stringify(identity);
  try {
    const installer = join(root, 'fixture.exe');
    await writeFile(installer, 'installer');
    for (const failure of [
      'extract',
      'executable',
      'report',
      'alteration',
      null,
    ]) {
      await writeFile(installer, 'installer');
      let owned;
      let calls = 0;
      const inspect = (path) => {
        if (path === installer) return signature('installer');
        if (failure === 'executable') throw new Error('expired signature');
        return signature('executable');
      };
      // The production driver uses synchronous tools. Prepare the mock payload synchronously.
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const extract = (command, args) => {
        assert.equal(command, '7z');
        const output = args[2].slice(2);
        if (calls++ === 0) {
          owned = output;
          if (failure === 'extract') throw new Error('extract failed');
          mkdirSync(join(output, '$PLUGINSDIR'));
          writeFileSync(join(output, '$PLUGINSDIR', 'app-64.7z'), 'archive');
        } else {
          mkdirSync(output);
          writeFileSync(join(output, 'Canopy.exe'), 'executable');
          if (failure === 'alteration')
            writeFileSync(installer, 'changed during extraction');
        }
      };
      const action = verifyWindowsInstaller(
        installer,
        failure === 'report' ? {} : undefined,
        inspect,
        extract,
      );
      if (failure) await assert.rejects(action);
      else assert.equal((await action).executable.sha256, digest('executable'));
      await assert.rejects(readFile(join(owned, 'app', 'Canopy.exe')), {
        code: 'ENOENT',
      });
      assert.equal(
        await readFile(installer, 'utf8'),
        failure === 'alteration' ? 'changed during extraction' : 'installer',
      );
    }
  } finally {
    if (previous === undefined) delete process.env.CANOPY_WINDOWS_POLICY;
    else process.env.CANOPY_WINDOWS_POLICY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('historical trusted timestamp survives leaf expiry and service leaf rotation', () => {
  const historical = {
    ...signature('fixture'),
    notAfter: '2022-01-01T00:00:00Z',
    verifiedAt: '2021-01-01T00:00:00Z',
  };
  validateSignature(historical, digest('fixture'), identity);
  validateSignature(
    { ...historical, thumbprint: 'B'.repeat(40) },
    digest('fixture'),
    identity,
  );
  validateWindowsReport(
    {
      policy: 'Authenticode signed and timestamped',
      service: identity,
      installer: historical,
      executable: { ...historical, thumbprint: 'B'.repeat(40) },
    },
    digest('fixture'),
  );
});
test('wrong service, endpoint, private/test profile, auth method and credential selection fail closed', () => {
  for (const patch of [
    { endpoint: 'http://eus.codesigning.azure.net' },
    { endpoint: 'https://eus.codesigning.azure.net.evil' },
    { endpoint: 'https://eus.codesigning.azure.net/path' },
    { account: '../account' },
    { profile: 'profile;bad' },
    { profileType: 'PublicTrustTest' },
    { profileType: 'PrivateTrust' },
    { auth: 'AzureCliCredential' },
    { profileEku: '1.3.6.1.4.1.311.97.1.3.1.1.2.3.4' },
    { service: 'Other service' },
    { clientSecret: 'forbidden-in-public-policy' },
  ])
    assert.throws(() =>
      servicePolicy({
        ...env,
        CANOPY_WINDOWS_POLICY: JSON.stringify({ ...identity, ...patch }),
      }),
    );
  for (const patch of [
    { GITHUB_REPOSITORY: 'attacker/canopy' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    {
      GITHUB_WORKFLOW_REF:
        'vinnyputty/canopy/.github/workflows/ci.yml@refs/heads/main',
    },
    { AZURE_CLIENT_ID: 'c'.repeat(36) },
    { AZURE_CLIENT_CERTIFICATE_PATH: 'private.pfx' },
    { AZURE_AUTHORITY_HOST: 'https://evil/' },
    { AZURE_USERNAME: 'interactive' },
  ])
    assert.throws(() =>
      signingConfig({ ...env, ...patch }, 'win32', '0.1.0', () => {}),
    );
});
test('actual cloud adapter emits SDK metadata and SHA256 RFC3161 command, cleans on signing and verification failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-cloud-fixture-'));
  const file = join(root, 'app.exe');
  await writeFile(file, 'fixture');
  try {
    for (const failure of ['sign', 'verify', null]) {
      let metadataPath, child;
      const run = (request, childEnv) => {
        child = childEnv;
        metadataPath = request.args[request.args.indexOf('/dmdf') + 1];
        assert.equal(request.operation, 'run');
        assert.equal(request.timeoutMs, 90000);
        assert.deepEqual(request.args.slice(0, 7), [
          'sign',
          '/fd',
          'SHA256',
          '/tr',
          'http://timestamp.acs.microsoft.com',
          '/td',
          'SHA256',
        ]);
        assert.equal(request.file, env.CANOPY_SIGNTOOL);
        assert.equal(
          request.args[request.args.indexOf('/dlib') + 1],
          env.CANOPY_SIGN_DLIB,
        );
        assert.ok(!JSON.stringify(request).includes(env.AZURE_CLIENT_SECRET));
        const { readFileSync } = requireFs;
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        assert.equal(metadata.Endpoint, identity.endpoint);
        assert.equal(metadata.CertificateProfileName, identity.profile);
        assert.equal(metadata.CodeSigningAccountName, identity.account);
        assert.ok(metadata.ExcludeCredentials.includes('AzureCliCredential'));
        assert.ok(!JSON.stringify(metadata).includes(env.AZURE_CLIENT_SECRET));
        if (failure === 'sign') throw new Error('mock signing failure');
        return { ok: true, ownedAbsent: true };
      };
      const action = signWithService(file, '0.1.0', {
        env,
        platform: 'win32',
        source: () => {},
        run,
        inspect: () => {
          if (failure === 'verify')
            throw new Error('mock verification failure');
          return signature('fixture');
        },
      });
      if (failure) await assert.rejects(action, /mock|Cloud/);
      else await action;
      await assert.rejects(readFile(metadataPath), { code: 'ENOENT' });
      assert.equal(child.AZURE_CLIENT_SECRET, undefined);
      assert.equal(await readFile(file, 'utf8'), 'fixture');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('native trust adapter passes no credentials or in-process private keys to its bounded verifier', () => {
  const saved = process.env.AZURE_CLIENT_SECRET;
  process.env.AZURE_CLIENT_SECRET = 'synthetic-hidden';
  try {
    const result = authenticode(
      '/fixture.exe',
      'verify',
      (tool, args, child) => {
        assert.equal(tool, 'pwsh');
        assert.ok(args.some((x) => x.endsWith('windows-native.ps1')));
        assert.equal(child.AZURE_CLIENT_SECRET, undefined);
        assert.ok(!JSON.stringify(args).includes('synthetic-hidden'));
        assert.equal(
          JSON.parse(child.CANOPY_NATIVE_REQUEST).operation,
          'verify',
        );
        return JSON.stringify(signature('fixture'));
      },
      'win32',
    );
    assert.equal(result.status, 'Valid');
  } finally {
    if (saved === undefined) delete process.env.AZURE_CLIENT_SECRET;
    else process.env.AZURE_CLIENT_SECRET = saved;
  }
});

test('source guard binds clean checked-out HEAD, tag commit and tagged package version in owned temp Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-sign-source-'));
  const safeEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const git = (args) => {
    const result = spawnSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'core.hooksPath=' + safeEnv.GIT_CONFIG_GLOBAL,
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { env: safeEnv, encoding: 'utf8', timeout: 10000 },
    );
    if (result.status !== 0) throw new Error('owned Git fixture failed');
    return result.stdout;
  };
  try {
    git(['init', '-q']);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '0.1.0' }),
    );
    git(['add', 'package.json']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    ]);
    git(['tag', 'v0.1.0']);
    const sha = git(['rev-parse', 'HEAD']).trim();
    assert.equal(
      signingSource({ ...env, GITHUB_SHA: sha }, '0.1.0', git).commit,
      sha,
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '0.2.0' }),
    );
    assert.throws(
      () => signingSource({ ...env, GITHUB_SHA: sha }, '0.1.0', git),
      /source differ/,
    );
    git(['add', 'package.json']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture-next',
    ]);
    assert.throws(
      () => signingSource({ ...env, GITHUB_SHA: sha }, '0.1.0', git),
      /source differ/,
    );
    assert.throws(
      () =>
        signingSource(
          { ...env, GITHUB_SHA: git(['rev-parse', 'HEAD']).trim() },
          '0.1.0',
          git,
        ),
      /source differ/,
    );
    assert.throws(
      () => signingSource({ ...env, GITHUB_SHA: sha }, '0.2.0', git),
      /owned Git/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('bounded helper deadline rejects timeout, signals and failure without native output or credentials', () => {
  for (const result of [
    { error: new Error('native-sensitive-detail') },
    { status: 17, stdout: 'secret', stderr: 'secret' },
    { status: null, signal: 'SIGTERM' },
  ])
    assert.throws(
      () =>
        command(
          'pwsh',
          ['-File', 'fixture'],
          { AZURE_CLIENT_SECRET: 'synthetic' },
          (_tool, _args, options) => {
            assert.equal(options.timeout, 120000);
            assert.equal(options.windowsHide, true);
            assert.equal(options.encoding, 'utf8');
            return result;
          },
        ),
      (error) =>
        !error.message.includes('secret') &&
        !error.message.includes('sensitive') &&
        /bounded tool/.test(error.message),
    );
});
