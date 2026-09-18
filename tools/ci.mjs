import { spawnSync } from 'node:child_process';

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
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function bazel(...args) {
  run('bazel', [...startupOptions, ...args]);
}
bazel('build', '//:build');
bazel(
  'test',
  '//:test',
  '//:typecheck',
  '//:format_check',
  '//:portable_checks',
  '--test_output=errors',
);
if (process.platform === 'linux' && !env.DISPLAY) {
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:smoke']);
} else {
  bazel('run', '//:smoke');
}
bazel('run', '//:package');
