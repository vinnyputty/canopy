import fs from 'node:fs/promises';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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

test('diagnostics replace existing bytes with private permissions and remove staging files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'report.json');
  await writeFile(file, 'old report');
  if (process.platform !== 'win32') await chmod(file, 0o644);
  const reviewed = '{"format":"canopy-support-v1"}\n';
  assert.equal(
    await exportDiagnosticReport(reviewed, reviewed, async () => file),
    true,
  );
  assert.equal(await readFile(file, 'utf8'), reviewed);
  if (process.platform !== 'win32')
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['report.json']);
});

test('a partially written diagnostics export preserves the chosen file and removes private staging', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'report.json');
  await writeFile(file, 'saved report');
  const failure = Object.assign(new Error('fixture write failure'), {
    code: 'ENOSPC',
  });
  const originalWrite = fs.writeFile;
  const fault = t.mock.method(
    fs,
    'writeFile',
    async (...[path, contents, options]: Parameters<typeof fs.writeFile>) => {
      await originalWrite(path, String(contents).slice(0, 3), options);
      assert.equal(await readFile(file, 'utf8'), 'saved report');
      if (process.platform !== 'win32') {
        assert.equal((await stat(String(path))).mode & 0o777, 0o600);
        assert.equal(
          (await stat(join(String(path), '..'))).mode & 0o777,
          0o700,
        );
      }
      throw failure;
    },
  );
  try {
    await assert.rejects(
      exportDiagnosticReport(
        'reviewed report',
        'reviewed report',
        async () => file,
      ),
      (error) => error === failure,
    );
  } finally {
    fault.mock.restore();
  }
  assert.equal(await readFile(file, 'utf8'), 'saved report');
  assert.deepEqual(await readdir(directory), ['report.json']);
});

test('a filesystem replacement failure preserves the chosen destination and removes staging', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'existing-directory');
  await mkdir(destination);
  const saved = join(destination, 'saved.json');
  await writeFile(saved, 'saved report');
  await assert.rejects(
    exportDiagnosticReport(
      'reviewed report',
      'reviewed report',
      async () => destination,
    ),
    (error: NodeJS.ErrnoException) =>
      ['EISDIR', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code ?? ''),
  );
  assert.equal(await readFile(saved, 'utf8'), 'saved report');
  assert.deepEqual(await readdir(directory), ['existing-directory']);
});

test(
  'a filesystem write permission failure preserves the chosen file and removes staging',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'canopy-diagnostics-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'report.json');
    await writeFile(file, 'saved report');
    const originalMkdtemp = fs.mkdtemp;
    const fault = t.mock.method(
      fs,
      'mkdtemp',
      async (prefix: Parameters<typeof fs.mkdtemp>[0]) => {
        const staging = await originalMkdtemp(prefix);
        await chmod(staging, 0o500);
        return staging;
      },
    );
    try {
      await assert.rejects(
        exportDiagnosticReport(
          'reviewed report',
          'reviewed report',
          async () => file,
        ),
        { code: 'EACCES' },
      );
    } finally {
      fault.mock.restore();
    }
    assert.equal(await readFile(file, 'utf8'), 'saved report');
    assert.deepEqual(await readdir(directory), ['report.json']);
  },
);
