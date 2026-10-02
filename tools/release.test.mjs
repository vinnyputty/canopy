import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assemble,
  assetNames,
  platforms,
  qualify,
  validateTag,
  verifyDownloads,
} from './release.mjs';

const version = '0.1.0';
const tag = `v${version}`;
const commit = 'a'.repeat(40);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'canopy-release-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  for (const row of platforms) {
    const directory = join(input, `Canopy-${row.artifact}`);
    await mkdir(directory);
    const checks = [];
    for (const name of assetNames(version, row)) {
      const bytes = Buffer.from(`mock package ${name}`);
      await writeFile(join(directory, name), bytes);
      checks.push({ artifact: name, sha256: digest(bytes) });
    }
    await writeFile(
      join(directory, 'release-checks.json'),
      JSON.stringify({
        platform: row.platform,
        arch: row.arch,
        version,
        commit,
        checks,
        nativeDesktopChecks: 'pending',
      }),
    );
  }
  try {
    await fn({ root, input, output });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const build = (input, output) =>
  assemble(
    input,
    output,
    tag,
    version,
    commit,
    'https://github.com/example/canopy/actions/runs/1',
  );
test('version tags match exactly and reject malformed or unsafe input', () => {
  for (const value of ['0.1.0', '1.2.3-rc.1'])
    assert.equal(validateTag(`v${value}`, value), value);
  for (const [badTag, badVersion] of [
    ['v0.2.0', version],
    ['0.1.0', version],
    ['v01.1.0', '01.1.0'],
    ['v1.2.3-01', '1.2.3-01'],
    ['v1.2.3+build', '1.2.3+build'],
    ['../v0.1.0', version],
  ])
    assert.throws(() => validateTag(badTag, badVersion));
});
test('complete matrix assembles deterministic hashes and verifies downloaded bytes', async () =>
  fixture(async ({ input, output, root }) => {
    const manifest = await build(input, output);
    assert.equal(manifest.assets.length, 5);
    assert.equal(manifest.nativeDesktopChecks, 'pending');
    assert.match(
      await readFile(join(output, 'release-notes.md'), 'utf8'),
      /Public release is blocked/,
    );
    await rm(join(output, 'release-notes.md'));
    assert.deepEqual(
      await verifyDownloads(output, tag, version, commit),
      manifest,
    );
    const other = join(root, 'other');
    await build(input, other);
    assert.equal(
      await readFile(join(output, 'SHA256SUMS'), 'utf8'),
      await readFile(join(other, 'SHA256SUMS'), 'utf8'),
    );
    await writeFile(join(output, manifest.assets[0].name), 'tampered upload');
    await assert.rejects(
      verifyDownloads(output, tag, version, commit),
      /Hash mismatch/,
    );
  }));
test('reject stale source, version, platform, CPU and duplicate report entries', async () => {
  for (const patch of [
    { commit: 'b'.repeat(40) },
    { version: '0.2.0' },
    { platform: 'linux' },
    { arch: 'x64' },
    { nativeDesktopChecks: 'passed' },
    { checks: [] },
  ]) {
    await fixture(async ({ input, output }) => {
      const path = join(input, 'Canopy-mac-arm64', 'release-checks.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...report, ...patch }));
      await assert.rejects(build(input, output));
    });
  }
  await fixture(async ({ input, output }) => {
    const path = join(input, 'Canopy-mac-arm64', 'release-checks.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.checks[1] = report.checks[0];
    await writeFile(path, JSON.stringify(report));
    await assert.rejects(build(input, output), /Unexpected asset set/);
  });
});
test('missing matrix row, missing package, extra builder output and corrupt package block drafts', async () => {
  for (const mutation of [
    async (input) => rm(join(input, 'Canopy-win-x64'), { recursive: true }),
    async (input) =>
      rm(join(input, 'Canopy-mac-arm64', 'Canopy-0.1.0-mac-arm64.dmg')),
    async (input) =>
      writeFile(join(input, 'Canopy-linux-x64', 'unverified.tar'), 'extra'),
    async (input) =>
      writeFile(
        join(input, 'Canopy-win-x64', 'Canopy-0.1.0-win-x64.exe'),
        'corrupt',
      ),
  ])
    await fixture(async ({ input, output }) => {
      await mutation(input);
      await assert.rejects(build(input, output));
    });
});
test('checksum changes and unexpected downloaded assets block publication', async () => {
  for (const mutation of [
    async (output) => writeFile(join(output, 'SHA256SUMS'), 'forged'),
    async (output) => writeFile(join(output, 'extra.exe'), 'extra'),
    async (output) => rm(join(output, 'Canopy-0.1.0-linux-amd64.deb')),
  ])
    await fixture(async ({ input, output }) => {
      await build(input, output);
      await rm(join(output, 'release-notes.md'));
      await mutation(output);
      await assert.rejects(verifyDownloads(output, tag, version, commit));
    });
});
test('publication requires exact-hash native evidence and macOS distribution trust', async () =>
  fixture(async ({ input, output, root }) => {
    const manifest = await build(input, output);
    const path = join(root, 'qualification.json');
    const evidence = {
      tag,
      commit,
      status: 'passed',
      evidenceUrl: 'https://example.test/qualification',
      assets: manifest.assets.map((asset) => ({
        ...asset,
        nativeChecks: 'passed',
        tester: 'test fixture',
        osBuild: 'mock desktop',
        date: '2026-10-02',
        evidenceUrl: 'https://example.test/result',
        signingPolicy: asset.name.includes('-mac-')
          ? 'Developer ID signed and notarized'
          : 'unsigned; trust prompts recorded',
      })),
    };
    await writeFile(path, JSON.stringify(evidence));
    await qualify(manifest, path);
    for (const patch of [
      { sha256: 'b'.repeat(64) },
      { nativeChecks: 'pending' },
      { signingPolicy: 'unsigned' },
      { tester: '' },
    ]) {
      const changed = structuredClone(evidence);
      Object.assign(changed.assets[0], patch);
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(qualify(manifest, path));
    }
  }));
