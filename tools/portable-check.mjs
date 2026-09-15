import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), 'canopy tooling '));
try {
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
