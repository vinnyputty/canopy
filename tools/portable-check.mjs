import { checkRetainedAppImage } from './retained-appimage-check.mjs';
import { checkPackagedFirstSave } from './packaged-save-check.mjs';
import { checkAppImageObserver } from './appimage-observer-check.mjs';
import { checkPackagingPermissions } from './packaging-permissions-check.mjs';
import { checkPackagedInstallCleanup } from './packaged-install-check.mjs';
import assert from 'node:assert/strict';
import { runPackagedCheck } from './packaged-check-log.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { checkDesktopEntry } from './linux-package-check.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), 'canopy tooling '));
try {
  await checkRetainedAppImage();
  await checkPackagedFirstSave();
  await checkAppImageObserver();
  await checkPackagedInstallCleanup();
  await checkPackagingPermissions();
  // Exercise the pinned builder's actual desktop entry generation on every OS.
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { default: AppImageTarget } = builderRequire(
    'app-builder-lib/out/targets/appimage/AppImageTarget.js',
  );
  const { LinuxTargetHelper } = builderRequire(
    'app-builder-lib/out/targets/LinuxTargetHelper.js',
  );
  const manifest = JSON.parse(
    await readFile(join(directory, '..', 'package.json'), 'utf8'),
  );
  function desktopEntry(config) {
    const packager = {
      config,
      platformSpecificBuildOptions: config.linux,
      executableName: 'canopy',
      appInfo: {
        productName: 'Canopy',
        sanitizedProductName: 'Canopy',
        buildVersion: manifest.version,
        description: manifest.description,
      },
      info: { metadata: manifest },
      fileAssociations: [],
    };
    return new AppImageTarget(
      'AppImage',
      packager,
      new LinuxTargetHelper(packager),
      cwd,
    ).desktopEntry.value;
  }
  checkDesktopEntry(await desktopEntry(manifest.build), 'AppRun');
  // The pinned AppImage builder writes its generated launcher, then copyDir's
  // app payload (including linux.extraFiles) over it. Verify the real copier.
  const { copyDir } = builderRequire('builder-util');
  const { generateAppRunScript } = builderRequire(
    'app-builder-lib/out/targets/appimage/appImageUtil.js',
  );
  const appDir = join(cwd, 'app');
  const stageDir = join(cwd, 'stage');
  await mkdir(appDir);
  await mkdir(stageDir);
  await writeFile(
    join(stageDir, 'AppRun'),
    generateAppRunScript({ ExecutableName: 'canopy' }),
  );
  await writeFile(
    join(appDir, 'AppRun'),
    await readFile(join(directory, 'AppRun')),
    { mode: 0o755 },
  );
  await copyDir(appDir, stageDir);
  assert.equal(
    await readFile(join(stageDir, 'AppRun'), 'utf8'),
    await readFile(join(directory, 'AppRun'), 'utf8'),
  );

  const legacyConfig = { ...manifest.build };
  delete legacyConfig.appImage;
  const unsafeEntry = await desktopEntry(legacyConfig);
  assert.match(unsafeEntry, /Exec=AppRun --no-sandbox %U/);
  assert.throws(() => checkDesktopEntry(unsafeEntry, 'AppRun'));
  for (const flag of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-seccomp-filter-sandbox',
    '--disable-namespace-sandbox',
    '--disable-gpu-sandbox',
  ]) {
    assert.throws(() =>
      checkDesktopEntry(`[Desktop Entry]\nExec=AppRun ${flag} %U\n`, 'AppRun'),
    );
  }
  if (process.platform !== 'win32') {
    // Test only the shipped shell launcher's argument handling, never Electron.
    const argumentsPath = join(cwd, 'launcher-arguments');
    await writeFile(
      join(cwd, 'canopy'),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CANOPY_LAUNCHER_ARGUMENTS"
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      APPDIR: cwd,
      CANOPY_LAUNCHER_ARGUMENTS: argumentsPath,
    };
    const launch = (args) =>
      spawnSync('bash', [join(directory, 'AppRun'), ...args], {
        env,
        encoding: 'utf8',
      });
    assert.equal(launch(['argument with spaces']).status, 0);
    assert.equal(
      await readFile(argumentsPath, 'utf8'),
      'argument with spaces\n',
    );
    await rm(argumentsPath);
    for (const flag of [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-seccomp-filter-sandbox',
    ]) {
      const result = launch([flag]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires the Chromium sandbox/);
    }
    await assert.rejects(readFile(argumentsPath), { code: 'ENOENT' });
  }
  // A launcher that exits before Playwright returns an application must retain
  // native stderr and fail; this fixture starts only Node, never Electron.
  const failure = runPackagedCheck(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    ['-e', "console.error('early native launch failure'); process.exit(17)"],
    { cwd, env: process.env },
  );
  assert.equal(failure.status, 17);
  assert.match(
    await readFile(
      join(cwd, '.cache', 'smoke-failure', 'packaged-launch.stderr.log'),
      'utf8',
    ),
    /early native launch failure/,
  );
  // Windows can launch Bazel tools outside a runfiles tree. Exercise the real
  // launchers from an unrelated directory on every platform, including macOS.
  for (const [script, ...args] of [
    ['test.mjs'],
    ['check.mjs', 'types'],
    ['check.mjs', 'format'],
  ]) {
    const result = spawnSync(
      process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
      [join(directory, script), ...args],
      {
        cwd,
        stdio: 'inherit',
        // The aggregate source suite shares the Windows allowance; individual
        // probes retain their own deadlines. Other checks keep their limits.
        timeout:
          script === 'test.mjs' || process.platform === 'win32'
            ? 600_000
            : 60_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${script} ${args.join(' ')} failed from ${cwd}`);
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
