import assert from 'node:assert/strict';
import { createHash as hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  process.env.CANOPY_CI_ENVIRONMENT_SOURCE ??
    new URL('../tools/ci.mjs', import.meta.url),
  'utf8',
);
const body = source.slice(source.indexOf('const cwd ='));
const cacheName = 'PSModuleAnalysisCachePath';
const cache = '/controlled cache/fixture-analysis-file';
const secret = 'UNRELATED_FIXTURE_SECRET';
const revision = 'review-fixture-revision';
const workspace = '/fixture source';
const evidenceFiles = new Map<string, Buffer>([
  [
    join(workspace, '.cache/typography/measurements.json'),
    Buffer.from('{"font":"system"}\n'),
  ],
  [
    join(workspace, '.cache/typography/nested/screen.png'),
    Buffer.from([0, 255, 42]),
  ],
  [
    join(workspace, '.cache/accessibility/rendered-contrast.json'),
    Buffer.from('{"ratio":7}\n'),
  ],
  [join(workspace, '.cache/tree.png'), Buffer.from([1, 2, 3, 4])],
  [join(workspace, '.cache/preview.png'), Buffer.from([5, 6, 7])],
]);
const evidenceDirectories = new Map<
  string,
  Array<{ name: string; directory?: boolean }>
>([
  [
    join(workspace, '.cache/typography'),
    [{ name: 'measurements.json' }, { name: 'nested', directory: true }],
  ],
  [join(workspace, '.cache/typography/nested'), [{ name: 'screen.png' }]],
  [
    join(workspace, '.cache/accessibility'),
    [{ name: 'rendered-contrast.json' }],
  ],
]);

type RunOptions = {
  failSmokeAt?: number;
  evidenceFailure?: 'listing' | 'missing' | 'read' | 'write';
};

type Call = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};
async function run(
  platform: string,
  parent: Record<string, string | undefined>,
  options: RunOptions = {},
) {
  const calls: Call[] = [];
  const written = new Map<string, string>();
  let smokeCount = 0;
  let error: unknown;
  try {
    await runInNewContext(`(async () => { ${body} })()`, {
      process: {
        platform,
        arch: 'fixture',
        argv: ['node', 'ci', '--ignore_all_rc_files'],
        env: { GITHUB_SHA: revision, ...parent },
        cwd: () => '/fixture source',
        exit: (status: number) => {
          throw new Error(`process.exit(${status})`);
        },
      },
      console: {
        error: () => {
          if (!options.failSmokeAt) throw new Error('unexpected log');
        },
      },
      runCimModuleControls: () => {},
      runCimContextControls: async () => {},
      spawnSync: (
        command: string,
        args: string[],
        spawnOptions: { env: Record<string, string>; cwd: string },
      ) => {
        calls.push({
          command,
          args: Array.from(args),
          env: { ...spawnOptions.env },
          cwd: spawnOptions.cwd,
        });
        if (args.includes('//:smoke')) smokeCount += 1;
        return {
          status:
            options.failSmokeAt === smokeCount && args.includes('//:smoke')
              ? 1
              : 0,
        };
      },
      createHash: (algorithm: string) => hash(algorithm),
      mkdir: async () => {},
      readdir: async (directory: string) => {
        if (
          options.evidenceFailure === 'listing' &&
          directory === join(workspace, '.cache/accessibility')
        ) {
          throw new Error('fixture evidence listing failure');
        }
        const entries = evidenceDirectories.get(directory);
        if (!entries) throw new Error(`ENOENT: ${directory}`);
        return entries.map(({ name, directory: isDirectory }) => ({
          name,
          isDirectory: () => Boolean(isDirectory),
          isFile: () => !isDirectory,
        }));
      },
      readFile: async (file: string) => {
        if (
          options.evidenceFailure === 'missing' &&
          file === join(workspace, '.cache/preview.png')
        ) {
          throw new Error(`ENOENT: ${file}`);
        }
        if (
          options.evidenceFailure === 'read' &&
          file === join(workspace, '.cache/tree.png')
        ) {
          throw new Error('fixture evidence read failure');
        }
        const contents = evidenceFiles.get(file);
        if (!contents) throw new Error(`ENOENT: ${file}`);
        return contents;
      },
      writeFile: async (file: string, contents: string) => {
        if (
          options.evidenceFailure === 'write' &&
          file === join(workspace, '.cache/ui-review-evidence.json')
        ) {
          throw new Error('fixture manifest write failure');
        }
        written.set(file, contents);
      },
      join,
      relative,
      Buffer,
    });
  } catch (caught) {
    error = caught;
  }
  const testCall = calls.find((call) => call.args.includes('test'));
  assert.ok(testCall);
  assert.ok(
    calls.every(
      (call) =>
        call.args[0] === '--ignore_all_rc_files' || call.command === 'xvfb-run',
    ),
  );
  assert.equal(testCall.cwd, '/fixture source');
  assert.ok(testCall.args.includes('--local_test_jobs=1'));
  assert.ok(
    testCall.args.includes('//:test') &&
      testCall.args.includes('//:portable_checks'),
  );
  assert.equal(parent.USER_SECRET, secret);
  assert.ok(!JSON.stringify(calls.map((call) => call.args)).includes(secret));
  assert.ok(!JSON.stringify(calls.map((call) => call.args)).includes(cache));
  assert.equal(testCall.env.JS_BINARY__NODE_BINARY, undefined);
  assert.equal(testCall.env.RUNFILES_DIR, undefined);
  return { calls, testCall, written, error };
}

