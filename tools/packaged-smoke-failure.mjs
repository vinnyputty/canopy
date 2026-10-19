import assert from 'node:assert/strict';
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real gate against disposable copies of the macOS downloads.
// Product sources, original artifacts, profiles, and credentials stay untouched.
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    'The packaged startup-error fixture requires macOS arm64 downloads.',
  );
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = libRequire('@electron/asar');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const zipName = `Canopy-${version}-mac-arm64.zip`;
const dmgName = `Canopy-${version}-mac-arm64.dmg`;
const original = join(workspace, 'release');
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const originalHashes = await Promise.all(
  [dmgName, zipName].map((name) => hash(join(original, name))),
);
const results = [];
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command}: ${result.stdout}\n${result.stderr}`,
  );
}
for (const failingLaunch of [1, 2]) {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-packaged-failure-'));
  const marker = `CANOPY_EARLY_STARTUP_EXCEPTION_${failingLaunch}`;
  try {
    const release = join(directory, 'release');
    const unpacked = join(directory, 'unpacked');
    await mkdir(release);
    await mkdir(unpacked);
    await cp(join(original, dmgName), join(release, dmgName));
    run('ditto', ['-x', '-k', join(original, zipName), unpacked]);
    const archive = join(
      unpacked,
      'Canopy.app',
      'Contents',
      'Resources',
      'app.asar',
    );
    const source = join(directory, 'asar-source');
    asar.extractAll(archive, source);
    const html = join(source, 'dist', 'renderer', 'index.html');
    await writeFile(
      html,
      (await readFile(html, 'utf8')).replace(
        '<script src="app.js">',
        '<script src="startup-error.js"></script><script src="app.js">',
      ),
    );
    await writeFile(
      join(source, 'dist', 'renderer', 'startup-error.js'),
      `
      const launch = Number(localStorage.getItem('canopy-startup-fixture') || 0) + 1;
      localStorage.setItem('canopy-startup-fixture', String(launch));
      if (launch === ${failingLaunch}) throw new Error(${JSON.stringify(marker)});
    `,
    );
    await rm(archive);
    await asar.createPackage(source, archive);
    run('ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      join(unpacked, 'Canopy.app'),
      join(release, zipName),
    ]);
    const probe = join(directory, 'probe.jsonl');
    const loader = join(directory, 'delay-first-window.mjs');
    // Wait for the real UI before returning firstWindow(), so the injected parser
    // exception deterministically precedes the gate's live pageerror listener.
    await writeFile(
      loader,
      `
      import playwright from ${JSON.stringify(pathToFileURL(require.resolve('@playwright/test')).href)};
      const { _electron } = playwright;
      import { appendFileSync } from 'node:fs';
      const launch = _electron.launch.bind(_electron);
      _electron.launch = async (...args) => {
        const app = await launch(...args);
        const firstWindow = app.firstWindow.bind(app);
        app.firstWindow = async (...args) => {
          const page = await firstWindow(...args);
          await page.getByRole('heading', { name: 'See the whole tree.' }).waitFor();
          const retained = (await page.pageErrors()).map(error => error.message);
          const live = [];
          page.on('pageerror', error => live.push(error.message));
          page.on('close', () => appendFileSync(${JSON.stringify(probe)}, JSON.stringify({retained, live}) + '\\n'));
          return page;
        };
        return app;
      };
    `,
    );
    const verified = join(directory, '.cache', 'verified-packages');
    await mkdir(verified, { recursive: true });
    await writeFile(
      join(verified, 'stale-artifact'),
      'Must not survive a failed gate.',
    );
    const child = spawnSync(
      process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
      ['--import', loader, join(root, 'tools', 'packaged-smoke.mjs')],
      {
        env: { ...process.env, BUILD_WORKSPACE_DIRECTORY: directory },
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    if (child.error) throw child.error;
    assert.notEqual(
      child.status,
      0,
      'Startup exception incorrectly passed the artifact gate.',
    );
    assert.notEqual(
      child.status,
      null,
      `Gate exited by signal: ${child.signal}`,
    );
    const diagnostics = JSON.parse(
      await readFile(
        join(directory, '.cache', 'smoke-failure', zipName, 'failure.json'),
        'utf8',
      ).catch((error) => {
        throw new Error(
          `Missing gate diagnostic: ${child.stdout}\n${child.stderr}`,
          { cause: error },
        );
      }),
    );
    assert(
      diagnostics.errors.includes(marker),
      `Wrong failure: ${child.stdout}\n${child.stderr}`,
    );
    const observations = (await readFile(probe, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const early = observations.filter((item) => item.retained.includes(marker));
    assert.equal(
      early.length,
      1,
      'Fixture did not record the early exception.',
    );
    assert.deepEqual(
      early[0].live,
      [],
      'Exception reached the late live listener; retention was not exercised.',
    );
    await assert.rejects(access(verified), { code: 'ENOENT' });
    results.push({
      failingLaunch,
      marker,
      exceptionBeforeLiveListener: true,
      exitCode: child.status,
      verifiedArtifactsAbsent: true,
    });
    console.log(
      `Early startup exception on ZIP launch ${failingLaunch} blocked verified artifacts (real packaged UI; live capture missed it).`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
assert.deepEqual(
  await Promise.all(
    [dmgName, zipName].map((name) => hash(join(original, name))),
  ),
  originalHashes,
);
await mkdir(join(workspace, '.cache'), { recursive: true });
await writeFile(
  join(workspace, '.cache', 'packaged-smoke-regression.json'),
  JSON.stringify(
    {
      commit: process.env.GITHUB_SHA,
      results,
      originalArtifactsUnchanged: true,
    },
    null,
    2,
  ),
);
