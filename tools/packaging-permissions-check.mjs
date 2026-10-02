import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingConfig } from './windows-signing.mjs';
import { checkWindowsBuilderSigning } from './windows-builder-check.mjs';
import { checkDesktopEntry } from './linux-package-check.mjs';

export async function checkPackagingPermissions() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(join(tmpdir(), 'canopy-permissions-'));
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const lib = (name) => builderRequire(`app-builder-lib/out/${name}`);
  const { getConfig } = lib('util/config/config.js');
  const { getFileMatchers, copyFiles } = lib('fileMatcher.js');
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  const launcher = await readFile(join(root, 'tools', 'AppRun'));
  const source = await readFile(join(root, 'tools', 'desktop.mjs'), 'utf8');
  const optionsStart = source.indexOf(
    '    config: {',
    source.indexOf('  await build({'),
  );
  const optionsEnd = source.indexOf('\n    publish:', optionsStart);
  assert(optionsStart >= 0 && optionsEnd > optionsStart);
  const options = new Function(
    'version',
    'workspace',
    'join',
    'signingConfig',
    'process',
    'manifest',
    'sign',
    `return ({${source.slice(optionsStart, optionsEnd)}}).config;`,
  );
  const stagingStart = source.lastIndexOf(
    "  if (process.platform === 'linux') {",
  );
  const stagingEnd = source.indexOf('  const { default: sign', stagingStart);
  assert(stagingStart >= 0 && stagingEnd > stagingStart);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const stageLauncher = new AsyncFunction(
    'process',
    'root',
    'staging',
    'mkdir',
    'writeFile',
    'readFile',
    'join',
    source.slice(stagingStart, stagingEnd),
  );
  const matchers = (config, project, output) =>
    getFileMatchers(config, 'extraFiles', output, {
      defaultSrc: project,
      customBuildOptions: config.linux,
      macroExpander: (value) => value,
      globalOutDir: join(directory, 'release'),
    });
  const mode = async (path) => (await stat(path)).mode & 0o777;
  try {
    const inputs = join(directory, 'inputs');
    await mkdir(join(inputs, 'tools'), { recursive: true });
    await writeFile(join(inputs, 'tools', 'AppRun'), launcher, { mode: 0o555 });
    const project = join(directory, 'project');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), JSON.stringify(manifest));
    const oldConfig = await getConfig(project, null, {
      ...structuredClone(manifest.build),
    });
    const oldOutput = join(directory, 'readonly-output');
    await mkdir(oldOutput);
    const oldMatchers = matchers(oldConfig, inputs, oldOutput);
    assert.equal(
      oldMatchers.length,
      2,
      'Duplicated API/manifest configuration must reproduce the collision',
    );
    await copyFiles([oldMatchers[0]]);
    if (process.platform !== 'win32')
      assert.equal(await mode(join(oldOutput, 'AppRun')), 0o555);
    // Sequential replay makes the real read-only overwrite failure deterministic.
    // Windows ACLs do not implement Unix write bits; run this mode probe on Unix.
    if (process.platform !== 'win32') {
      await assert.rejects(copyFiles([oldMatchers[1]]), { code: 'EACCES' });
    }
    const inputMode = await mode(join(inputs, 'tools', 'AppRun'));
    await stageLauncher(
      { platform: 'linux' },
      inputs,
      project,
      mkdir,
      writeFile,
      readFile,
      join,
    );
    assert.equal(
      await mode(join(inputs, 'tools', 'AppRun')),
      inputMode,
      'Bazel input permissions must stay unchanged',
    );
    if (process.platform !== 'win32')
      assert.equal(await mode(join(project, 'tools', 'AppRun')), 0o755);
    assert.deepEqual(
      await readFile(join(project, 'tools', 'AppRun')),
      launcher,
    );
    const config = await getConfig(
      project,
      null,
      options(
        manifest.devDependencies.electron,
        directory,
        join,
        signingConfig,
        { platform: 'linux', env: {} },
        manifest,
        () => {},
      ),
    );
    await checkWindowsBuilderSigning(builderRequire, lib, directory, manifest);
    const appDir = join(directory, 'app');
    await mkdir(appDir);
    const actualMatchers = matchers(config, project, appDir);
    assert.equal(
      actualMatchers.length,
      1,
      'Production config must copy the launcher once',
    );
    await copyFiles(actualMatchers);
    assert.deepEqual(await readFile(join(appDir, 'AppRun')), launcher);
    if (process.platform !== 'win32')
      assert.equal(await mode(join(appDir, 'AppRun')), 0o755);

    // Exercise the pinned builder through its package-emission boundary. Only
    // native tool discovery/compression/blockmap are stubbed; no runtime launch.
    const { LinuxTargetHelper } = lib('targets/LinuxTargetHelper.js');
    const { default: AppImageTarget } = lib(
      'targets/appimage/AppImageTarget.js',
    );
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
    const desktop = await new AppImageTarget(
      'AppImage',
      packager,
      new LinuxTargetHelper(packager),
      directory,
    ).desktopEntry.value;
    checkDesktopEntry(desktop, 'AppRun');
    const stageDir = join(directory, 'image-stage');
    await mkdir(stageDir);
    const icon = join(directory, 'icon.svg');
    await writeFile(icon, '<svg/>');
    const runtime = join(directory, 'runtime');
    await writeFile(runtime, 'fixture runtime, not a distributable package');
    const libraries = join(directory, 'libraries');
    await mkdir(libraries);
    const tools = lib('toolsets/linux.js');
    const builder = builderRequire('builder-util');
    const blockmap = lib('targets/differentialUpdateInfoBuilder.js');
    const originals = {
      tools: tools.getAppImageTools,
      exec: builder.exec,
      blockmap: blockmap.appendBlockmap,
    };
    let checkedBoundary = false;
    try {
      tools.getAppImageTools = async () => ({
        runtime,
        runtimeLibraries: libraries,
        mksquashfs: 'fixture-compressor',
      });
      builder.exec = async (command, args) => {
        assert.equal(command, 'fixture-compressor');
        assert.deepEqual(await readFile(join(stageDir, 'AppRun')), launcher);
        if (process.platform !== 'win32')
          assert.equal(await mode(join(stageDir, 'AppRun')), 0o755);
        checkDesktopEntry(
          await readFile(join(stageDir, 'canopy.desktop'), 'utf8'),
          'AppRun',
        );
        checkedBoundary = true;
        await writeFile(args[1], Buffer.alloc(128));
      };
      blockmap.appendBlockmap = async () => ({});
      await lib('targets/appimage/appImageUtil.js').buildLegacyFuse2AppImage({
        appDir,
        stageDir,
        arch: builder.Arch.x64,
        output: join(directory, 'fixture.AppImage'),
        options: {
          productName: 'Canopy',
          productFilename: 'Canopy',
          executableName: 'canopy',
          desktopEntry: desktop,
          desktopBaseName: 'canopy',
          icons: [{ file: icon, size: 16 }],
          fileAssociations: [],
        },
      });
      assert(checkedBoundary);
    } finally {
      tools.getAppImageTools = originals.tools;
      builder.exec = originals.exec;
      blockmap.appendBlockmap = originals.blockmap;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
