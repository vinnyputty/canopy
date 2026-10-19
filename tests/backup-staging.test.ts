import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

type BackupFault = { mode: 'staging' | 'replacement'; theme: string };
type BackupGlobals = typeof globalThis & {
  canopyBackupFault?: BackupFault | null;
  canopyBackupFaultResult?: { mode: string; code?: string };
  canopyBackupStageGate?: (contents: string) => Promise<void>;
};
type BackupFilesystem = typeof import('node:fs/promises');

function generatedFilesystemSource() {
  const source = ts.createSourceFile(
    'stage-backup-smoke.mjs',
    readFileSync(
      new URL('../tools/stage-backup-smoke.mjs', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let result: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'contents' &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer) &&
      node.initializer.text.startsWith("export * from 'node:fs/promises';")
    )
      result = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, 'Generated backup filesystem wrapper not found');
  return result;
}

async function withFilesystem<T>(
  run: (filesystem: BackupFilesystem, directory: string) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-staging-'));
  const globals = globalThis as BackupGlobals;
  try {
    const wrapper = join(directory, 'filesystem.mjs');
    await writeFile(wrapper, generatedFilesystemSource());
    const filesystem = (await import(
      `${pathToFileURL(wrapper).href}?fixture=${Date.now()}`
    )) as BackupFilesystem;
    return await run(filesystem, directory);
  } finally {
    globals.canopyBackupFault = undefined;
    globals.canopyBackupFaultResult = undefined;
    globals.canopyBackupStageGate = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}

function temporaryFiles(entries: string[]) {
  return entries.filter((name) => /^workspace\.json(?:\..+)?\.tmp$/.test(name));
}

test('generated backup filesystem wrapper holds staging before workspace replacement', () =>
  withFilesystem(async (filesystem, directory) => {
    const globals = globalThis as BackupGlobals;
    const workspace = join(directory, 'workspace.json');
    const original = JSON.stringify({ theme: 'system', tabs: [] });
    const imported = JSON.stringify({
      theme: 'dark',
      tabs: [{ id: 'imported' }],
    });
    await writeFile(workspace, original);
    let markStaged!: () => void;
    let releaseStage!: () => void;
    const staged = new Promise<void>((resolve) => (markStaged = resolve));
    const held = new Promise<void>((resolve) => (releaseStage = resolve));
    globals.canopyBackupStageGate = async (contents) => {
      if (contents === imported) {
        markStaged();
        await held;
      }
    };
    const save = async (contents: string) => {
      const temporary = `${workspace}.${randomUUID()}.tmp`;
      const handle = await filesystem.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      try {
        await filesystem.rename(temporary, workspace);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    };
    const writing = save(imported);
    await staged;
    assert.equal(await readFile(workspace, 'utf8'), original);
    assert.equal(temporaryFiles(await readdir(directory)).length, 1);
    releaseStage();
    await writing;
    assert.equal(await readFile(workspace, 'utf8'), imported);
    assert.deepEqual(temporaryFiles(await readdir(directory)), []);
  }));

test('generated backup filesystem wrapper preserves workspace and cleans a real staging failure', () =>
  withFilesystem(async (filesystem, directory) => {
    const globals = globalThis as BackupGlobals;
    const workspace = join(directory, 'workspace.json');
    const original = JSON.stringify({ theme: 'system', tabs: [] });
    const replacement = JSON.stringify({
      theme: 'dark',
      tabs: [{ id: 'new' }],
    });
    await writeFile(workspace, original);
    globals.canopyBackupFault = { mode: 'staging', theme: 'dark' };
    const temporary = `${workspace}.${randomUUID()}.tmp`;
    const handle = await filesystem.open(temporary, 'wx', 0o600);
    await assert.rejects(
      async () => {
        try {
          await handle.writeFile(replacement);
        } finally {
          await handle.close();
        }
      },
      (error: NodeJS.ErrnoException) =>
        ['EISDIR', 'EACCES', 'EPERM'].includes(error.code ?? ''),
    );
    await rm(temporary, { recursive: true, force: true });
    assert.equal(globals.canopyBackupFaultResult?.mode, 'staging');
    assert.ok(
      ['EISDIR', 'EACCES', 'EPERM'].includes(
        globals.canopyBackupFaultResult?.code ?? '',
      ),
    );
    assert.equal(await readFile(workspace, 'utf8'), original);
    assert.deepEqual(temporaryFiles(await readdir(directory)), []);
  }));

test(
  'generated backup filesystem wrapper restores POSIX directory permissions after replacement failure',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () =>
    withFilesystem(async (filesystem, directory) => {
      const globals = globalThis as BackupGlobals;
      const workspace = join(directory, 'workspace.json');
      const original = JSON.stringify({ theme: 'system', tabs: [] });
      const replacement = JSON.stringify({
        theme: 'dark',
        tabs: [{ id: 'new' }],
      });
      await writeFile(workspace, original);
      const fs = await import('node:fs/promises');
      const directoryMode = (await fs.stat(directory)).mode & 0o777;
      globals.canopyBackupFault = { mode: 'replacement', theme: 'dark' };
      const temporary = `${workspace}.${randomUUID()}.tmp`;
      const handle = await filesystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(replacement);
      await handle.close();
      await assert.rejects(
        filesystem.rename(temporary, workspace),
        (error: NodeJS.ErrnoException) =>
          ['EACCES', 'EPERM'].includes(error.code ?? ''),
      );
      await rm(temporary, { recursive: true, force: true });
      assert.equal(globals.canopyBackupFaultResult?.mode, 'replacement');
      assert.equal((await fs.stat(directory)).mode & 0o777, directoryMode);
      assert.equal(await readFile(workspace, 'utf8'), original);
      assert.deepEqual(temporaryFiles(await readdir(directory)), []);
    }),
);

test('backup staging controls ignore similarly named non-workspace files', () =>
  withFilesystem(async (filesystem, directory) => {
    const globals = globalThis as BackupGlobals;
    globals.canopyBackupStageGate = async () => {
      assert.fail('Unrelated file entered workspace staging gate');
    };
    const file = join(directory, 'workspaceXjsonYtmp');
    const handle = await filesystem.open(file, 'wx', 0o600);
    try {
      await handle.writeFile('unrelated data');
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(file, 'utf8'), 'unrelated data');
  }));
