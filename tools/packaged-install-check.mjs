import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDesktopEntry } from './linux-package-check.mjs';

// Execute the exact production install/validation/smoke/cleanup block with all
// external effects replaced. Never import the Electron entry or invoke dpkg.
export async function checkPackagedInstallCleanup() {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'packaged-smoke.mjs'),
    'utf8',
  );
  const start = source.indexOf('    let launchExecutable = executable;');
  const end = source.indexOf('    results.push({', start);
  assert(start !== -1 && end > start, 'Production install block not found');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    'dependencies',
    `const { process, executable, artifact, format, directory, name, root,
      createHash, dirname, join, readFile, run, checkDesktopEntry,
      linuxStartupEvidence, smoke, console, workspace, recordCanopyPolicy } = dependencies;
    ${source.slice(start, end)}
    return launches;`,
  );
  for (const scenario of [
    { name: 'local guard', env: {}, blocked: true },
    {
      name: 'self-hosted guard',
      env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
      blocked: true,
    },
    { name: 'dependency index failure', failure: 'dependencies-update' },
    { name: 'partial dependency preparation', failure: 'dependencies-install' },
    { name: 'partial install', failure: 'install' },
    { name: 'desktop read', failure: 'read' },
    { name: 'desktop mismatch', failure: 'desktop' },
    { name: 'installed diagnostics', failure: 'diagnostics' },
    { name: 'smoke', failure: 'smoke' },
    { name: 'cleanup', cleanupFailure: true },
    { name: 'success' },
  ].flatMap((scenario) =>
    scenario.failure && !scenario.failure.startsWith('dependencies-')
      ? [
          scenario,
          {
            ...scenario,
            name: `${scenario.name} and cleanup`,
            cleanupFailure: true,
          },
        ]
      : [scenario],
  )) {
    const calls = [];
    const logs = [];
    const policyCalls = [];
    const primary = new Error(scenario.name);
    const cleanup = new Error('cleanup failure');
    let desktopError;
    let partialDependencies = false;
    const fail = (stage) => {
      if (scenario.failure === stage) throw primary;
    };
    const dependencies = {
      process: {
        platform: 'linux',
        env: scenario.env ?? {
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
        },
      },
      executable: '/extracted/canopy',
      artifact: '/release/canopy.deb',
      format: 'deb',
      directory: '/temporary',
      name: 'canopy.deb',
      root: '/source',
      workspace: '/workspace',
      recordCanopyPolicy: async (path, phase) => {
        policyCalls.push({ path, phase, calls: [...calls] });
      },
      createHash,
      dirname,
      join,
      readFile: async (path) => {
        if (path === '/usr/share/applications/canopy.desktop') {
          calls.push('read');
          fail('read');
          return `[Desktop Entry]\nExec=${scenario.failure === 'desktop' ? '/incorrect' : '/opt/Canopy/canopy'} %U\n`;
        }
        return Buffer.from('inspected payload');
      },
      run: (command, args) => {
        assert.equal(command, 'sudo');
        if (args[1] === 'apt-get') {
          const stage = `dependencies-${args[2]}`;
          assert.deepEqual(
            args,
            args[2] === 'update'
              ? ['-n', 'apt-get', 'update']
              : [
                  '-n',
                  'apt-get',
                  'install',
                  '--yes',
                  '--no-install-recommends',
                  'libnotify4',
                  'libsecret-1-0',
                  'libfuse2t64',
                ],
          );
          calls.push(stage);
          if (stage === 'dependencies-install' && scenario.failure === stage)
            partialDependencies = true;
          fail(stage);
          return;
        }
        assert.deepEqual(args.slice(0, 2), ['-n', 'dpkg']);
        const stage = args[2] === '--install' ? 'install' : 'remove';
        assert.deepEqual(
          args,
          stage === 'install'
            ? ['-n', 'dpkg', '--install', '/release/canopy.deb']
            : ['-n', 'dpkg', '--remove', 'canopy'],
        );
        calls.push(stage);
        fail(stage);
        if (stage === 'remove' && scenario.cleanupFailure) throw cleanup;
      },
      checkDesktopEntry: (...args) => {
        calls.push('desktop');
        try {
          checkDesktopEntry(...args);
        } catch (error) {
          desktopError = error;
          throw error;
        }
      },
      linuxStartupEvidence: async () => {
        calls.push('diagnostics');
        fail('diagnostics');
      },
      smoke: async () => {
        calls.push('smoke');
        fail('smoke');
        return ['passed'];
      },
      console: { error: (...args) => logs.push(args) },
    };
    let error;
    let result;
    try {
      result = await execute(dependencies);
    } catch (caught) {
      error = caught;
    }
    if (scenario.blocked) {
      assert.match(
        error?.message ?? '',
        /requires a disposable GitHub-hosted runner/,
      );
      assert.deepEqual(calls, [], scenario.name);
      assert.deepEqual(policyCalls, []);
    } else if (scenario.failure?.startsWith('dependencies-')) {
      assert.deepEqual(
        calls,
        scenario.failure === 'dependencies-update'
          ? ['dependencies-update']
          : ['dependencies-update', 'dependencies-install'],
      );
      assert.equal(error, primary);
      assert.deepEqual(policyCalls, []);
      assert.equal(
        partialDependencies,
        scenario.failure === 'dependencies-install',
      );
      assert.deepEqual(logs, []);
      assert.equal(result, undefined);
    } else {
      assert.equal(calls[0], 'dependencies-update', scenario.name);
      assert.equal(calls.at(-1), 'remove', scenario.name);
      assert.equal(calls.filter((call) => call === 'remove').length, 1);
      assert.deepEqual(
        policyCalls.map((call) => call.phase),
        ['before DEB removal', 'after DEB removal attempt'],
      );
      assert.notEqual(policyCalls[0].calls.at(-1), 'remove');
      assert.equal(policyCalls[1].calls.at(-1), 'remove');
      const expected = {
        install: ['install', 'remove'],
        read: ['install', 'read', 'remove'],
        desktop: ['install', 'read', 'desktop', 'remove'],
        diagnostics: ['install', 'read', 'desktop', 'diagnostics', 'remove'],
        smoke: ['install', 'read', 'desktop', 'diagnostics', 'smoke', 'remove'],
      };
      assert.deepEqual(
        calls,
        [
          'dependencies-update',
          'dependencies-install',
          ...(expected[scenario.failure] ?? expected.smoke),
        ],
        scenario.name,
      );
      if (scenario.failure)
        assert.equal(
          error,
          scenario.failure === 'desktop' ? desktopError : primary,
          scenario.name,
        );
      else if (scenario.cleanupFailure) assert.equal(error, cleanup);
      else {
        assert.equal(error, undefined);
        assert.deepEqual(result, ['passed']);
      }
      if (scenario.failure && scenario.cleanupFailure)
        assert.equal(logs[0]?.[1], cleanup);
      else assert.deepEqual(logs, []);
    }
  }
}
