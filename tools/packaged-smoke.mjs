import { _electron as electron, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
  linux: { os: 'linux', arch: 'x64', formats: ['AppImage', 'deb'] },
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
async function smoke(executablePath, directory, artifact) {
  const userData = join(directory, 'user-data');
  await mkdir(userData);
  const env = { ...process.env, CANOPY_USER_DATA: userData };
  // Keep inherited development/demo controls out of the first-run check.
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith('CANOPY_') && key !== 'CANOPY_USER_DATA') ||
      key === 'ELECTRON_RUN_AS_NODE'
    )
      delete env[key];
  }
  let app;
  let page;
  const errors = [];
  try {
    for (const restart of [false, true]) {
      app = await electron.launch({ executablePath, env, timeout: 30000 });
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
  const directory = await mkdtemp(join(tmpdir(), 'canopy-packaged-'));
  try {
    await access(artifact);
    const executable = await extract(artifact, format, directory);
    await access(executable);
    await smoke(executable, directory, name);
    results.push({
      artifact: name,
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
