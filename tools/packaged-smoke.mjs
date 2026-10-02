import { checkDesktopEntry } from './linux-package-check.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const platforms = {
  darwin: { os: 'mac', arch: 'arm64', formats: ['dmg', 'zip'] },
  win32: { os: 'win', arch: 'x64', formats: ['exe'] },
  linux: { os: 'linux', arch: 'x64', formats: ['deb', 'AppImage'] },
};
const platform = platforms[process.platform];
if (!platform || platform.arch !== process.arch)
  throw new Error(
    `Unexercised package platform: ${process.platform}/${process.arch}`,
  );
const verified = join(workspace, '.cache', 'verified-packages');
// Only payloads checked by this invocation are eligible for artifact upload.
await rm(verified, { recursive: true, force: true });
const results = [];
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.stdout}\n${result.stderr}`,
    );
}
async function extract(artifact, format, directory) {
  const payload = join(directory, 'payload');
  await mkdir(payload);
  if (format === 'dmg') {
    const mount = join(directory, 'mount');
    await mkdir(mount);
    run('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      artifact,
    ]);
    try {
      await cp(join(mount, 'Canopy.app'), join(payload, 'Canopy.app'), {
        recursive: true,
        verbatimSymlinks: true,
      });
    } finally {
      run('hdiutil', ['detach', mount]);
    }
  } else if (format === 'zip') {
    run('ditto', ['-x', '-k', artifact, payload]);
  } else if (format === 'exe') {
    // Inspect the NSIS payload without claiming a native installation check.
    run('7z', ['x', '-y', `-o${payload}`, artifact]);
    const archive = join(payload, '$PLUGINSDIR', 'app-64.7z');
    await access(archive);
    run('7z', ['x', '-y', `-o${payload}`, archive]);
  } else if (format === 'deb') {
    run('dpkg-deb', ['-x', artifact, payload]);
  } else {
    run(artifact, ['--appimage-extract'], payload);
  }
  return process.platform === 'darwin'
    ? join(payload, 'Canopy.app', 'Contents', 'MacOS', 'Canopy')
    : process.platform === 'win32'
      ? join(payload, 'Canopy.exe')
      : format === 'deb'
        ? join(payload, 'opt', 'Canopy', 'canopy')
        : join(payload, 'squashfs-root', 'canopy');
}
async function linuxStartupEvidence(executable, artifact, format, directory) {
  const inspect = async (path) => {
    try {
      const metadata = await stat(path);
      return {
        path,
        realpath: await realpath(path),
        uid: metadata.uid,
        gid: metadata.gid,
        mode: (metadata.mode & 0o7777).toString(8),
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      };
    } catch (error) {
      return { path, error: String(error) };
    }
  };
  const read = async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      return String(error);
    }
  };
  const probe = (command, args) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    };
  };
  const payload = dirname(executable);
  const evidence = {
    format,
    launchSemantics:
      executable === '/opt/Canopy/canopy'
        ? 'installed DEB; shipped postinst executed'
        : format === 'deb'
          ? 'extracted DEB identity inspection; installer not yet run'
          : 'extracted identity inspection; original AppImage runtime launched separately',
    artifact: await inspect(artifact),
    executable: await inspect(executable),
    appAsar: await inspect(join(payload, 'resources', 'app.asar')),
    sandboxHelper: await inspect(join(payload, 'chrome-sandbox')),
    apparmorProfile: await read(join(payload, 'resources', 'apparmor-profile')),
    apparmorEnabled: await read('/sys/module/apparmor/parameters/enabled'),
    userNamespaceRestriction: await read(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    ),
    unprivilegedUserNamespaces: await read(
      '/proc/sys/kernel/unprivileged_userns_clone',
    ),
    runnerApparmorContext: await read('/proc/self/attr/current'),
    userNamespaceProbe: probe('unshare', ['--user', 'true']),
    mount: probe('findmnt', ['-T', executable, '-no', 'TARGET,FSTYPE,OPTIONS']),
  };
  if (format === 'deb') {
    const control = join(directory, 'deb-control');
    run('dpkg-deb', ['-e', artifact, control]);
    evidence.debPostInstall = await read(join(control, 'postinst'));
  } else {
    evidence.appRun = await inspect(join(payload, 'AppRun'));
    evidence.desktopEntries = await Promise.all(
      (await readdir(payload))
        .filter((name) => name.endsWith('.desktop'))
        .map(async (name) => ({
          name,
          contents: await read(join(payload, name)),
        })),
    );
  }
  const diagnostics = join(
    workspace,
    '.cache',
    'smoke-failure',
    artifact.split(/[\\/]/).at(-1),
  );
  await mkdir(diagnostics, { recursive: true });
  await writeFile(
    join(diagnostics, 'linux-startup.json'),
    JSON.stringify(evidence, null, 2),
  );
}
async function smoke(executablePath, directory, artifact, identity) {
  const userData = join(directory, 'user-data');
  await mkdir(userData);
  const env = { ...process.env, CANOPY_USER_DATA: userData };
  // Keep inherited development/demo controls out of the first-run check.
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith('CANOPY_') && key !== 'CANOPY_USER_DATA') ||
      [
        'ELECTRON_RUN_AS_NODE',
        'ELECTRON_DISABLE_SANDBOX',
        'CHROME_DEVEL_SANDBOX',
        'NODE_OPTIONS',
      ].includes(key)
    )
      delete env[key];
  }
  let app;
  let page;
  const errors = [];
  const launches = [];
  try {
    for (const restart of [false, true]) {
      app = await electron.launch({
        executablePath,
        env,
        chromiumSandbox: true,
        timeout: 30000,
      });
      page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.context().setOffline(true);
      expect(
        await app.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          arch: process.arch,
          version: app.getVersion(),
        })),
      ).toEqual({ packaged: true, arch: platform.arch, version });
      await expect(
        page.getByRole('heading', { name: 'See the whole tree.' }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('button', { name: 'Connect Jira or GitHub', exact: true })
          .first(),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Try demo', exact: true }).first(),
      ).toBeVisible();
      const launch = await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const { join } = process.getBuiltinModule('node:path');
        const { pathToFileURL } = process.getBuiltinModule('node:url');
        const preferences = window.webContents.getLastWebPreferences();
        const state = {
          args: process.argv,
          userData: app.getPath('userData'),
          expectedUrl: pathToFileURL(
            join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
          ).href,
          frameUrl: window.webContents.mainFrame.url,
          rendererSandbox: preferences.sandbox,
          sandboxControls: [
            'ELECTRON_DISABLE_SANDBOX',
            'CHROME_DEVEL_SANDBOX',
          ].filter((key) => process.env[key]),
        };
        if (process.platform === 'linux') {
          const { readFileSync } = process.getBuiltinModule('node:fs');
          const status = readFileSync(
            `/proc/${window.webContents.getOSProcessId()}/status`,
            'utf8',
          );
          state.rendererNoNewPrivs = Number(
            status.match(/^NoNewPrivs:\s+(\d+)/m)?.[1],
          );
          state.rendererSeccomp = Number(
            status.match(/^Seccomp:\s+(\d+)/m)?.[1],
          );
        }
        return state;
      });
      launches.push({ restart, ...launch });
      console.log(
        `Packaged launch security evidence: ${JSON.stringify(launches.at(-1))}`,
      );
      if (identity) {
        const actual = await app.evaluate(({ app }) => ({
          pid: process.pid,
          appAsar: app.getAppPath(),
          appImage: process.env.APPIMAGE,
        }));
        actual.executable = await realpath(`/proc/${actual.pid}/exe`);
        const hash = async (path) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex');
        actual.executableSha256 = await hash(`/proc/${actual.pid}/exe`);
        actual.appAsarSha256 = await hash(actual.appAsar);
        expect(actual.executableSha256).toBe(identity.executableSha256);
        expect(actual.appAsarSha256).toBe(identity.appAsarSha256);
        if (identity.appImage) expect(actual.appImage).toBe(identity.appImage);
        else expect(actual.executable).toBe(executablePath);
        Object.assign(launches.at(-1), actual);
      }
      expect(launch.frameUrl).toBe(launch.expectedUrl);
      expect(launch.userData).toBe(userData);
      expect(launch.rendererSandbox).toBe(true);
      expect(launch.sandboxControls).toEqual([]);
      expect(
        launch.args.filter((arg) =>
          /^--(?:no-sandbox|disable-setuid-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-gpu-sandbox)(?:=|$)/.test(
            arg,
          ),
        ),
      ).toEqual([]);
      if (process.platform === 'linux') {
        expect(launch.rendererNoNewPrivs).toBe(1);
        expect(launch.rendererSeccomp).toBe(2);
      }
      expect(await page.evaluate(() => window.canopy.connections())).toEqual(
        [],
      );
      expect(await page.evaluate(() => window.canopy.demoMode())).toBe(false);
      if (!restart) {
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Settings', exact: true })
          .getByRole('button', { name: 'Appearance', exact: true })
          .click();
        const appearance = page.getByRole('dialog', { name: 'Appearance' });
        await appearance.getByRole('radio', { name: 'Forest' }).check();
        await appearance
          .getByRole('radio', { name: 'Dark', exact: true })
          .check();
        await appearance
          .getByRole('button', { name: 'Save', exact: true })
          .click();
        await expect
          .poll(
            async () =>
              JSON.parse(
                await readFile(join(userData, 'workspace.json'), 'utf8'),
              ).palette,
          )
          .toBe('forest');
      }
      await expect(page.locator('html')).toHaveAttribute(
        'data-palette',
        'forest',
      );
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('.welcome-error')).toHaveCount(0);
      // Retained errors cover startup before firstWindow() resolves and before
      // the live listener attaches. Check each launch while its page is open.
      errors.push(...(await page.pageErrors()).map((error) => error.message));
      expect(errors).toEqual([]);
      await app.close();
      app = undefined;
    }
    expect(errors).toEqual([]);
    await expect
      .poll(async () => {
        try {
          await access(join(userData, 'credentials.json'));
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      })
      .toBe(false);
  } catch (error) {
    const diagnostics = join(workspace, '.cache', 'smoke-failure', artifact);
    await mkdir(diagnostics, { recursive: true });
    if (page && !page.isClosed())
      await page
        .screenshot({ path: join(diagnostics, 'window.png'), timeout: 3000 })
        .catch(() => {});
    await writeFile(
      join(diagnostics, 'failure.json'),
      JSON.stringify(
        {
          error: String(error.stack ?? error),
          errors,
          launches,
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (app) await app.close();
  }
  return launches;
}
for (const format of platform.formats) {
  // electron-builder uses native Linux architecture names in artifact macros.
  const artifactArch =
    format === 'deb'
      ? 'amd64'
      : format === 'AppImage'
        ? 'x86_64'
        : platform.arch;
  const name = `Canopy-${version}-${platform.os}-${artifactArch}.${format}`;
  const artifact = join(workspace, 'release', name);
  // Canonicalize temporary paths before launch, including Windows short-name
  // aliases, so Electron and the file-URL trust check use the same spelling.
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'canopy-packaged-')),
  );
  try {
    await access(artifact);
    const executable = await extract(artifact, format, directory);
    await access(executable);
    if (process.platform === 'linux')
      await linuxStartupEvidence(executable, artifact, format, directory);
    let launchExecutable = executable;
    let identity;
    let installAttempted = false;
    let primaryFailed = false;
    let launches;
    try {
      if (process.platform === 'linux') {
        const hash = async (path) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex');
        identity = {
          executableSha256: await hash(executable),
          appAsarSha256: await hash(
            join(dirname(executable), 'resources', 'app.asar'),
          ),
        };
        if (format === 'deb') {
          if (
            process.env.GITHUB_ACTIONS !== 'true' ||
            process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
          )
            throw new Error(
              'Automatic DEB installation requires a disposable GitHub-hosted runner',
            );
          // Install the emitted DEB's missing runner prerequisites before dpkg
          // can leave Canopy unpacked but unconfigured. APT resolves their deps.
          run('sudo', ['-n', 'apt-get', 'update']);
          run('sudo', [
            '-n',
            'apt-get',
            'install',
            '--yes',
            '--no-install-recommends',
            'libnotify4',
            'libsecret-1-0',
          ]);
          // Exercise the shipped postinst/AppArmor semantics, never chown an
          // extracted test payload or relax host namespace restrictions.
          installAttempted = true;
          run('sudo', ['-n', 'dpkg', '--install', artifact]);
          launchExecutable = '/opt/Canopy/canopy';
          checkDesktopEntry(
            await readFile('/usr/share/applications/canopy.desktop', 'utf8'),
            launchExecutable,
          );
          await linuxStartupEvidence(
            launchExecutable,
            artifact,
            format,
            directory,
          );
        } else {
          checkDesktopEntry(
            await readFile(join(dirname(executable), 'canopy.desktop'), 'utf8'),
            'AppRun',
          );
          // Check the shipped launcher, then invoke the original AppImage runtime
          // (including its mounting path). Never launch the extracted binary.
          expect(
            await readFile(join(dirname(executable), 'AppRun'), 'utf8'),
          ).toBe(await readFile(join(root, 'tools', 'AppRun'), 'utf8'));
          launchExecutable = artifact;
          identity.appImage = artifact;
        }
      }
      launches = await smoke(launchExecutable, directory, name, identity);
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      if (installAttempted) {
        try {
          run('sudo', ['-n', 'dpkg', '--remove', 'canopy']);
        } catch (cleanupError) {
          if (!primaryFailed) throw cleanupError;
          console.error('DEB removal also failed:', cleanupError);
        }
      }
    }
    results.push({
      artifact: name,
      launchExecutable,
      launches,
      sha256: createHash('sha256')
        .update(await readFile(artifact))
        .digest('hex'),
    });
    console.log(`Packaged first-run and restart passed: ${name}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await mkdir(verified, { recursive: true });
for (const result of results)
  await cp(
    join(workspace, 'release', result.artifact),
    join(verified, result.artifact),
  );
await writeFile(
  join(verified, 'release-checks.json'),
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      version,
      commit: process.env.GITHUB_SHA,
      checks: results,
      nativeDesktopChecks: 'pending',
    },
    null,
    2,
  ),
);
