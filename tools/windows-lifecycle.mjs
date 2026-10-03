import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  command,
  nativeOperation,
  verificationEnv,
  verifyWindowsInstaller,
  validateSignature,
  servicePolicy,
} from './windows-signing.mjs';

export function nsisGuid(appId) {
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(appId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function refuseExisting(snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.registrations) ||
    !Array.isArray(snapshot.existingPaths) ||
    !Array.isArray(snapshot.links) ||
    !Array.isArray(snapshot.running) ||
    !snapshot.directory ||
    snapshot.registrations.length ||
    snapshot.existingPaths.length ||
    snapshot.links.length ||
    snapshot.running.length
  )
    throw new Error(
      'Existing or unresolved Canopy installation state; preserve it',
    );
}
export function lifecycleOrigin(options, env, platform, git) {
  if (
    platform !== 'win32' ||
    env.CANOPY_DISPOSABLE_WINDOWS_ACCOUNT !== '1' ||
    !env.CANOPY_WINDOWS_NATIVE_TOKEN ||
    !/^[a-f0-9]{40}$/.test(options.reviewedCommit ?? '') ||
    git(['rev-parse', 'HEAD']).trim() !== options.reviewedCommit ||
    git(['status', '--porcelain']).trim() ||
    !/^[a-f0-9]{64}$/.test(options.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(options.previousSha256 ?? '') ||
    options.sha256 === options.previousSha256 ||
    Object.keys(env).some(
      (key) =>
        /^(AZURE_|CSC_|WIN_CSC_|CANOPY_WINDOWS_PFX)/.test(key) && env[key],
    )
  )
    throw new Error(
      'Clean reviewed source, exclusive native token, fresh disposable Windows account and credential-free distinct upgrade pair required',
    );
}
export async function runLifecycle(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const native = dependencies.native ?? nativeOperation;
  const verify = dependencies.verify ?? verifyWindowsInstaller;
  const git =
    dependencies.git ?? ((args) => command('git', args, verificationEnv(env)));
  const manifest =
    dependencies.manifest ?? JSON.parse(await readFile('package.json', 'utf8'));
  const platform = dependencies.platform ?? process.platform;
  const guid = manifest.build.nsis?.guid ?? nsisGuid(manifest.build.appId);
  const owned = await mkdtemp(
    join(dependencies.tempRoot ?? tmpdir(), 'canopy-native-'),
  );
  const hadProfile = Object.hasOwn(env, 'CANOPY_USER_DATA');
  const previousProfile = env.CANOPY_USER_DATA;
  const report = {
    reviewedCommit: options.reviewedCommit,
    previousSha256: options.previousSha256,
    sha256: options.sha256,
    guid,
    nativeChecks: 'pending',
    profileRoot: owned,
    checks: [],
    stage: 'preflight',
    primary: null,
    cleanupErrors: [],
    environmentRestored: false,
  };
  let primary,
    installed = false,
    ownershipCertain = true,
    layout,
    marker;
  const snapshot = async () =>
    native(
      {
        operation: 'snapshot',
        guid,
        profilePath: report.stage === 'preflight' ? env.CANOPY_USER_DATA : null,
      },
      verificationEnv(env),
    );
  const bounded = async (request) => {
    let result;
    try {
      result = await native(request, verificationEnv(env));
    } catch (error) {
      ownershipCertain = false;
      throw error;
    }
    if (result?.ownedAbsent !== true) ownershipCertain = false;
    if (result?.cleanupError)
      report.cleanupErrors.push({
        stage: report.stage,
        error: result.cleanupError,
      });
    if (!result?.ok || !ownershipCertain)
      throw new Error(result?.error ?? 'Owned process absence unconfirmed');
  };
  const noProcesses = async () => {
    if (!ownershipCertain)
      throw new Error('Unknown process ownership; preserve VM and profiles');
    const state = await snapshot();
    if (!Array.isArray(state.running) || state.running.length)
      throw new Error('Canopy process remains; installer must not close it');
    return state;
  };
  const removeInstalled = async () => {
    await noProcesses();
    const uninstaller = join(layout.directory, 'Uninstall Canopy.exe');
    await access(uninstaller);
    await bounded({
      operation: 'run',
      file: uninstaller,
      args: ['/S'],
      timeoutMs: 90000,
    });
    refuseExisting(await snapshot());
    await access(marker); // Retained sample data is outside the installation and belongs only to this fixture.
    installed = false;
  };
  const checkInstalled = async (expected) => {
    const path = join(layout.directory, 'Canopy.exe');
    let signature;
    try {
      signature = await native(
        { operation: 'verify', path },
        verificationEnv(env),
      );
    } catch (error) {
      ownershipCertain = false;
      throw error;
    }
    if (signature?.ok === false && signature.ownedAbsent !== true)
      ownershipCertain = false;
    validateSignature(
      signature,
      expected.executable.sha256,
      servicePolicy(env),
    );
    if (signature.thumbprint !== expected.executable.thumbprint)
      throw new Error('Installed leaf differs from inspected artifact');
    const state = await noProcesses();
    const expectedLinks = [layout.desktop, layout.menu];
    if (
      !expectedLinks.every((link) =>
        state.links.some(
          (item) =>
            item.path.toLowerCase() === link.toLowerCase() &&
            item.target.toLowerCase() === path.toLowerCase(),
        ),
      ) ||
      !state.registrations.some(
        (item) =>
          item.hive === 'CurrentUser' &&
          item.key === `Software/${guid}` &&
          item.location?.toLowerCase() === layout.directory.toLowerCase(),
      ) ||
      !state.registrations.some(
        (item) =>
          item.hive === 'CurrentUser' &&
          item.key ===
            `Software/Microsoft/Windows/CurrentVersion/Uninstall/${guid}`,
      ) ||
      state.registrations.some((item) => item.hive === 'LocalMachine')
    )
      throw new Error('Installed NSIS registration or shortcut mismatch');
    await bounded({ operation: 'launch', file: path });
    await noProcesses();
  };
  try {
    lifecycleOrigin(options, env, platform, git);
    layout = await snapshot();
    if (!layout.os?.includes('Windows 11'))
      throw new Error('Windows 11 desktop required');
    refuseExisting(layout);
    const reports = [];
    for (const [path, sha256] of [
      [options.previousInstaller, options.previousSha256],
      [options.installer, options.sha256],
    ]) {
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== sha256
      )
        throw new Error('Installer hash mismatch');
      reports.push(await verify(path));
    }
    env.CANOPY_USER_DATA = join(owned, 'profile');
    await mkdir(env.CANOPY_USER_DATA);
    marker = join(env.CANOPY_USER_DATA, 'fixture-marker.txt');
    await writeFile(marker, 'owned disposable fixture', { flag: 'wx' });
    for (const [stage, path, expected] of [
      ['previous-install', options.previousInstaller, reports[0]],
      ['upgrade', options.installer, reports[1]],
    ]) {
      report.stage = stage;
      await noProcesses();
      installed = true;
      await bounded({
        operation: 'run',
        file: resolve(path),
        args: ['/S'],
        timeoutMs: 90000,
      });
      await checkInstalled(expected);
      if ((await readFile(marker, 'utf8')) !== 'owned disposable fixture')
        throw new Error('Owned sample profile changed');
      report.checks.push(stage);
    }
    report.stage = 'remove-upgrade';
    await removeInstalled();
    report.checks.push(report.stage);
    env.CANOPY_USER_DATA = join(owned, 'clean-profile');
    await mkdir(env.CANOPY_USER_DATA);
    marker = join(env.CANOPY_USER_DATA, 'fixture-marker.txt');
    await writeFile(marker, 'owned disposable fixture', { flag: 'wx' });
    report.stage = 'clean-current-install';
    await noProcesses();
    installed = true;
    await bounded({
      operation: 'run',
      file: resolve(options.installer),
      args: ['/S'],
      timeoutMs: 90000,
    });
    await checkInstalled(reports[1]);
    report.checks.push(report.stage);
  } catch (error) {
    primary = error;
    report.primary = { stage: report.stage, error: error.message };
  } finally {
    if (installed) {
      try {
        report.stage = 'cleanup-uninstall';
        await removeInstalled();
        report.checks.push(report.stage);
      } catch (error) {
        report.cleanupErrors.push({
          stage: report.stage,
          error: error.message,
        });
      }
    }
    if (hadProfile) env.CANOPY_USER_DATA = previousProfile;
    else delete env.CANOPY_USER_DATA;
    report.environmentRestored =
      env.CANOPY_USER_DATA === previousProfile &&
      Object.hasOwn(env, 'CANOPY_USER_DATA') === hadProfile;
    report.ownedProcessesAbsent = ownershipCertain;
    report.cleanup =
      installed || !ownershipCertain || report.cleanupErrors.length
        ? 'failed'
        : 'passed';
    try {
      await writeFile(
        join(owned, 'lifecycle-report.json'),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx' },
      );
    } catch (error) {
      report.cleanup = 'failed';
      report.cleanupErrors.push({ stage: 'evidence', error: error.message });
      if (!primary) primary = error;
    }
  }
  if (primary) {
    primary.lifecycleReport = report;
    throw primary;
  }
  if (report.cleanup !== 'passed') {
    const error = new Error('Native cleanup failed; preserve VM and profiles');
    error.lifecycleReport = report;
    throw error;
  }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await runLifecycle(
    JSON.parse(process.env.CANOPY_LIFECYCLE_OPTIONS ?? '{}'),
  );
  console.log(
    `Preliminary evidence: ${join(report.profileRoot, 'lifecycle-report.json')}; native acceptance pending`,
  );
}