for (const key of [
  cacheName,
  cacheName.toUpperCase(),
  cacheName.toLowerCase(),
]) {
  test(`actual CI launcher forwards only a configured cache name (${key}) to test consumers`, async () => {
    const parent = {
      [key]: cache,
      USER_SECRET: secret,
      PSModulePath: 'fixture-PS7',
      JS_BINARY__NODE_BINARY: 'fixture-parent-node',
      RUNFILES_DIR: 'fixture-parent-runfiles',
    };
    const { calls, testCall } = await run('win32', parent);
    assert.deepEqual(
      testCall.args.filter((arg) => arg.startsWith('--test_env')),
      ['--test_env=PSModuleAnalysisCachePath'],
    );
    assert.equal(testCall.env[cacheName], cache);
    assert.equal(
      Object.keys(testCall.env).filter(
        (name) => name.toUpperCase() === cacheName.toUpperCase(),
      ).length,
      1,
    );
    // This models the exact key-only Bazel resolution, not native Windows execution.
    const consumer: Record<string, string> = {};
    for (const arg of testCall.args.filter((arg) =>
      arg.startsWith('--test_env='),
    )) {
      const name = arg.slice('--test_env='.length);
      assert.equal(name.includes('='), false);
      consumer[name] = testCall.env[name];
    }
    assert.equal(consumer[cacheName], cache);
    assert.equal(Boolean(consumer[cacheName]), true);
    assert.equal(consumer.PSModulePath, undefined);
    assert.equal(consumer.USER_SECRET, undefined);
    assert.ok(
      calls
        .filter((call) => call !== testCall)
        .every(
          (call) => !call.args.some((arg) => arg.startsWith('--test_env')),
        ),
    );
    assert.equal(parent[key], cache);
  });
}

for (const value of [undefined, '']) {
  test(`actual Windows CI leaves ${value === undefined ? 'unset' : 'empty'} cache configuration unforwarded`, async () => {
    const { testCall } = await run('win32', {
      [cacheName]: value,
      USER_SECRET: secret,
    });
    assert.ok(!testCall.args.some((arg) => arg.startsWith('--test_env')));
  });
}

for (const platform of ['darwin', 'linux']) {
  test(`actual CI retains ${platform} command policy without forwarding Windows environment`, async () => {
    const { testCall } = await run(platform, {
      [cacheName]: cache,
      USER_SECRET: secret,
    });
    assert.ok(!testCall.args.some((arg) => arg.startsWith('--test_env')));
  });
}

