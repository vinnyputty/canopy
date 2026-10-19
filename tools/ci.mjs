import { spawnSync } from 'node:child_process';
import { runPackagedCheck } from './packaged-check-log.mjs';
import { runCimModuleControls } from './windows-cim-control.mjs';
import { runCimContextControls } from './windows-cim-input-control.mjs';

const cwd = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const startupOptions = process.argv.slice(2);
if (
  process.env.CANOPY_EXPECT_PLATFORM &&
  process.env.CANOPY_EXPECT_PLATFORM !== `${process.platform}/${process.arch}`
)
  throw new Error(
    `Runner platform mismatch: ${process.platform}/${process.arch}`,
  );
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
// Nested Bazel launchers must resolve their own runfiles and Node toolchain.
for (const key of Object.keys(env)) {
  if (key.startsWith('JS_BINARY__') || key.startsWith('RUNFILES')) {
    delete env[key];
  }
}
// Preserve a configured Windows cache override across Bazel's test environment.
// Match Node's first sorted case-insensitive key; pass only its name in argv.
const testEnvironment = [];
if (process.platform === 'win32') {
  const cacheKeys = Object.keys(env)
    .sort()
    .filter((key) => key.toUpperCase() === 'PSMODULEANALYSISCACHEPATH');
  const cache = cacheKeys.length ? env[cacheKeys[0]] : undefined;
  if (typeof cache === 'string' && cache.length > 0) {
    for (const key of cacheKeys) delete env[key];
    env.PSModuleAnalysisCachePath = cache;
    testEnvironment.push('--test_env=PSModuleAnalysisCachePath');
  }
}
function run(command, args, packaged = false) {
  const result = packaged
    ? runPackagedCheck(command, args, { cwd, env })
    : spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(
      `CI command failed on ${process.platform}/${process.arch}: ${command} ${args.join(' ')} (exit ${result.status}, signal ${result.signal ?? 'none'})`,
    );
    process.exit(result.status ?? 1);
  }
}
function bazel(...args) {
  run('bazel', [...startupOptions, ...args]);
}
if (process.platform === 'win32') {
  runCimModuleControls();
  await runCimContextControls();
}
bazel('build', '//:build');
bazel(
  'test',
  '//:test',
  '//:typecheck',
  '//:format_check',
  '//:portable_checks',
  // Unit and portability targets each launch the complete process-heavy suite.
  '--local_test_jobs=1',
  process.platform === 'win32' ? '--test_output=all' : '--test_output=errors',
  ...testEnvironment,
);
if (process.platform === 'linux' && !env.DISPLAY) {
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:smoke']);
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:demo_check']);
} else {
  bazel('run', '//:smoke');
  bazel('run', '//:demo_check');
}
bazel('run', '//:package');
if (process.platform === 'darwin') bazel('run', '//:packaged_smoke_failure');
if (process.platform === 'linux' && !env.DISPLAY) {
  run(
    'xvfb-run',
    ['-a', 'bazel', ...startupOptions, 'run', '//:packaged_smoke'],
    true,
  );
} else {
  run('bazel', [...startupOptions, 'run', '//:packaged_smoke'], true);
}
