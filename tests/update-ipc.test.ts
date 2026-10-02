import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'canopy-update-ipc-'));
  await build({
    stdin: {
      contents:
        "export {launch} from './src/main/app'; export {Updates} from './src/main/updates'; export {createDemoFixture} from './src/main/demo';",
      resolveDir: resolve('.'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(directory, 'source.cjs'),
  });
  await build({
    entryPoints: ['tests/fixtures/update-main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(directory, 'audit.cjs'),
  });
  await build({
    entryPoints: ['tests/fixtures/update-audit-guard.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'audit-guard.cjs'),
  });
  await build({
    entryPoints: ['tests/fixtures/update-ipc.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'controls.cjs'),
  });
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});
for (const scenario of [
  'load-cancel',
  'load-destroyed',
  'load-quit',
  'load-preferences',
  'load-control',
  'load-replacement',
  'write-cancel',
  'write-destroyed',
  'write-quit',
  'write-preferences',
  'write-control',
  'write-replacement',
  'retention-snapshot',
  'retention-background',
  'retention-open',
  'retention-replacement',
  'active-replacement',
]) {
  it(`main IPC update boundary: ${scenario}`, () => {
    const profile = join(directory, scenario);
    // Profile creation is supplied by this parent, never selected by app defaults.
    mkdirSync(profile, { recursive: true });
    const child = spawnSync(
      process.execPath,
      [
        join(directory, 'controls.cjs'),
        join(directory, 'source.cjs'),
        scenario,
      ],
      {
        env: {
          ...process.env,
          CANOPY_USER_DATA: profile,
          CANOPY_DEMO_TEMP: '0',
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, new RegExp(`PASS ${scenario}`));
  });
}

for (const scenario of ['missing', 'relative', 'non-temp', 'credentials']) {
  it(`native audit rejects unsafe profile before launch/Auth: ${scenario}`, () => {
    const profile = join(directory, 'audit-' + scenario);
    mkdirSync(profile, { recursive: true });
    if (scenario === 'credentials')
      writeFileSync(
        join(profile, 'credentials.json'),
        'forbidden synthetic sentinel',
      );
    const env = {
      ...process.env,
      CANOPY_DEMO_TEMP: '0',
      CANOPY_USER_DATA:
        scenario === 'relative'
          ? 'relative-profile'
          : scenario === 'non-temp'
            ? '/'
            : profile,
    };
    if (scenario === 'missing')
      delete (env as Partial<typeof env>).CANOPY_USER_DATA;
    const child = spawnSync(
      process.execPath,
      [join(directory, 'audit-guard.cjs'), join(directory, 'audit.cjs')],
      { env, encoding: 'utf8', timeout: 2000 },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /PASS audit profile guard/);
  });
}
