import assert from 'node:assert/strict';
import { runPackagedCheck } from './packaged-check-log.mjs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), 'canopy tooling '));
try {
  // A launcher that exits before Playwright returns an application must retain
  // native stderr and fail; this fixture starts only Node, never Electron.
  const failure = runPackagedCheck(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    ['-e', "console.error('early native launch failure'); process.exit(17)"],
    { cwd, env: process.env },
  );
  assert.equal(failure.status, 17);
  assert.match(
    await readFile(
      join(cwd, '.cache', 'smoke-failure', 'packaged-launch.stderr.log'),
      'utf8',
    ),
    /early native launch failure/,
  );
  // Windows can launch Bazel tools outside a runfiles tree. Exercise the real
  // launchers from an unrelated directory on every platform, including macOS.
  for (const [script, ...args] of [
    ['test.mjs'],
    ['check.mjs', 'types'],
    ['check.mjs', 'format'],
  ]) {
    const result = spawnSync(
      process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
      [join(directory, script), ...args],
      { cwd, stdio: 'inherit', timeout: 60_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${script} ${args.join(' ')} failed from ${cwd}`);
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
