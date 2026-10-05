import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import {
  WorkspaceTransfer,
  readBackupFile,
  writeBackupFile,
} from '../src/main/workspace-transfer';
import { createBackup } from '../src/shared/workspace-backup';
import type { Workspace } from '../src/shared/types';
import {
  backupConnections,
  backupWorkspace,
} from './fixtures/workspace-backup';

// Exercise Storage's actual queue and filesystem without loading Electron or a keychain.
async function sampleStorage(directory: string, gateModule?: string) {
  const result = await build({
    entryPoints: ['src/main/storage.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: gateModule ? [gateModule] : [],
    write: false,
    plugins: [
      {
        name: 'forbid-keychain',
        setup(build) {
          build.onResolve({ filter: /\.\/replace-file$/ }, () => ({
            path: 'replace-file',
            namespace: 'replacement-failure',
          }));
          build.onLoad(
            { filter: /.*/, namespace: 'replacement-failure' },
            () => ({
              contents: `${gateModule ? `import {beforeReplace} from ${JSON.stringify(gateModule)};` : 'const beforeReplace = async () => {};'} import {access,rename} from 'node:fs/promises'; export async function replaceFile(source,destination) { let fail = false; try { await access(destination+'.fail'); fail = true; } catch {} if (fail) throw new Error('Fixture replacement failure'); await beforeReplace(destination); arguments[4]?.(); await rename(source,destination); }`,
            }),
          );
          if (gateModule) {
            build.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
              /[\\/]storage\.ts$/.test(args.importer)
                ? { path: 'staged-fs', namespace: 'staging-gate' }
                : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: 'staging-gate' }, () => ({
              contents: `export * from 'node:fs/promises'; import {writeFile as write} from 'node:fs/promises'; import {afterStage} from ${JSON.stringify(gateModule)}; export async function writeFile(...args) {await write(...args); await afterStage(args[0]);}`,
            }));
          }
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'sample',
          }));
          build.onLoad({ filter: /.*/, namespace: 'sample' }, () => ({
            contents:
              'export const safeStorage = new Proxy({}, {get(){throw new Error("Keychain access forbidden in backup fixtures");}});',
          }));
        },
      },
    ],
  });
  const modulePath = join(directory, 'storage.cjs');
  await writeFile(modulePath, result.outputFiles[0].contents);
  const { Storage } = createRequire(import.meta.url)(
    modulePath,
  ) as typeof import('../src/main/storage');
  return new Storage(directory);
}

test('atomic import, stale preview, failed writes, and undo preserve workspace and unrelated data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = await sampleStorage(directory);
  const original = structuredClone(backupWorkspace);
  await storage.write('workspace', original);
  await writeFile(join(directory, 'credentials.json'), 'FAKE OPAQUE FIXTURE');
  await writeFile(join(directory, 'tree-cache.json'), 'PRIVATE SAMPLE CACHE');
  const transfer = new WorkspaceTransfer(storage, () => backupConnections);
  const backup = createBackup(
    { ...original, theme: 'light' },
    backupConnections,
  );
  const mapping = Object.fromEntries(
    backupConnections.map((c) => [c.id, c.id]),
  );
  let preview = await transfer.preview(backup, mapping, 'replace');
  await storage.write('workspace', { ...original, theme: 'system' });
  await assert.rejects(transfer.apply(preview.token), /changed after preview/);
  assert.equal((await storage.read<Workspace>('workspace'))?.theme, 'system');
  await storage.write('workspace', original);
  preview = await transfer.preview(backup, mapping, 'replace');
  // A directory at the staging path causes a real filesystem write failure.
  await mkdir(join(directory, 'workspace.json.tmp'));
  await assert.rejects(transfer.apply(preview.token));
  assert.deepEqual(await storage.read('workspace'), original);
  await rm(join(directory, 'workspace.json.tmp'), { recursive: true });
  preview = await transfer.preview(backup, mapping, 'replace');
  await storage.write(
    'workspace',
    Object.fromEntries(Object.entries(original).reverse()),
  );
  await writeFile(
    join(directory, 'workspace.json.fail'),
    'sample failure trigger',
  );
  await assert.rejects(
    transfer.apply(preview.token),
    /Fixture replacement failure/,
  );
  assert.deepEqual(await storage.read('workspace'), original);
  await assert.rejects(readFile(join(directory, 'workspace.json.tmp')), {
    code: 'ENOENT',
  });
  await rm(join(directory, 'workspace.json.fail'));
  preview = await transfer.preview(backup, mapping, 'replace');
  const imported = await transfer.apply(preview.token);
  assert.equal(imported.theme, 'light');
  assert.equal((await storage.read<Workspace>('workspace'))?.theme, 'light');
  await storage.write(
    'workspace',
    Object.fromEntries(Object.entries(imported).reverse()),
  );
  await transfer.rollback();
  assert.deepEqual(await storage.read('workspace'), original);
  preview = await transfer.preview(backup, mapping, 'replace');
  await transfer.apply(preview.token);
  await storage.write('workspace', { ...imported, palette: 'ocean' });
  await assert.rejects(transfer.rollback(), /changed after preview/);
  assert.equal((await storage.read<Workspace>('workspace'))?.palette, 'ocean');
  assert.equal(
    await readFile(join(directory, 'credentials.json'), 'utf8'),
    'FAKE OPAQUE FIXTURE',
  );
  assert.equal(
    await readFile(join(directory, 'tree-cache.json'), 'utf8'),
    'PRIVATE SAMPLE CACHE',
  );
});

