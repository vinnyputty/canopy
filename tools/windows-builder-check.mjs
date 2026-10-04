import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fixtureEnv, fixtureSignature } from './windows-signing-fixture.mjs';
import { signWithService, signingConfig } from './windows-signing.mjs';
import { nsisGuid } from './windows-lifecycle.mjs';

// Actual pinned WinPackager + NSIS build/sign call paths. Only native resource editing,
// compression, makensis and uninstaller extraction are replaced with owned synthetic bytes.
export async function checkWindowsBuilderSigning(
  builderRequire,
  lib,
  directory,
  manifest,
) {
  builderRequire('app-builder-lib'); // Initialize the public entry before loading packager subclasses.
  const { WindowsSignToolManager } = lib('codeSign/windowsSignToolManager.js');
  const { WinPackager } = lib('winPackager.js');
  const { NsisTarget } = lib('targets/nsis/NsisTarget.js');
  const { UUID, CancellationToken } = builderRequire('builder-util-runtime');
  const { Arch } = builderRequire('builder-util');
  assert.equal(
    nsisGuid(manifest.build.appId),
    UUID.v5(
      manifest.build.appId,
      UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'),
    ),
  );
  assert.equal(
    lib('targets/targetUtil.js').getWindowsInstallationDirName(
      { productFilename: 'Canopy' },
      true,
    ),
    'Canopy',
  );
  const digest = createHash('sha256').update('fixture').digest('hex');
  let rejectAt;
  const calls = [];
  const env = {
    ...fixtureEnv,
    GITHUB_REF: `refs/tags/v${manifest.version}`,
    GITHUB_WORKFLOW_REF: `vinnyputty/canopy/.github/workflows/ci.yml@refs/tags/v${manifest.version}`,
  };
  const hook = async (task) => {
    calls.push(basename(task.path));
    assert.equal(task.hash, 'sha256');
    await signWithService(task.path, manifest.version, {
      env,
      platform: 'win32',
      source: () => {},
      run: (request) => {
        assert.equal(request.args[0], 'sign');
        assert.equal(
          request.args[request.args.indexOf('/dlib') + 1],
          env.CANOPY_SIGN_DLIB,
        );
        if (rejectAt && basename(task.path).includes(rejectAt))
          throw new Error('fixture signing failure');
        return { ok: true, ownedAbsent: true };
      },
      inspect: () => fixtureSignature(digest),
    });
  };
  const signing = signingConfig(env, 'win32', manifest.version, hook);
  await lib('util/config/config.js').validateConfiguration(
    {
      ...manifest.build,
      ...signing,
      win: { ...manifest.build.win, ...signing.win },
    },
    null,
  );
  const packager = {
    platformSpecificBuildOptions: signing.win,
    config: { ...manifest.build, win: signing.win },
    forceCodeSigning: true,
    signingQueue: Promise.resolve(),
    projectDir: directory,
    compression: 'store',
    packagerOptions: {},
    appInfo: {
      id: manifest.build.appId,
      productFilename: 'Canopy',
      productName: 'Canopy',
      sanitizedName: 'Canopy',
      name: 'canopy',
      version: manifest.version,
      buildVersion: manifest.version,
      copyright: 'fixture copyright',
      type: 'commonjs',
      description: manifest.description,
      updaterCacheDirName: 'canopy-updater',
      getVersionInWeirdWindowsForm: () => `${manifest.version}.0`,
      computePackageUrl: async () => manifest.homepage,
    },
    info: {
      metadata: manifest,
      buildResourcesDir: directory,
      cancellationToken: new CancellationToken(),
      getWorkspaceRoot: async () => directory,
      emitArtifactBuildStarted: async () => {},
      emitArtifactBuildCompleted: async () => {},
    },
    getCscLink: () => null,
    getResource: async () => null,
    getIconPath: async () => null,
    expandArtifactNamePattern: () => 'Canopy-setup.exe',
    expandMacro: () => `Canopy ${manifest.version}`,
    shouldSignFile: WinPackager.prototype.shouldSignFile,
    _sign: WinPackager.prototype._sign,
    signIf: WinPackager.prototype.signIf,
    signAndEditResources: async (file) => packager.signIf(file),
  };
  packager.signingManager = {
    value: Promise.resolve(new WindowsSignToolManager(packager)),
  };
  const app = join(directory, 'mock-win-app');
  await mkdir(app);
  await writeFile(join(app, 'Canopy.exe'), 'fixture');
  const util = lib('targets/nsis/nsisUtil.js');
  const wine = lib('vm/WineVm.js').WineVmManager.prototype;
  const original = { extract: util.UninstallerReader.exec, wine: wine.exec };
  let uninstaller;
  const noNative = async () => {
    assert.ok(uninstaller);
    await writeFile(uninstaller, 'fixture');
  };
  util.UninstallerReader.exec = noNative;
  wine.exec = noNative;
  try {
    const build = async () => {
      const queue = [];
      const target = new NsisTarget(packager, directory, 'nsis', {
        refCount: 0,
        packArch: async () => ({
          fileInfo: {
            path: join(directory, 'app-64.7z'),
            sha512: Buffer.alloc(64).toString('base64'),
          },
          unpackedSize: 1,
        }),
      });
      target.options.differentialPackage = false;
      target.buildQueueManager = { add: (task) => queue.push(task) };
      target.computeCommonInstallerScriptHeader = async () => '';
      target.computeFinalScript = async (script) => script;
      target.executeMakensis = async (defines, commands) => {
        assert.equal(defines.APP_GUID, nsisGuid(manifest.build.appId));
        assert.equal(defines.APP_FILENAME, 'Canopy');
        if (Object.hasOwn(defines, 'BUILD_UNINSTALLER'))
          uninstaller = join(directory, 'Canopy-setup.__uninstaller.exe');
        await writeFile(commands.OutFile.slice(1, -1), 'fixture');
      };
      await WinPackager.prototype.signApp.call(
        packager,
        { appOutDir: app, arch: Arch.x64, outDir: directory },
        false,
      );
      await target.buildInstaller(new Map([[Arch.x64, app]]));
      for (const task of queue) await task();
    };
    await build();
    assert.deepEqual(calls, [
      'Canopy.exe',
      'Canopy-setup.__uninstaller.exe',
      'Canopy-setup.exe',
    ]);
    for (const phase of ['Canopy.exe', '__uninstaller', 'Canopy-setup.exe']) {
      calls.length = 0;
      rejectAt = phase;
      await assert.rejects(build(), /fixture signing failure/);
      if (phase === 'Canopy.exe') assert.deepEqual(calls, ['Canopy.exe']);
      else if (phase === '__uninstaller')
        assert.deepEqual(calls, [
          'Canopy.exe',
          'Canopy-setup.__uninstaller.exe',
        ]);
      else
        assert.deepEqual(calls, [
          'Canopy.exe',
          'Canopy-setup.__uninstaller.exe',
          'Canopy-setup.exe',
        ]);
    }
  } finally {
    util.UninstallerReader.exec = original.extract;
    wine.exec = original.wine;
  }
}
