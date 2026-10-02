import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readlinkSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { test } from 'node:test';
import { command, signedPackages, signingGate } from './macos-release.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  CANOPY_SIGNED_RELEASE: '1',
  GITHUB_REF: 'refs/tags/v0.1.0',
  RELEASE_TAG: 'v0.1.0',
  MAC_IDENTITY: 'Developer ID Application: Fixture (ABCDEFGHIJ)',
  MAC_TEAM_ID: 'ABCDEFGHIJ',
  MAC_CERTIFICATE_P12: 'cDEy',
  MAC_CERTIFICATE_PASSWORD: 'password-sentinel',
  MAC_NOTARY_KEY: 'private-key-sentinel',
  MAC_NOTARY_KEY_ID: '1234567890',
  MAC_NOTARY_ISSUER: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
const certificate = Buffer.from('synthetic certificate');
const fingerprint = createHash('sha1').update(certificate).digest('hex');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('signing gate resolves a real tagged Git source and rejects unprotected runners and changed identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canopy-tag-77-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('fixture Git failed');
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
      'Fixture',
    ]);
    git(['tag', 'v0.1.0']);
    const source = { ...env, GITHUB_SHA: git(['rev-parse', 'HEAD']).trim() };
    assert.equal(
      signingGate(source, 'darwin', 'arm64', '0.1.0', git).commit,
      source.GITHUB_SHA,
    );
    for (const patch of [
      { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_REF: 'refs/heads/main' },
      { RUNNER_ENVIRONMENT: 'self-hosted' },
      { GITHUB_ACTIONS: '' },
      { CANOPY_SIGNED_RELEASE: '' },
      { GITHUB_SHA: 'a'.repeat(40) },
      { MAC_TEAM_ID: 'OTHERTEAM1' },
      { MAC_IDENTITY: '-' },
      { MAC_CERTIFICATE_P12: '' },
      { MAC_CERTIFICATE_PASSWORD: '' },
      { MAC_NOTARY_KEY: '' },
      { MAC_NOTARY_KEY_ID: 'bad' },
      { CSC_LINK: 'other.p12' },
      { DEBUG: '*' },
    ])
      assert.throws(() =>
        signingGate({ ...source, ...patch }, 'darwin', 'arm64', '0.1.0', git),
      );
    assert.throws(() => signingGate(source, 'linux', 'x64', '0.1.0', git));
    assert.throws(() => signingGate(source, 'darwin', 'ia32', '0.1.0', git));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '0.2.0' }),
    );
    git(['add', 'package.json']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'New version',
    ]);
    assert.throws(
      () => signingGate(source, 'darwin', 'arm64', '0.1.0', git),
      /source mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function opensslOutputDirectory(args, paths = { dirname }) {
  return paths.dirname(args[args.indexOf('-out') + 1]);
}
function isExtractedZipApp(path, scratch, paths = { join }) {
  return path === paths.join(scratch, 'zip', 'Canopy.app');
}
test('OpenSSL mock uses the parent output directory for Windows and POSIX keychain paths', () => {
  for (const [paths, scratch, keychain] of [
    [
      win32,
      String.raw`C:\Users\Runner\Temp\canopy-signing-fixture`,
      String.raw`C:\Users\Runner\Temp\canopy-signing-fixture\signing.keychain-db`,
    ],
    [
      posix,
      '/tmp/canopy-signing-fixture',
      '/tmp/canopy-signing-fixture/signing.keychain-db',
    ],
  ]) {
    const args = ['pkcs12', '-out', paths.join(scratch, 'identity.pem')];
    assert.equal(opensslOutputDirectory(args, paths), scratch);
    assert.equal(
      paths.join(opensslOutputDirectory(args, paths), 'signing.keychain-db'),
      keychain,
    );
    assert.equal(
      isExtractedZipApp(
        paths.join(scratch, 'zip', 'Canopy.app'),
        scratch,
        paths,
      ),
      true,
    );
    assert.equal(
      isExtractedZipApp(
        paths.join(scratch, 'dmg-app', 'Canopy.app'),
        scratch,
        paths,
      ),
      false,
    );
  }
});

async function exercise(fault, arch = 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'canopy-sign-mock-'));
  const output = join(root, 'release');
  await mkdir(output);
  const app = join(root, 'app', 'Canopy.app');
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/MacOS/Canopy'), 'mock executable');
  const framework = join('Contents', 'Frameworks', 'Electron.framework');
  const internalSymlink = process.platform !== 'win32' && !fault;
  if (internalSymlink) {
    await mkdir(join(app, framework, 'Versions/A'), { recursive: true });
    await writeFile(
      join(app, framework, 'Versions/A/Electron'),
      'mock framework',
    );
    symlinkSync('A', join(app, framework, 'Versions/Current'), 'dir');
  }
  const populate = (payload, format) => {
    const target = join(payload, 'Canopy.app');
    if (fault === `${format}-root-link`)
      symlinkSync(
        app,
        target,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    else if (fault === `${format}-root-file`)
      writeFileSync(target, 'not a directory');
    else cpSync(app, target, { recursive: true, verbatimSymlinks: true });
    if (fault === `${format}-extra`)
      writeFileSync(join(payload, 'extra.txt'), 'extra member');
  };
  const calls = [];
  let scratch;
  let afterSign = false;
  let copiedInvalidRoot = false;
  const run = (name, args, options = {}) => {
    calls.push({ name, args, options });
    assert.ok(
      !args.some(
        (arg) =>
          String(arg).includes(env.MAC_CERTIFICATE_PASSWORD) ||
          String(arg).includes(env.MAC_NOTARY_KEY),
      ),
      'secret leaked into process argv',
    );
    if (
      name === 'security' &&
      args[0] === 'list-keychains' &&
      !args.includes('-s')
    )
      return '"/mock/login.keychain-db"';
    if (name === 'openssl') {
      scratch ??= opensslOutputDirectory(args);
      if (fault === 'decrypt') throw new Error('mock decryption failure');
      if (args.includes('-export')) {
        assert.deepEqual(args.slice(0, 8), [
          'pkcs12',
          '-export',
          '-keypbe',
          'PBE-SHA1-3DES',
          '-certpbe',
          'PBE-SHA1-3DES',
          '-macalg',
          'sha1',
        ]);
        assert.equal(args[args.indexOf('-passout') + 1], 'pass:');
        if (fault === 'export') throw new Error('mock export failure');
      } else {
        assert.equal(
          args[args.indexOf('-passin') + 1],
          'env:CANOPY_P12_PASSWORD',
        );
        assert.deepEqual(options.env, {
          PATH: process.env.PATH,
          CANOPY_P12_PASSWORD: env.MAC_CERTIFICATE_PASSWORD,
        });
      }
      writeFileSync(args[args.indexOf('-out') + 1], 'mock private key');
    }
    if (fault === 'import' && name === 'security' && args[0] === 'import')
      throw new Error('mock import failure');
    if (name === 'security' && args[0] === 'find-identity')
      return fault === 'certificate'
        ? '0 valid identities found'
        : `1) ${fingerprint} "${env.MAC_IDENTITY}"`;
    if (name === 'xcrun' && args[0] === 'notarytool')
      return JSON.stringify({
        id,
        status:
          fault === 'notary' ||
          (fault === 'dmg-notary' && args[2].endsWith('.dmg'))
            ? 'Invalid'
            : 'Accepted',
      });
    if (
      (fault === 'staple' ||
        (fault === 'dmg-staple' && args.at(-1).endsWith('.dmg'))) &&
      name === 'xcrun' &&
      args[0] === 'stapler'
    )
      throw new Error('mock missing staple');
    if (
      name === 'codesign' &&
      args.includes('--verify') &&
      (fault === 'signature' ||
        (fault === 'zip-signature' && isExtractedZipApp(args.at(-1), scratch)))
    )
      throw new Error('mock invalid signature');
    if (
      internalSymlink &&
      name === 'codesign' &&
      args.includes('--verify') &&
      args.at(-1).endsWith('Canopy.app')
    ) {
      const checkedApp = args.at(-1);
      const link = join(checkedApp, framework, 'Versions/Current');
      assert.equal(readlinkSync(link), 'A');
      assert.equal(
        realpathSync(link),
        join(realpathSync(checkedApp), framework, 'Versions/A'),
      );
    }
    if (name === 'codesign' && args.includes('--extract-certificates'))
      writeFileSync(
        `${args[args.indexOf('--extract-certificates') + 1]}0`,
        fault === 'fingerprint' ? 'wrong certificate' : certificate,
      );
    if (name === 'codesign' && args.includes('--verbose=4'))
      return `Authority=${fault === 'identity' ? 'Developer ID Application: Other (ABCDEFGHIJ)' : env.MAC_IDENTITY}\nTeamIdentifier=ABCDEFGHIJ\nIdentifier=app.canopy.desktop\nTimestamp=mock\nflags=0x10000(runtime)\n`;
    if (name === 'lipo')
      return fault === 'arch' ? 'other' : arch === 'x64' ? 'x86_64' : 'arm64';
    if (name === 'spctl' && fault === 'gatekeeper')
      throw new Error('mock Gatekeeper rejection');
    if (name === 'ditto' && args[0] === '-x') populate(args.at(-1), 'zip');
    if (name === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      mkdirSync(mount, { recursive: true });
      populate(mount, 'dmg');
    }
    if (
      name === 'hdiutil' &&
      args[0] === 'detach' &&
      fault?.startsWith('dmg-root-')
    )
      copiedInvalidRoot = existsSync(join(scratch, 'dmg-app'));
    if (
      name === 'security' &&
      args[0] === 'delete-keychain' &&
      fault === 'cleanup'
    )
      throw new Error('mock cleanup failure');
    return '';
  };
  try {
    const action = signedPackages({
      env,
      arch,
      version: '0.1.0',
      projectDir: root,
      output,
      run,
      build: async (options) => {
        assert.equal(options.publish, 'never');
        assert.equal(options.config.forceCodeSigning, true);
        assert.equal(options.config.mac.identity, fingerprint.toUpperCase());
        assert.equal(
          process.env.CSC_KEYCHAIN,
          join(scratch, 'signing.keychain-db'),
        );
        await options.config.afterSign({ appOutDir: join(root, 'app') });
        afterSign = true;
        // Containers must be produced only after afterSign successfully notarizes/staples the app.
        for (const format of ['dmg', 'zip']) {
          const path = join(output, `Canopy-0.1.0-mac-${arch}.${format}`);
          if (fault === 'unsafe')
            symlinkSync(join(app, 'Contents/MacOS/Canopy'), path);
          else await writeFile(path, `synthetic ${format}`);
        }
      },
    });
    if (fault)
      await assert.rejects(
        action,
        fault.includes('-root-')
          ? /app root/
          : fault === 'zip-extra'
            ? /Unexpected ZIP payload/
            : undefined,
      );
    else {
      const report = await action;
      assert.equal(report.assets.length, 2);
      assert.equal(report.trust.status, 'verified');
      assert.equal(report.trust.submissions.length, 2);
      assert.ok(afterSign);
    }
    assert.equal(
      calls.some(
        (call) =>
          call.name === 'security' && call.args[0] === 'delete-keychain',
      ),
      !['decrypt', 'export'].includes(fault),
    );
    if (!['decrypt', 'export'].includes(fault))
      assert.deepEqual(
        calls
          .filter(
            (call) =>
              call.name === 'security' &&
              call.args.includes('-s') &&
              call.args[0] === 'list-keychains',
          )
          .at(-1).args,
        ['list-keychains', '-d', 'user', '-s', '/mock/login.keychain-db'],
      );
    if (fault?.includes('-root-') || fault === 'zip-extra') {
      const format = fault.split('-')[0];
      assert.ok(
        !calls.some(
          (call) =>
            ['codesign', 'lipo', 'spctl', 'xcrun'].includes(call.name) &&
            call.args.some((arg) =>
              String(arg).startsWith(
                join(scratch, format === 'zip' ? 'zip' : 'dmg-app'),
              ),
            ),
        ),
        'invalid container root reached native verification',
      );
      if (format === 'dmg') {
        assert.equal(
          copiedInvalidRoot,
          false,
          'invalid mounted root was copied',
        );
        assert.ok(
          calls.some(
            (call) => call.name === 'hdiutil' && call.args[0] === 'detach',
          ),
          'rejected DMG was not detached',
        );
      }
    }
    assert.ok(!existsSync(scratch), 'temporary credentials survived');
    assert.notEqual(
      process.env.CSC_KEYCHAIN,
      join(scratch, 'signing.keychain-db'),
    );
    if (
      [
        'notary',
        'staple',
        'signature',
        'identity',
        'fingerprint',
        'arch',
        'gatekeeper',
      ].includes(fault)
    )
      assert.equal(afterSign, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('mocked arm64 and x64 flows verify stapled container payloads and clean credentials', async () => {
  await exercise(undefined);
  await exercise(undefined, 'x64');
});
test('certificate, notarization, staple, signature, publisher, CPU, unsafe artifacts and cleanup failures prevent success', async () => {
  for (const fault of [
    'decrypt',
    'export',
    'import',
    'certificate',
    'notary',
    'staple',
    'signature',
    'identity',
    'fingerprint',
    'arch',
    'gatekeeper',
    'unsafe',
    'dmg-notary',
    'dmg-staple',
    'zip-signature',
    'cleanup',
  ])
    await exercise(fault);
});
test('child error output cannot disclose credentials', () => {
  assert.throws(
    () =>
      command(process.execPath, [
        '-e',
        'process.stderr.write("private-key-sentinel");process.exit(1)',
      ]),
    (error) =>
      !error.message.includes('private-key-sentinel') &&
      !error.message.includes('process.stderr'),
  );
});
test('signing workflow scopes credentials to protected signing and keeps native/public gates separate', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/sign-macos.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /environment: macos-signing/);
  assert.match(workflow, /macos-15-intel/);
  assert.doesNotMatch(workflow, /pull_request:|push:|draft=false|release edit/);
  assert.equal(workflow.split('secrets.').length - 1, 3);
});

test('distributed ZIP and DMG roots reject external links and files before verification; ZIP rejects extra members', async (t) => {
  for (const fault of [
    'zip-root-link',
    'dmg-root-link',
    'zip-root-file',
    'dmg-root-file',
    'zip-extra',
  ])
    await t.test(fault, () => exercise(fault));
});