for (const [platform, display] of [
  ['darwin', undefined],
  ['win32', undefined],
  ['linux', undefined],
  ['linux', ':fixture'],
] as const) {
  test(`actual CI orders typography and accessibility evidence after full smoke on ${platform} with ${display ?? 'no display'}`, async () => {
    const parent = {
      USER_SECRET: secret,
      DISPLAY: display,
      CANOPY_SMOKE_ACCESSIBILITY_ONLY: '1',
      CANOPY_SMOKE_TYPOGRAPHY_ONLY: '1',
      CANOPY_SMOKE_SIDEBAR_ONLY: '1',
      CANOPY_SMOKE_TEST_DIAGNOSTICS: '1',
      JS_BINARY__NODE_BINARY: 'fixture-parent-node',
      RUNFILES_DIR: 'fixture-parent-runfiles',
    };
    const { calls, written } = await run(platform, parent);
    const smokeCalls = calls.filter((call) => call.args.includes('//:smoke'));
    assert.equal(smokeCalls.length, 3);
    assert.equal(smokeCalls[0].env.CANOPY_SMOKE_ACCESSIBILITY_ONLY, undefined);
    assert.equal(smokeCalls[0].env.CANOPY_SMOKE_TYPOGRAPHY_ONLY, undefined);
    assert.equal(smokeCalls[0].env.CANOPY_SMOKE_SIDEBAR_ONLY, undefined);
    assert.equal(smokeCalls[0].env.CANOPY_SMOKE_TEST_DIAGNOSTICS, undefined);
    assert.equal(smokeCalls[1].env.CANOPY_SMOKE_ACCESSIBILITY_ONLY, '1');
    assert.equal(smokeCalls[1].env.CANOPY_SMOKE_TYPOGRAPHY_ONLY, undefined);
    assert.equal(smokeCalls[2].env.CANOPY_SMOKE_ACCESSIBILITY_ONLY, undefined);
    assert.equal(smokeCalls[2].env.CANOPY_SMOKE_TYPOGRAPHY_ONLY, '1');
    assert.equal(smokeCalls[2].env.CANOPY_SMOKE_SIDEBAR_ONLY, undefined);
    assert.equal(smokeCalls[2].env.CANOPY_SMOKE_TEST_DIAGNOSTICS, undefined);
    assert.equal(
      calls.filter((call) => call.env.CANOPY_SMOKE_ACCESSIBILITY_ONLY === '1')
        .length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.env.CANOPY_SMOKE_TYPOGRAPHY_ONLY === '1')
        .length,
      1,
    );
    assert.deepEqual(
      calls
        .filter((call) => call.args.includes('run'))
        .map((call) => call.args.slice(call.args.indexOf('run') + 1)),
      [
        ['//:branding_smoke'],
        ['//:smoke'],
        ['//:smoke'],
        ['//:smoke'],
        ['//:demo_check'],
        ['//:instance_check', '--', '--state-only'],
        ['//:package'],
      ],
    );
    for (const call of smokeCalls) {
      assert.equal(call.env.JS_BINARY__NODE_BINARY, undefined);
      assert.equal(call.env.RUNFILES_DIR, undefined);
      assert.equal(call.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
      assert.equal(call.cwd, '/fixture source');
      assert.deepEqual(
        call.args,
        platform === 'linux' && !display
          ? ['-a', 'bazel', '--ignore_all_rc_files', 'run', '//:smoke']
          : ['--ignore_all_rc_files', 'run', '//:smoke'],
      );
      assert.equal(
        call.command,
        platform === 'linux' && !display ? 'xvfb-run' : 'bazel',
      );
    }
    const manifest = written.get(
      join(workspace, '.cache/ui-review-evidence.json'),
    );
    assert.ok(manifest);
    const recorded = JSON.parse(manifest) as {
      sourceRevision: string;
      platform: string;
      evidence: Array<{ file: string; sha256: string; bytes: number }>;
    };
    assert.equal(recorded.sourceRevision, revision);
    assert.equal(recorded.platform, `${platform}-fixture`);
    assert.deepEqual(
      recorded.evidence,
      [...evidenceFiles]
        .map(([file, contents]) => ({
          file: relative(workspace, file).replaceAll('\\', '/'),
          sha256: hash('sha256').update(contents).digest('hex'),
          bytes: contents.length,
        }))
        .sort((left, right) => left.file.localeCompare(right.file)),
    );
    assert.equal(parent.CANOPY_SMOKE_ACCESSIBILITY_ONLY, '1');
    assert.equal(parent.CANOPY_SMOKE_TYPOGRAPHY_ONLY, '1');
  });
}

for (const [platform, display] of [
  ['darwin', undefined],
  ['win32', undefined],
  ['linux', undefined],
  ['linux', ':fixture'],
] as const) {
  for (const failSmokeAt of [1, 2, 3]) {
    test(`actual CI stops after smoke ${failSmokeAt} failure on ${platform} with ${display ?? 'no display'}`, async () => {
      const { calls, error } = await run(
        platform,
        { DISPLAY: display, USER_SECRET: secret },
        { failSmokeAt },
      );
      assert.match(String(error), /process\.exit\(1\)/);
      const smokeCalls = calls.filter((call) => call.args.includes('//:smoke'));
      assert.equal(smokeCalls.length, failSmokeAt);
      assert.ok(!calls.some((call) => call.args.includes('//:demo_check')));
      assert.ok(!calls.some((call) => call.args.includes('//:package')));
    });
  }
}

for (const evidenceFailure of [
  'listing',
  'missing',
  'read',
  'write',
] as const) {
  test(`actual CI stops before packaging after evidence ${evidenceFailure} failure`, async () => {
    const { calls, error } = await run(
      'darwin',
      { USER_SECRET: secret },
      { evidenceFailure },
    );
    assert.match(String(error), /fixture evidence|ENOENT|fixture manifest/);
    assert.ok(!calls.some((call) => call.args.includes('//:package')));
  });
}

test('Windows cache aliases follow Node sorted-first semantics without stale aliases', async () => {
  const { testCall } = await run('win32', {
    PSMODULEANALYSISCACHEPATH: cache,
    PSModuleAnalysisCachePath: 'stale fixture override',
    USER_SECRET: secret,
  });
  assert.equal(testCall.env[cacheName], cache);
  assert.deepEqual(
    testCall.args.filter((arg) => arg.startsWith('--test_env')),
    ['--test_env=PSModuleAnalysisCachePath'],
  );
  const { testCall: emptyFirst } = await run('win32', {
    PSMODULEANALYSISCACHEPATH: '',
    PSModuleAnalysisCachePath: cache,
    USER_SECRET: secret,
  });
  assert.ok(!emptyFirst.args.some((arg) => arg.startsWith('--test_env')));
});

test('an unrelated undefined-name environment key cannot become a cache override', async () => {
  const { testCall } = await run('win32', {
    undefined: secret,
    USER_SECRET: secret,
  });
  assert.ok(!testCall.args.some((arg) => arg.startsWith('--test_env')));
  assert.equal(testCall.env[cacheName], undefined);
});
