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
  publish,
  resolveTagSource,
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
    const evidence = qualification(manifest);
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

function qualification(manifest) {
  return {
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
}

async function publicationFixture(fn) {
  await fixture(async ({ root, input, output }) => {
    const manifest = await build(input, output);
    await rm(join(output, 'release-notes.md'));
    const evidence = join(root, 'qualification.json');
    const notes = join(root, 'public-notes.md');
    await writeFile(evidence, JSON.stringify(qualification(manifest)));
    await writeFile(notes, 'Qualified synthetic test release');
    await fn({ output, evidence, notes });
  });
}
const refEndpoint = `repos/{owner}/{repo}/git/ref/tags/${tag}`;
const annotatedSha = 'c'.repeat(40);
const remoteRef = (type, sha) => ({
  ref: `refs/tags/${tag}`,
  object: { type, sha },
});
const tagEndpoint = `repos/{owner}/{repo}/git/tags/${annotatedSha}`;
function mockGh(responses, calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'release') {
      assert.equal(
        responses.length,
        0,
        'publication must follow every remote identity check',
      );
      return '';
    }
    const response = responses.shift();
    assert.ok(response, 'unexpected remote query');
    assert.deepEqual(args, ['api', response.endpoint]);
    if (response.error) throw response.error;
    return JSON.stringify(response.body);
  };
}
test('publication resolves live lightweight and annotated tags to the qualified commit before editing', async () => {
  for (const annotated of [false, true])
    await publicationFixture(async ({ output, evidence, notes }) => {
      const ref = remoteRef(
        annotated ? 'tag' : 'commit',
        annotated ? annotatedSha : commit,
      );
      const responses = [{ endpoint: refEndpoint, body: ref }];
      if (annotated)
        responses.push(
          {
            endpoint: tagEndpoint,
            body: { object: { type: 'commit', sha: commit } },
          },
          { endpoint: refEndpoint, body: ref },
        );
      const calls = [];
      await publish(
        output,
        tag,
        version,
        commit,
        evidence,
        notes,
        mockGh(responses, calls),
      );
      assert.deepEqual(calls.at(-1), [
        'release',
        'edit',
        tag,
        '--tag',
        tag,
        '--notes-file',
        notes,
        '--draft=false',
        '--verify-tag',
      ]);
      assert.equal(calls.length, annotated ? 4 : 2);
    });
});
test('deleted or moved remote tags block publication despite a matching checkout and qualified manifest', async () => {
  const missing = {
    endpoint: refEndpoint,
    error: new Error('HTTP 404: tag deleted'),
  };
  const annotated = {
    endpoint: refEndpoint,
    body: remoteRef('tag', annotatedSha),
  };
  const peeled = {
    endpoint: tagEndpoint,
    body: { object: { type: 'commit', sha: commit } },
  };
  const moved = {
    endpoint: refEndpoint,
    body: remoteRef('commit', 'b'.repeat(40)),
  };
  for (const responses of [
    [missing], // Lightweight or annotated ref removed after checkout.
    [moved],
    [
      annotated,
      {
        endpoint: tagEndpoint,
        body: { object: { type: 'commit', sha: 'b'.repeat(40) } },
      },
    ],
    [annotated, peeled, missing], // Ref disappears while peeling its immutable object.
    [annotated, peeled, moved],
    [
      annotated,
      peeled,
      { endpoint: refEndpoint, body: remoteRef('tag', 'd'.repeat(40)) },
    ],
  ])
    await publicationFixture(async ({ output, evidence, notes }) => {
      const calls = [];
      await assert.rejects(
        publish(
          output,
          tag,
          version,
          commit,
          evidence,
          notes,
          mockGh([...responses], calls),
        ),
        /tag deleted|Remote tag/,
      );
      assert.ok(
        calls.every((args) => args[0] === 'api'),
        'failed identity checks must never edit a release',
      );
    });
});
test('publication fails before remote calls for corrupt artifacts or pending native evidence', async () => {
  for (const corrupt of [true, false])
    await publicationFixture(async ({ output, evidence, notes }) => {
      if (corrupt)
        await writeFile(join(output, 'Canopy-0.1.0-win-x64.exe'), 'changed');
      else {
        const pending = JSON.parse(await readFile(evidence, 'utf8'));
        pending.status = 'pending';
        await writeFile(evidence, JSON.stringify(pending));
      }
      const calls = [];
      await assert.rejects(
        publish(
          output,
          tag,
          version,
          commit,
          evidence,
          notes,
          mockGh([], calls),
        ),
      );
      assert.equal(calls.length, 0);
    });
});
test('publishing workflow invokes the guarded publication entry point', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/publish.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /node tools\/release\.mjs publish downloaded "\$RELEASE_TAG" "\$version" "\$source_sha" "release-qualification\/\$RELEASE_TAG\.json" "release-qualification\/\$RELEASE_TAG\.md"/,
  );
  assert.match(
    workflow,
    /source=\$\(node tools\/release\.mjs tag-source "\$RELEASE_TAG"\)\s+read -r source_sha version <<< "\$source"/,
  );
  assert.doesNotMatch(
    workflow,
    /require\("\.\/package\.json"\)|gh release edit/,
  );
});

