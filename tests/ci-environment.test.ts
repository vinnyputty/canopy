import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

type Call = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};
async function run(
  platform: string,
  parent: Record<string, string | undefined>,
) {
  const calls: Call[] = [];
  await runInNewContext(`(async () => { ${body} })()`, {
    process: {
      platform,
      arch: 'fixture',
      argv: ['node', 'ci', '--ignore_all_rc_files'],
      env: parent,
      cwd: () => '/fixture source',
      exit: () => {
        throw new Error('unexpected exit');
      },
    },
    console: {
      error: () => {
        throw new Error('unexpected log');
      },
    },
    runCimModuleControls: () => {},
    runCimContextControls: async () => {},
    spawnSync: (
      command: string,
      args: string[],
      options: { env: Record<string, string>; cwd: string },
    ) => {
      calls.push({
        command,
        args: Array.from(args),
        env: { ...options.env },
        cwd: options.cwd,
      });
      return { status: 0 };
    },
  });
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
  return { calls, testCall };
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
  test(`actual CI isolates focused accessibility after full smoke on ${platform} with ${display ?? 'no display'}`, async () => {
    const parent = {
      USER_SECRET: secret,
      DISPLAY: display,
      CANOPY_SMOKE_ACCESSIBILITY_ONLY: '1',
      JS_BINARY__NODE_BINARY: 'fixture-parent-node',
      RUNFILES_DIR: 'fixture-parent-runfiles',
    };
    const { calls } = await run(platform, parent);
    const smokeCalls = calls.filter((call) => call.args.includes('//:smoke'));
    assert.equal(smokeCalls.length, 2);
    assert.equal(smokeCalls[0].env.CANOPY_SMOKE_ACCESSIBILITY_ONLY, undefined);
    assert.equal(smokeCalls[1].env.CANOPY_SMOKE_ACCESSIBILITY_ONLY, '1');
    assert.equal(
      calls.filter((call) => call.env.CANOPY_SMOKE_ACCESSIBILITY_ONLY === '1')
        .length,
      1,
    );
    assert.deepEqual(
      calls
        .filter((call) => call.args.includes('run'))
        .map((call) => call.args.at(-1)),
      ['//:smoke', '//:smoke', '//:demo_check', '//:package'],
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
    assert.equal(parent.CANOPY_SMOKE_ACCESSIBILITY_ONLY, '1');
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
