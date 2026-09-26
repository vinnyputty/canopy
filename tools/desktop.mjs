import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
// Stage the hermetic bundle in a writable directory for Electron and packaging.
const cache = join(workspace, '.cache');
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(join(cache, 'desktop-'));
const stagedDist = join(staging, 'dist');
await cp(join(root, 'dist'), stagedDist, {
  recursive: true,
  dereference: true,
});
const mode = process.argv[2];
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (mode === 'smoke') manifest.main = 'dist/smoke-main.cjs';
delete manifest.dependencies;
delete manifest.devDependencies;
delete manifest.packageManager;
await writeFile(join(staging, 'package.json'), JSON.stringify(manifest));
if (
  mode === 'dev' ||
  mode === 'demo' ||
  mode === 'demo-check' ||
  mode === 'smoke' ||
  mode === 'smoke-github'
) {
  // Electron's platform archive is a runtime download, outside Bazel actions.
  const { downloadArtifact } = await import('@electron/get');
  const extract = require('extract-zip');
  const { version } = require('electron/package.json');
  const runtime = join(
    tmpdir(),
    `canopy-electron-${version}-${process.platform}-${process.arch}`,
  );
  const executable = join(
    runtime,
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron',
  );
  const { existsSync } = require('node:fs');
  if (!existsSync(executable)) {
    const archive = await downloadArtifact({
      version,
      artifactName: 'electron',
      platform: process.platform,
      arch: process.arch,
    });
    await extract(archive, { dir: runtime });
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const demoData =
    mode === 'demo' ? await mkdtemp(join(tmpdir(), 'canopy-demo-')) : null;
  const result =
    mode === 'smoke' || mode === 'smoke-github' || mode === 'demo-check'
      ? spawnSync(
          process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
          [
            join(
              root,
              'tools',
              mode === 'smoke'
                ? 'smoke.mjs'
                : mode === 'demo-check'
                  ? 'demo-check.mjs'
                  : 'smoke-github-cli.mjs',
            ),
          ],
          {
            stdio: 'inherit',
            cwd: root,
            env: {
              ...env,
              CANOPY_APP_PATH: staging,
              CANOPY_ELECTRON_PATH: executable,
            },
          },
        )
      : spawnSync(
          executable,
          [staging, ...(mode === 'demo' ? ['--canopy-demo'] : [])],
          {
            stdio: 'inherit',
            env: demoData
              ? { ...env, CANOPY_USER_DATA: demoData, CANOPY_DEMO_TEMP: '1' }
              : env,
          },
        );
  if (demoData) await rm(demoData, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const nodeBinary = await realpath(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
  );
  process.env.PATH = `${dirname(nodeBinary)}${delimiter}${process.env.PATH ?? ''}`;
  const { build } = require('electron-builder');
  const { version } = require('electron/package.json');
  await build({
    projectDir: staging,
    config: {
      ...manifest.build,
      electronVersion: version,
      npmRebuild: false,
      directories: { output: join(workspace, 'release') },
    },
    publish: 'never',
  });
}
