import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runCimModuleControls } from './windows-cim-control.mjs';
import { runCimContextControls } from './windows-cim-input-control.mjs';

const cwd = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const startupOptions = process.argv.slice(2);
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
// CI smoke runs must not inherit a focused mode or fault-injection switch.
for (const key of Object.keys(env)) {
  if (key.startsWith('CANOPY_SMOKE_')) delete env[key];
}
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
function run(command, args, commandEnv = env) {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnv,
    stdio: 'inherit',
  });
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
function smoke(commandEnv = env) {
  if (process.platform === 'linux' && !env.DISPLAY) {
    run(
      'xvfb-run',
      ['-a', 'bazel', ...startupOptions, 'run', '//:smoke'],
      commandEnv,
    );
  } else {
    run('bazel', [...startupOptions, 'run', '//:smoke'], commandEnv);
  }
}
async function collectEvidence(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await collectEvidence(file, files);
    else if (entry.isFile()) {
      const contents = await readFile(file);
      files.push({
        file: relative(cwd, file).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(contents).digest('hex'),
        bytes: contents.length,
      });
    }
  }
  return files;
}
async function writeEvidenceManifest() {
  const evidence = [];
  for (const directory of [
    join(cwd, '.cache', 'typography'),
    join(cwd, '.cache', 'accessibility'),
  ]) {
    await collectEvidence(directory, evidence);
  }
  for (const file of ['tree.png', 'preview.png']) {
    const fullPath = join(cwd, '.cache', file);
    const contents = await readFile(fullPath);
    evidence.push({
      file: `.cache/${file}`,
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.length,
    });
  }
  evidence.sort((left, right) => left.file.localeCompare(right.file));
  const revision =
    process.env.GITHUB_SHA || process.env.BUILD_SCM_REVISION || 'unknown';
  await mkdir(join(cwd, '.cache'), { recursive: true });
  await writeFile(
    join(cwd, '.cache', 'ui-review-evidence.json'),
    `${JSON.stringify({ sourceRevision: revision, platform: `${process.platform}-${process.arch}`, evidence }, null, 2)}\n`,
  );
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
  '//:branding_check',
  '//:portable_checks',
  // Unit and portability targets each launch the complete process-heavy suite.
  '--local_test_jobs=1',
  process.platform === 'win32' ? '--test_output=all' : '--test_output=errors',
  ...testEnvironment,
);
if (process.platform === 'linux' && !env.DISPLAY) {
  run('xvfb-run', [
    '-a',
    'bazel',
    ...startupOptions,
    'run',
    '//:branding_smoke',
  ]);
  smoke();
  smoke({
    ...env,
    CANOPY_SMOKE_ACCESSIBILITY_ONLY: '1',
  });
  smoke({
    ...env,
    CANOPY_SMOKE_TYPOGRAPHY_ONLY: '1',
  });
  run('xvfb-run', ['-a', 'bazel', ...startupOptions, 'run', '//:demo_check']);
  run('xvfb-run', [
    '-a',
    'bazel',
    ...startupOptions,
    'run',
    '//:instance_check',
    '--',
    '--state-only',
  ]);
} else {
  bazel('run', '//:branding_smoke');
  smoke();
  smoke({
    ...env,
    CANOPY_SMOKE_ACCESSIBILITY_ONLY: '1',
  });
  smoke({
    ...env,
    CANOPY_SMOKE_TYPOGRAPHY_ONLY: '1',
  });
  bazel('run', '//:demo_check');
  bazel('run', '//:instance_check', '--', '--state-only');
}
await writeEvidenceManifest();
bazel('run', '//:package');