test('an older qualified release uses its tagged version after the dispatch branch version advances', async () =>
  publicationFixture(async ({ output, evidence, notes }) => {
    const dispatch = await mkdtemp(join(tmpdir(), 'canopy-release-dispatch-'));
    const previous = process.cwd();
    const calls = [];
    try {
      await writeFile(
        join(dispatch, 'package.json'),
        JSON.stringify({ version: '0.2.0' }),
      );
      process.chdir(dispatch);
      const source = resolveTagSource(tag, (args) => {
        calls.push(args);
        if (args[0] === 'rev-parse') return `${commit}\n`;
        assert.deepEqual(args, ['show', `${commit}:package.json`]);
        return JSON.stringify({ version });
      });
      assert.deepEqual(source, { commit, version });
      assert.deepEqual(calls[0], [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/tags/${tag}^{commit}`,
      ]);
      const remoteCalls = [];
      await publish(
        output,
        tag,
        source.version,
        source.commit,
        evidence,
        notes,
        mockGh(
          [{ endpoint: refEndpoint, body: remoteRef('commit', commit) }],
          remoteCalls,
        ),
      );
      assert.equal(remoteCalls.at(-1)[0], 'release');
    } finally {
      process.chdir(previous);
      await rm(dispatch, { recursive: true, force: true });
    }
  }));
test('tag resolution rejects unsafe syntax before invoking Git', () => {
  for (const unsafe of [
    '--help',
    '-c core.sshCommand=bad',
    'HEAD',
    'refs/tags/v0.1.0',
    'v0.1.0^{commit}',
    'v0.1.0:package.json',
    'v0.1.0;echo bad',
    'v0.1.0\n',
    'v0.1.0$(bad)',
    'v0.1.0`bad`',
    'v01.1.0',
    'v0.1.0-01',
    undefined,
  ]) {
    assert.throws(() =>
      resolveTagSource(unsafe, () => assert.fail('unsafe tag reached Git')),
    );
  }
});
test('missing tag, invalid commit and mismatched tagged package version fail closed', () => {
  assert.throws(
    () =>
      resolveTagSource(tag, () => {
        throw new Error('git rev-parse failed: missing tag');
      }),
    /missing tag/,
  );
  for (const invalid of [
    'HEAD',
    '--help',
    `${commit}:package.json`,
    'b'.repeat(39),
  ])
    assert.throws(
      () => resolveTagSource(tag, () => invalid),
      /Invalid tagged source commit/,
    );
  for (const taggedVersion of ['0.2.0', '01.1.0', undefined]) {
    const calls = [];
    assert.throws(
      () =>
        resolveTagSource(tag, (args) => {
          calls.push(args);
          return args[0] === 'rev-parse'
            ? commit
            : JSON.stringify({ version: taggedVersion });
        }),
      /must match app version/,
    );
    assert.deepEqual(calls[1], ['show', `${commit}:package.json`]);
  }
});
