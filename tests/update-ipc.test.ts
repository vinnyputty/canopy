import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    entryPoints: ['tests/fixtures/update-ipc-io.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'io.cjs'),
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

for (const scenario of [
  'write-destroyed',
  'write-preferences',
  'write-replacement',
  'active-replacement',
]) {
  it(`main IPC waits for delayed real filesystem boundaries: ${scenario}`, () => {
    const profile = join(directory, `delayed-${scenario}`);
    mkdirSync(profile);
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        join(directory, 'io.cjs'),
        join(directory, 'controls.cjs'),
        join(directory, 'source.cjs'),
        scenario,
      ],
      {
        env: {
          ...process.env,
          CANOPY_USER_DATA: profile,
          CANOPY_DEMO_TEMP: '0',
          CANOPY_IPC_IO: 'delay',
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /REAL mkdir completed/);
    assert.match(child.stdout, new RegExp(`PASS ${scenario}`));
    assert.match(child.stdout, /EXIT timeouts=0/);
    assert.ok(!existsSync(join(profile, 'credentials.json')));
  });
}
for (const [scenario, boundary] of [
  ['write-cancel', 'held preference write'],
]) {
  it(`main IPC fails finitely when ${boundary} never arrives`, () => {
    const profile = join(directory, `missing-${scenario}`);
    mkdirSync(profile);
    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        join(directory, 'io.cjs'),
        join(directory, 'controls.cjs'),
        join(directory, 'source.cjs'),
        scenario,
      ],
      {
        env: {
          ...process.env,
          CANOPY_USER_DATA: profile,
          CANOPY_DEMO_TEMP: '0',
          CANOPY_IPC_IO: 'never',
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stdout, /REAL mkdir completed/);
    assert.match(
      child.stderr,
      new RegExp(`Expected ${boundary} boundary within 5000ms`),
    );
    assert.ok(performance.now() - started >= 4900);
    assert.doesNotMatch(child.stdout, /PASS /);
    assert.match(child.stdout, /EXIT timeouts=0/);
    assert.ok(!existsSync(join(profile, 'credentials.json')));
  });
}

for (const flag of ['0', '1']) {
  for (const scenario of [
    'missing',
    'relative',
    'non-temp',
    'credentials',
    'invalid-realpath',
    'temp-root',
    'symlink-escape',
    'symlink-credentials',
  ]) {
    it(`audit guard preserves rejected profile after exit: ${scenario}, cleanup=${flag}`, () => {
      const holder = join(directory, `audit-${scenario}-${flag}`);
      mkdirSync(holder, { recursive: true });
      const sentinel = join(holder, 'sentinel.txt');
      writeFileSync(sentinel, 'Unapproved synthetic profile sentinel');
      let profile = holder;
      if (scenario === 'credentials')
        writeFileSync(
          join(holder, 'credentials.json'),
          'SYNTHETIC CREDENTIAL SENTINEL',
        );
      if (scenario === 'relative') profile = holder.slice(directory.length + 1);
      if (scenario === 'non-temp') profile = resolve('/');
      if (scenario === 'invalid-realpath') profile = join(holder, 'missing');
      if (scenario === 'temp-root') profile = tmpdir();
      if (scenario.startsWith('symlink-')) {
        profile = join(holder, 'profile-link');
        const target =
          scenario === 'symlink-escape'
            ? resolve('/')
            : join(holder, 'credential-target');
        if (scenario === 'symlink-credentials') {
          mkdirSync(target);
          writeFileSync(
            join(target, 'credentials.json'),
            'SYNTHETIC CREDENTIAL SENTINEL',
          );
        }
        symlinkSync(
          target,
          profile,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      const env = {
        ...process.env,
        CANOPY_DEMO_TEMP: flag,
        CANOPY_USER_DATA: profile,
        CANOPY_GUARD_TEST_ROOT: directory,
      };
      if (scenario === 'missing')
        delete (env as Partial<typeof env>).CANOPY_USER_DATA;
      const child = spawnSync(
        process.execPath,
        [join(directory, 'audit-guard.cjs'), join(directory, 'audit.cjs')],
        { env, cwd: directory, encoding: 'utf8', timeout: 2000 },
      );
      // Check preservation AFTER child exit, including registered exit handlers.
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /PASS audit profile guard/);
      assert.equal(
        readFileSync(sentinel, 'utf8'),
        'Unapproved synthetic profile sentinel',
      );
      if (scenario === 'credentials')
        assert.equal(
          readFileSync(join(holder, 'credentials.json'), 'utf8'),
          'SYNTHETIC CREDENTIAL SENTINEL',
        );
      if (scenario.startsWith('symlink-')) {
        assert.ok(lstatSync(profile).isSymbolicLink());
        assert.ok(readlinkSync(profile));
        if (scenario === 'symlink-credentials')
          assert.equal(
            readFileSync(
              join(holder, 'credential-target', 'credentials.json'),
              'utf8',
            ),
            'SYNTHETIC CREDENTIAL SENTINEL',
          );
      }
      assert.ok(existsSync(holder));
    });
  }
}
