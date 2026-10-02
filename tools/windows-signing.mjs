import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateTag } from './release.mjs';

export const windowsSigningPolicy = 'Authenticode signed and timestamped';
export function signingConfig(env, platform, version, hook) {
  if (env.CANOPY_WINDOWS_SIGN !== '1') return {};
  if (
    platform !== 'win32' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.GITHUB_EVENT_NAME !== 'push'
  )
    throw new Error('Windows signing requires a protected hosted tag job');
  validateTag(env.GITHUB_REF?.replace(/^refs\/tags\//, ''), version);
  if (
    !env.GITHUB_REF?.startsWith('refs/tags/') ||
    !env.CANOPY_WINDOWS_PFX ||
    !env.CANOPY_WINDOWS_PFX_PASSWORD ||
    !env.CANOPY_WINDOWS_SUBJECT ||
    !/^[A-F0-9]{40}$/.test(env.CANOPY_WINDOWS_THUMBPRINT ?? '') ||
    !env.CANOPY_SIGNTOOL
  )
    throw new Error('Windows signing identity and credentials required');
  return {
    forceCodeSigning: true,
    win: {
      signtoolOptions: {
        sign: hook,
        signingHashAlgorithms: ['sha256'],
      },
    },
  };
}
export function validateSignature(record, sha256, identity, now = Date.now()) {
  if (
    record?.status !== 'Valid' ||
    record.timestamp !== true ||
    !Number.isFinite(Date.parse(record.notBefore)) ||
    !Number.isFinite(Date.parse(record.notAfter)) ||
    Date.parse(record.notBefore) > now ||
    Date.parse(record.notAfter) <= now ||
    record.subject !== identity.subject ||
    record.thumbprint !== identity.thumbprint ||
    !identity.subject ||
    !/^[A-F0-9]{40}$/.test(identity.thumbprint ?? '') ||
    record.sha256 !== sha256 ||
    !/^[a-f0-9]{64}$/.test(sha256 ?? '')
  )
    throw new Error('Windows signature identity, timestamp or hash mismatch');
}
export function validateWindowsReport(report, installerHash) {
  if (report?.policy !== windowsSigningPolicy)
    throw new Error('Windows signing pending');
  validateSignature(report.installer, installerHash, report);
  validateSignature(report.executable, report.executable?.sha256, report);
}
function command(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error('Windows signing/verification tool failed');
  return result.stdout;
}
export function authenticode(path, mode = 'verify', run = command) {
  if (process.platform !== 'win32')
    throw new Error('Actual Authenticode verification requires Windows');
  const env = { ...process.env, CANOPY_SIGN_FILE: resolve(path) };
  if (mode === 'verify') {
    delete env.CANOPY_WINDOWS_PFX;
    delete env.CANOPY_WINDOWS_PFX_PASSWORD;
  }
  return JSON.parse(
    run(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(
          dirname(fileURLToPath(import.meta.url)),
          'windows-authenticode.ps1',
        ),
        '-Mode',
        mode,
      ],
      env,
    ),
  );
}
// electron-builder 26 custom Windows signing hook; only SHA-256 is configured.
export default async function sign(configuration) {
  authenticode(configuration.path, 'sign');
}
export async function verifyWindowsInstaller(
  path,
  expected,
  inspect = authenticode,
  run = command,
) {
  const identity = {
    subject: process.env.CANOPY_WINDOWS_SUBJECT,
    thumbprint: process.env.CANOPY_WINDOWS_THUMBPRINT,
  };
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const installer = inspect(path);
  validateSignature(installer, sha256, identity);
  const temporary = await mkdtemp(join(tmpdir(), 'canopy-authenticode-'));
  try {
    run('7z', ['x', '-y', `-o${temporary}`, resolve(path)]);
    run('7z', [
      'x',
      '-y',
      `-o${join(temporary, 'app')}`,
      join(temporary, '$PLUGINSDIR', 'app-64.7z'),
    ]);
    const executablePath = join(temporary, 'app', 'Canopy.exe');
    const executableHash = createHash('sha256')
      .update(await readFile(executablePath))
      .digest('hex');
    const executable = inspect(executablePath);
    validateSignature(executable, executableHash, identity);
    const report = {
      policy: windowsSigningPolicy,
      ...identity,
      installer,
      executable,
    };
    if (expected && JSON.stringify(report) !== JSON.stringify(expected))
      throw new Error('Windows signature report differs from downloaded bytes');
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== sha256
    )
      throw new Error(
        'Windows installer changed during signature verification',
      );
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'verify') {
    await verifyWindowsInstaller(directory);
    process.exit(0);
  }
  if (mode !== 'report') throw new Error('Unknown Windows signing command');
  const path = join(directory, 'release-checks.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  if (
    report.platform !== 'win32' ||
    report.arch !== 'x64' ||
    report.checks.length !== 1
  )
    throw new Error('Windows report identity mismatch');
  validateTag(`v${report.version}`, report.version);
  const name = `Canopy-${report.version}-win-x64.exe`;
  if (report.checks[0].artifact !== name)
    throw new Error('Unexpected Windows installer');
  report.windowsSigning = await verifyWindowsInstaller(join(directory, name));
  validateWindowsReport(report.windowsSigning, report.checks[0].sha256);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}
