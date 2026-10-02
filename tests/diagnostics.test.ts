import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diagnosticReport,
  exportDiagnosticReport,
} from '../src/main/diagnostics';
import type { Connection } from '../src/shared/types';

test('support diagnostics allowlist excludes identities, secrets, issue content, and unknown fields', () => {
  const connection = {
    id: 'secret-id',
    name: 'private-name',
    accountName: 'private-account',
    url: 'https://private.atlassian.net',
    provider: 'github',
    repositories: ['private/repo'],
    token: 'fixture-token',
    error: 'private-error',
    issue: { summary: 'private-title', description: 'private-body' },
  } as Connection;
  const result = diagnosticReport({
    version: '0.1.0',
    platform: 'linux',
    demoMode: false,
    credentialStorage: 'unlock-failed',
    connections: [connection],
    retryAt: () => 123456,
  });
  assert.doesNotMatch(result, /secret-id|private-|private\/|fixture-token/);
  assert.deepEqual(JSON.parse(result).connections, [
    { provider: 'github', repositoryCount: 1, retryAt: 123456 },
  ]);
  assert.equal(JSON.parse(result).credentialStorage, 'unlock-failed');
});

test('diagnostics require a matching review and file selection; save exactly the reviewed snapshot', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'canopy-diagnostics-fixture-'),
  );
  const report = diagnosticReport({
    version: 'fixture',
    platform: 'linux',
    demoMode: false,
    credentialStorage: 'available',
    connections: [],
    retryAt: () => null,
  });
  let prompts = 0;
  const file = join(directory, 'report.json');
  const choose = async () => {
    prompts++;
    return file;
  };
  try {
    await assert.rejects(
      exportDiagnosticReport(report, undefined, choose),
      /Review a fresh/,
    );
    await assert.rejects(
      exportDiagnosticReport(report + 'private-content', report, choose),
      /Review a fresh/,
    );
    assert.equal(prompts, 0);
    assert.equal(
      await exportDiagnosticReport(report, report, async () => undefined),
      false,
    );
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await exportDiagnosticReport(report, report, choose), true);
    assert.equal(await readFile(file, 'utf8'), report);
    await assert.rejects(
      exportDiagnosticReport(report, report, async () =>
        join(directory, 'missing', 'report.json'),
      ),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
