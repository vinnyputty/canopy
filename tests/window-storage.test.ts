import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import type { Storage as StorageType } from '../src/main/storage';
import { WindowStateSaver } from '../src/main/window-state-saver';

// Exercise the real disk queue without Electron or an OS keychain. These fake
// secrets exist only in a disposable directory and never reach a live provider.
async function storageClass(): Promise<typeof StorageType> {
  const result = await build({
    entryPoints: ['src/main/storage.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'fixture-keychain',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'fixture',
          }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const safeStorage = {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'fixture',
            encryptString: value => Buffer.from(value),
            decryptString: value => value.toString(),
          };`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).Storage;
}

test('a failed bounds disk write leaves workspace and credential persistence usable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-window-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const Storage = await storageClass();
  const storage = new Storage(directory);
  // A directory at the destination makes the atomic bounds replacement fail.
  await mkdir(join(directory, 'window.json'));
  const errors: unknown[] = [];
  const saver = new WindowStateSaver(
    (value) => storage.write('window', value),
    (error) => {
      errors.push(error);
    },
  );
  saver.update({
    bounds: { x: 10, y: 20, width: 1100, height: 700 },
    maximized: false,
  });
  const closing = saver.flush();
  // Queue important writes behind the failing bounds write, then check both
  // their promises and the persisted files rather than a mock queue's output.
  await Promise.resolve();
  const workspace = { tabs: [], fixture: 'workspace' };
  const credentials = { fixture: 'disposable-fake-secret' };
  await Promise.all([
    closing,
    storage.write('workspace', workspace),
    storage.writeSecrets(credentials),
  ]);
  assert.equal(errors.length, 1);
  assert.deepEqual(await storage.read('workspace'), workspace);
  assert.deepEqual(await storage.readSecrets(), credentials);
  assert.ok(await readFile(join(directory, 'credentials.json'), 'utf8'));
  await rm(join(directory, 'window.json'), { recursive: true });
  saver.update({
    bounds: { x: 30, y: 40, width: 1200, height: 800 },
    maximized: true,
  });
  await saver.flush();
  assert.deepEqual(await storage.read('window'), {
    bounds: { x: 30, y: 40, width: 1200, height: 800 },
    maximized: true,
  });
});
