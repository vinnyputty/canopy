import { spawnSync } from 'node:child_process';
import { runCimModuleControls } from './windows-cim-control.mjs';

const cwd = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const startupOptions = process.argv.slice(2);
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
// Nested Bazel launchers must resolve their own runfiles and Node toolchain.
for (const key of Object.keys(env)) {
  if (key.startsWith('JS_BINARY__') || key.startsWith('RUNFILES')) {
    delete env[key];
  }
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
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
if (process.platform === 'win32') runCimModuleControls();
bazel('build', '//:build');
bazel(
  'test',
  '//:test',
  '//:typecheck',
  '//:format_check',
  '//:portable_checks',
  // Unit and portability targets each launch the complete process-heavy suite.
  '--local_test_jobs=1',
  '--test_output=errors',
);
if (process.platform === 'linux' && !env.DISPLAY) {
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:smoke']);
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:demo_check']);
} else {
  bazel('run', '//:smoke');
  bazel('run', '//:demo_check');
}
bazel('run', '//:package');
