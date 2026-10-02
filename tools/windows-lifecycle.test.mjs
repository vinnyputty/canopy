import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  lifecycleOrigin,
  nsisGuid,
  refuseExisting,
  runLifecycle,
} from './windows-lifecycle.mjs';
import { fixturePolicy, fixtureSignature } from './windows-signing-fixture.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const head = 'a'.repeat(40);
const manifest = { build: { appId: 'app.canopy.desktop' } };
const guid = nsisGuid(manifest.build.appId);
async function fixture(action, scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), 'canopy-lifecycle-mock-'));
  const previousInstaller = join(root, 'previous.exe'),
    installer = join(root, 'current.exe');
  await writeFile(previousInstaller, 'previous-installer');
  await writeFile(installer, 'current-installer');
  const options = {
    reviewedCommit: head,
    previousInstaller,
    installer,
    previousSha256: digest('previous-installer'),
    sha256: digest('current-installer'),
  };
  const env = {
    CANOPY_DISPOSABLE_WINDOWS_ACCOUNT: '1',
    CANOPY_WINDOWS_NATIVE_TOKEN: 'synthetic-exclusive-token',
    CANOPY_WINDOWS_POLICY: JSON.stringify(fixturePolicy),
    CANOPY_USER_DATA: 'original-owned-test-path',
  };
  if (scenario.absentProfile) delete env.CANOPY_USER_DATA;
  const layout = {
    directory: join(root, 'redirected-UserProgramFiles', 'Canopy'),
    desktop: join(root, 'desktop', 'Canopy.lnk'),
    menu: join(root, 'menu', 'Canopy.lnk'),
  };
  let installed = false,
    exeBytes;
  const calls = [];
  const snapshot = () => ({
    os: 'Microsoft Windows 11',
    ...layout,
    running: [],
    registrations: installed
      ? [
          {
            hive: 'CurrentUser',
            view: 'Registry64',
            key: `Software/${guid}`,
            location: layout.directory,
            present: true,
          },
          {
            hive: 'CurrentUser',
            view: 'Registry64',
            key: `Software/Microsoft/Windows/CurrentVersion/Uninstall/${guid}`,
            present: true,
          },
        ]
      : [],
    existingPaths: installed ? [layout.directory] : [],
    links: installed
      ? [layout.desktop, layout.menu].map((path) => ({
          path,
          target: join(layout.directory, 'Canopy.exe'),
        }))
      : [],
  });
  const native = async (request, childEnv) => {
    calls.push(request);
    assert.equal(childEnv.CANOPY_USER_DATA, env.CANOPY_USER_DATA);
    if (request.operation === 'snapshot') {
      if (!installed && scenario.preflight)
        return { ...snapshot(), ...scenario.preflight };
      if (scenario.running && calls.some((x) => x.operation === 'launch'))
        return { ...snapshot(), running: [42] };
      return snapshot();
    }
    if (request.operation === 'verify') {
      if (scenario.verifyFailure)
        return {
          ok: false,
          error: 'trust verification failed',
          ownedAbsent: false,
        };
      return fixtureSignature(
        digest(await readFile(request.path)),
        exeBytes === 'current-exe' ? 'B'.repeat(40) : 'A'.repeat(40),
      );
    }
    if (request.operation === 'launch') {
      if (scenario.missingUninstaller)
        await rm(join(layout.directory, 'Uninstall Canopy.exe'));
      if (scenario.cancel) throw new Error('fixture cancellation');
      return {
        ok: !scenario.launchFailure,
        ownedAbsent: !scenario.uncertain,
        error: scenario.launchFailure ? 'first launch failed' : null,
        cleanupError: scenario.uncertain ? 'job termination unconfirmed' : null,
      };
    }
    assert.equal(request.operation, 'run');
    assert.equal(request.timeoutMs, 90000);
    if (request.file.endsWith('Uninstall Canopy.exe')) {
      if (scenario.uninstallFailure)
        return {
          ok: false,
          ownedAbsent: true,
          error: 'uninstaller failed',
          cleanupError: 'secondary cleanup evidence',
        };
      installed = false;
      await rm(layout.directory, { recursive: true, force: true });
      return { ok: true, ownedAbsent: true };
    }
    installed = true;
    await mkdir(layout.directory, { recursive: true });
    exeBytes =
      request.file === previousInstaller ? 'previous-exe' : 'current-exe';
    await writeFile(join(layout.directory, 'Canopy.exe'), exeBytes);
    await writeFile(
      join(layout.directory, 'Uninstall Canopy.exe'),
      'mock-uninstaller',
    );
    return { ok: true, ownedAbsent: true };
  };
  const dependencies = {
    env,
    platform: 'win32',
    manifest,
    tempRoot: root,
    git: (args) => (args[0] === 'rev-parse' ? head : ''),
    native,
    verify: async (path) => ({
      executable: fixtureSignature(
        digest(path === previousInstaller ? 'previous-exe' : 'current-exe'),
        path === previousInstaller ? 'A'.repeat(40) : 'B'.repeat(40),
      ),
    }),
  };
  try {
    await action({ options, dependencies, calls, env, root, layout });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('preflight refuses actual NSIS install keys without display name/uninstall entry in both hives/views', async () => {
  for (const hive of ['CurrentUser', 'LocalMachine'])
    for (const view of ['Registry32', 'Registry64'])
      await fixture(
        async ({ options, dependencies, calls, env }) => {
          await assert.rejects(runLifecycle(options, dependencies), /Existing/);
          assert.ok(calls.every((x) => x.operation === 'snapshot'));
          assert.equal(env.CANOPY_USER_DATA, 'original-owned-test-path');
        },
        {
          preflight: {
            registrations: [
              {
                hive,
                view,
                key: `Software/${guid}`,
                location: 'X:/existing/custom',
                present: true,
              },
            ],
          },
        },
      );
});
test('preflight rejects leftover paths, renamed shortcut targets, existing profiles and uncertain snapshots before installers', () => {
  const clean = {
    directory: 'redirected/Canopy',
    registrations: [],
    existingPaths: [],
    links: [],
    running: [],
  };
  refuseExisting(clean);
  for (const patch of [
    { existingPaths: ['custom/Canopy'] },
    { existingPaths: ['sample/profile'] },
    { links: [{ path: 'renamed.lnk', target: 'custom/Canopy.exe' }] },
    { running: [42] },
    { registrations: undefined },
  ])
    assert.throws(() => refuseExisting({ ...clean, ...patch }));
});
test('positive lifecycle uses resolved UserProgramFiles, confirms job absence and preserves both owned profiles', async () => {
  await fixture(async ({ options, dependencies, calls, env }) => {
    const report = await runLifecycle(options, dependencies);
    assert.equal(report.cleanup, 'passed');
    assert.equal(report.nativeChecks, 'pending');
    assert.equal(report.environmentRestored, true);
    assert.deepEqual(report.checks, [
      'previous-install',
      'upgrade',
      'remove-upgrade',
      'clean-current-install',
      'cleanup-uninstall',
    ]);
    assert.equal(calls.filter((x) => x.operation === 'launch').length, 3);
    assert.equal(env.CANOPY_USER_DATA, 'original-owned-test-path');
    for (const name of ['profile', 'clean-profile'])
      assert.equal(
        await readFile(
          join(report.profileRoot, name, 'fixture-marker.txt'),
          'utf8',
        ),
        'owned disposable fixture',
      );
    assert.equal(
      JSON.parse(
        await readFile(
          join(report.profileRoot, 'lifecycle-report.json'),
          'utf8',
        ),
      ).nativeChecks,
      'pending',
    );
  });
});
test('first-launch primary survives missing/failed uninstaller and records secondary errors plus restoration', async () => {
  for (const secondary of ['missingUninstaller', 'uninstallFailure'])
    await fixture(
      async ({ options, dependencies, env }) => {
        let error;
        try {
          await runLifecycle(options, dependencies);
        } catch (caught) {
          error = caught;
        }
        assert.equal(error.message, 'first launch failed');
        const report = error.lifecycleReport;
        assert.equal(report.primary.error, 'first launch failed');
        assert.equal(report.primary.stage, 'previous-install');
        assert.ok(report.cleanupErrors.length);
        assert.equal(report.cleanup, 'failed');
        assert.equal(report.environmentRestored, true);
        const stored = JSON.parse(
          await readFile(
            join(report.profileRoot, 'lifecycle-report.json'),
            'utf8',
          ),
        );
        assert.equal(stored.primary.error, 'first launch failed');
        assert.ok(stored.cleanupErrors.length);
        assert.equal(env.CANOPY_USER_DATA, 'original-owned-test-path');
        await readFile(
          join(report.profileRoot, 'profile', 'fixture-marker.txt'),
        );
      },
      { launchFailure: true, [secondary]: true },
    );
});
test('unconfirmed shutdown/cancellation/verification ownership blocks upgrade and uninstall and retains evidence', async () => {
  for (const scenario of [
    { uncertain: true },
    { cancel: true },
    { verifyFailure: true },
    { running: true },
  ])
    await fixture(async ({ options, dependencies, calls }) => {
      let error;
      try {
        await runLifecycle(options, dependencies);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      const report = error.lifecycleReport;
      assert.equal(
        calls.filter((x) => x.operation === 'run').length,
        1,
        'unknown/stale application must never reach another installer',
      );
      assert.equal(report.cleanup, 'failed');
      assert.ok(report.cleanupErrors.length);
      assert.equal(report.environmentRestored, true);
      await readFile(join(report.profileRoot, 'lifecycle-report.json'));
      await readFile(join(report.profileRoot, 'profile', 'fixture-marker.txt'));
    }, scenario);
});
test('lifecycle origin rejects dirty/unreviewed source, missing token and credential-bearing native environments', () => {
  const options = {
    reviewedCommit: head,
    sha256: 'b'.repeat(64),
    previousSha256: 'c'.repeat(64),
  };
  const env = {
    CANOPY_DISPOSABLE_WINDOWS_ACCOUNT: '1',
    CANOPY_WINDOWS_NATIVE_TOKEN: 'fixture',
  };
  const git = (args) => (args[0] === 'rev-parse' ? head : '');
  lifecycleOrigin(options, env, 'win32', git);
  for (const patch of [
    { CANOPY_WINDOWS_NATIVE_TOKEN: '' },
    { CANOPY_DISPOSABLE_WINDOWS_ACCOUNT: '' },
    { AZURE_CLIENT_SECRET: 'synthetic' },
    { CANOPY_WINDOWS_PFX: 'synthetic' },
  ])
    assert.throws(() =>
      lifecycleOrigin(options, { ...env, ...patch }, 'win32', git),
    );
  assert.throws(() => lifecycleOrigin(options, env, 'win32', () => head));
  assert.throws(() => lifecycleOrigin(options, env, 'darwin', git));
});

test('lifecycle restores an originally absent profile environment after primary and cleanup failures', async () => {
  await fixture(
    async ({ options, dependencies, env }) => {
      await assert.rejects(runLifecycle(options, dependencies), (error) => {
        assert.equal(error.message, 'first launch failed');
        assert.equal(error.lifecycleReport.environmentRestored, true);
        assert.ok(error.lifecycleReport.cleanupErrors.length);
        return true;
      });
      assert.equal(Object.hasOwn(env, 'CANOPY_USER_DATA'), false);
    },
    { absentProfile: true, launchFailure: true, uninstallFailure: true },
  );
});
