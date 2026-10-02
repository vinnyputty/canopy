import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'canopy-handoff-ipc-'));
  await build({
    stdin: {
      contents:
        "export {launch} from './src/main/app'; export {createDemoFixture} from './src/main/demo';",
      resolveDir: resolve('.'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(directory, 'source.cjs'),
  });
  await build({
    entryPoints: ['src/main/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(directory, 'preload.cjs'),
  });
  await build({
    entryPoints: ['tests/fixtures/handoff-ipc.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(directory, 'controls.cjs'),
  });
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});
for (const scenario of [
  'loser',
  'early-quit',
  'fifo',
  'preload',
  'navigation',
  'crash',
  'close',
])
  it(`real handoff launch/IPC callbacks: ${scenario}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        join(directory, 'controls.cjs'),
        join(directory, 'source.cjs'),
        scenario,
        join(directory, 'preload.cjs'),
      ],
      {
        env: { ...process.env, CANOPY_USER_DATA: directory },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