test('review tokens expire and connection changes invalidate import approval', async () => {
  let workspace = structuredClone(backupWorkspace);
  let connections = backupConnections;
  const transfer = new WorkspaceTransfer(
    {
      read: async <T>() => structuredClone(workspace) as T,
      replaceWorkspace: async (_, next) => {
        workspace = next;
      },
    },
    () => connections,
  );
  const exported = await transfer.prepareExport();
  assert.ok(
    !transfer.exportContents(exported.token).includes('PRIVATE SNAPSHOT'),
  );
  await transfer.prepareExport();
  assert.throws(() => transfer.exportContents(exported.token), /expired/);
  const mapping = Object.fromEntries(
    backupConnections.map((c) => [c.id, c.id]),
  );
  const preview = await transfer.preview(exported.backup, mapping, 'merge');
  connections = [
    ...connections,
    {
      id: 'another',
      name: 'Other',
      url: 'https://other.invalid',
      provider: 'jira',
    },
  ];
  await assert.rejects(transfer.apply(preview.token), /expired/);
  assert.deepEqual(workspace, backupWorkspace);
});

test('bounded backup file reads and private atomic exports reject protected destinations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userData = join(directory, 'user-data');
  await mkdir(userData);
  const contents = JSON.stringify(
    createBackup(backupWorkspace, backupConnections),
    null,
    2,
  );
  const file = join(directory, 'backup.json');
  await writeBackupFile(file, contents, userData);
  assert.deepEqual(
    await readBackupFile(file),
    createBackup(
      backupWorkspace,
      backupConnections,
      JSON.parse(contents).createdAt,
    ),
  );
  await assert.rejects(
    writeBackupFile(join(userData, 'workspace.json'), contents, userData),
    /outside/,
  );
  await writeFile(file, '{"format":');
  await assert.rejects(readBackupFile(file), /complete JSON/);
  await writeFile(file, 'x'.repeat(4_000_001));
  await assert.rejects(readBackupFile(file), /under 4 MB/);
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readBackupFile(file));
  await assert.rejects(readBackupFile(directory), /regular backup/);
});

