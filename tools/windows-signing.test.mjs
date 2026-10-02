import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  signingConfig,
  validateSignature,
  validateWindowsReport,
  verifyWindowsInstaller,
} from './windows-signing.mjs';

const identity = {
  subject: 'CN=Fixture publisher',
  thumbprint: 'A'.repeat(40),
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signature = (bytes) => ({
  status: 'Valid',
  ...identity,
  timestamp: true,
  notBefore: '2020-01-01T00:00:00Z',
  notAfter: '2099-01-01T00:00:00Z',
  sha256: digest(bytes),
});
const env = {
  CANOPY_WINDOWS_SIGN: '1',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/tags/v0.1.0',
  CANOPY_WINDOWS_PFX: 'synthetic',
  CANOPY_WINDOWS_PFX_PASSWORD: 'synthetic',
  CANOPY_WINDOWS_SUBJECT: identity.subject,
  CANOPY_WINDOWS_THUMBPRINT: identity.thumbprint,
  CANOPY_SIGNTOOL: 'fixture',
};
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
    { thumbprint: 'B'.repeat(40) },
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
      ...identity,
      installer: valid,
    },
  ])
    assert.throws(() => validateWindowsReport(report, digest(bytes)));
});
test('embedded executable verification and extraction failures remove only the owned temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-signing-fixture-'));
  const previous = {
    subject: process.env.CANOPY_WINDOWS_SUBJECT,
    thumbprint: process.env.CANOPY_WINDOWS_THUMBPRINT,
  };
  process.env.CANOPY_WINDOWS_SUBJECT = identity.subject;
  process.env.CANOPY_WINDOWS_THUMBPRINT = identity.thumbprint;
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
    if (previous.subject === undefined)
      delete process.env.CANOPY_WINDOWS_SUBJECT;
    else process.env.CANOPY_WINDOWS_SUBJECT = previous.subject;
    if (previous.thumbprint === undefined)
      delete process.env.CANOPY_WINDOWS_THUMBPRINT;
    else process.env.CANOPY_WINDOWS_THUMBPRINT = previous.thumbprint;
    await rm(root, { recursive: true, force: true });
  }
});