for (const phase of ['queue', 'staging', 'replacement'] as const) {
  test(`connection change during ${phase} rejects before workspace replacement`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'canopy-approval-race-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gateFile = join(directory, 'gate.cjs');
    await writeFile(
      gateFile,
      `const {basename} = require('node:path');
exports.pause = async () => {};
exports.arm = phase => {
  let notify, release;
  const entered = new Promise(resolve => notify = resolve);
  const blocked = new Promise(resolve => release = resolve);
  exports.started = () => entered;
  exports.release = release;
  exports.pause = async candidate => {
    if (candidate === phase) { notify(); await blocked; }
  };
};
exports.beforeReplace = async destination => {
  if (basename(destination) === 'hold.json') await exports.pause('queue');
  if (basename(destination) === 'workspace.json') await exports.pause('replacement');
};
exports.afterStage = async file => {
  if (basename(file) === 'workspace.json.tmp') await exports.pause('staging');
};`,
    );
    const gate = createRequire(import.meta.url)(gateFile) as {
      arm(phase: string): void;
      started(): Promise<void>;
      release(): void;
    };
    const storage = await sampleStorage(directory, gateFile);
    const original = structuredClone(backupWorkspace);
    await storage.write('workspace', original);
    await writeFile(join(directory, 'credentials.json'), 'FAKE OPAQUE FIXTURE');
    await writeFile(join(directory, 'tree-cache.json'), 'PRIVATE SAMPLE CACHE');
    const originalBytes = await readFile(
      join(directory, 'workspace.json'),
      'utf8',
    );
    let connections = structuredClone(backupConnections);
    const transfer = new WorkspaceTransfer(storage, () => connections);
    const backup = createBackup(
      { ...original, theme: 'light' },
      backupConnections,
    );
    const mapping = Object.fromEntries(
      backupConnections.map((c) => [c.id, c.id]),
    );
    const preview = await transfer.preview(backup, mapping, 'replace');
    gate.arm(phase);
    let held: Promise<void> | undefined;
    if (phase === 'queue') {
      held = storage.write('hold', { sample: true });
      await gate.started();
    }
    const applying = transfer.apply(preview.token);
    const rejected = assert.rejects(
      applying,
      /connection.*changed|preview expired/i,
      phase,
    );
    if (phase !== 'queue') await gate.started();
    // Same ID/provider/server, different account: provider compatibility alone is insufficient.
    connections = connections.map((c) => ({
      ...c,
      accountName: 'different-sample-account',
    }));
    gate.release();
    if (held) await held;
    await rejected;
    assert.equal(
      await readFile(join(directory, 'workspace.json'), 'utf8'),
      originalBytes,
      phase,
    );
    assert.equal(transfer.canUndo(), false);
    await assert.rejects(readFile(join(directory, 'workspace.json.tmp')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(directory, 'credentials.json'), 'utf8'),
      'FAKE OPAQUE FIXTURE',
    );
    assert.equal(
      await readFile(join(directory, 'tree-cache.json'), 'utf8'),
      'PRIVATE SAMPLE CACHE',
    );
    connections = structuredClone(backupConnections);
    const retried = await transfer.preview(backup, mapping, 'replace');
    await transfer.apply(retried.token);
    assert.equal((await storage.read<Workspace>('workspace'))?.theme, 'light');
  });
}

test('merge capacity failures invalidate approval before any workspace write', async () => {
  for (const key of ['rootViews', 'viewDefaults', 'savedViews'] as const) {
    const original = structuredClone(backupWorkspace);
    const view = original.rootViews!['["sample-jira","SAMPLE-1"]'];
    if (key === 'savedViews') {
      original.savedViews = Array.from({ length: 100 }, (_, i) => ({
        ...structuredClone(original.savedViews![0]),
        id: `local-${i}`,
        name: `Local ${i}`,
      }));
      original.activeSavedViewId = 'local-0';
    } else {
      original[key] = Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [
          key === 'rootViews'
            ? JSON.stringify(['sample-jira', `SAMPLE-${i + 10}`])
            : `local-${i}`,
          structuredClone(view),
        ]),
      );
    }
    let writes = 0;
    const before = structuredClone(original);
    const transfer = new WorkspaceTransfer(
      {
        read: async <T>() => structuredClone(original) as T,
        replaceWorkspace: async () => {
          writes++;
        },
      },
      () => backupConnections,
    );
    const backup = createBackup(backupWorkspace, backupConnections);
    const mapping = Object.fromEntries(
      backupConnections.map((c) => [c.id, c.id]),
    );
    const prior = await transfer.preview(backup, mapping, 'replace');
    await assert.rejects(
      transfer.preview(backup, mapping, 'merge'),
      /Merged .* exceed the workspace limit; use replace or reduce the workspace\./,
    );
    await assert.rejects(transfer.apply(prior.token), /preview expired/);
    assert.equal(writes, 0);
    assert.equal(transfer.canUndo(), false);
    assert.deepEqual(original, before);
  }
});
