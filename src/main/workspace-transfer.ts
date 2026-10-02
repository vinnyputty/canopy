import { randomUUID } from 'node:crypto';
import { open, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import type { Connection, Workspace } from '../shared/types';
import {
  BACKUP_LIMIT,
  createBackup,
  parseBackup,
  planImport,
  type WorkspaceBackup,
  type ImportMode,
} from '../shared/workspace-backup';
import { recoverWorkspaceViews } from '../shared/views';
import { replaceFile } from './replace-file';

export interface WorkspaceStore {
  read<T>(name: string): Promise<T | null>;
  replaceWorkspace(expected: Workspace, next: Workspace): Promise<void>;
}
/** Only workspace.json participates; auth and provider caches are never read. */
export class WorkspaceTransfer {
  private exported?: { token: string; backup: WorkspaceBackup };
  private pending?: {
    token: string;
    before: Workspace;
    after: Workspace;
    connections: string;
  };
  private undo?: { before: Workspace; after: Workspace };
  constructor(
    private storage: WorkspaceStore,
    private connections: () => Connection[],
  ) {}
  async prepareExport() {
    const saved = await this.saved();
    const backup = createBackup(
      recoverWorkspaceViews(saved),
      this.connections(),
    );
    if (
      Buffer.byteLength(JSON.stringify(backup, null, 2), 'utf8') > BACKUP_LIMIT
    )
      throw new Error(
        'Formatted backup exceeds 4 MB. Reduce saved roots or views before exporting.',
      );
    const token = randomUUID();
    this.exported = { token, backup };
    return { token, backup };
  }
  exportContents(token: string) {
    if (!this.exported || token !== this.exported.token)
      throw new Error('Export preview expired; review again.');
    return JSON.stringify(this.exported.backup, null, 2);
  }
  async preview(
    backup: WorkspaceBackup,
    mapping: Record<string, string>,
    mode: ImportMode,
  ) {
    this.pending = undefined;
    const before = await this.saved();
    const connections = this.connections();
    const plan = planImport(
      parseBackup(JSON.stringify(backup)),
      recoverWorkspaceViews(before),
      connections,
      mapping,
      mode,
    );
    const token = randomUUID();
    this.pending = {
      token,
      before,
      after: plan.workspace,
      connections: JSON.stringify(connections),
    };
    return { token, ...plan };
  }
  async apply(token: string): Promise<Workspace> {
    const pending = this.pending;
    this.pending = undefined;
    if (
      !pending ||
      pending.token !== token ||
      pending.connections !== JSON.stringify(this.connections())
    )
      throw new Error('Import preview expired; review again.');
    await this.storage.replaceWorkspace(pending.before, pending.after);
    this.undo = { before: pending.before, after: pending.after };
    return pending.after;
  }
  canUndo() {
    return this.undo !== undefined;
  }
  async rollback(): Promise<Workspace> {
    const undo = this.undo;
    if (!undo) throw new Error('No import to undo in this session.');
    await this.storage.replaceWorkspace(undo.after, undo.before);
    this.undo = undefined;
    return recoverWorkspaceViews(undo.before);
  }
  private async saved() {
    const saved = await this.storage.read<Workspace>('workspace');
    if (!saved) throw new Error('Save the workspace before transferring it.');
    return saved;
  }
}
export async function readBackupFile(file: string): Promise<WorkspaceBackup> {
  const entry = await lstat(file);
  if (!entry.isFile())
    throw new Error('Choose a regular backup file under 4 MB.');
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > BACKUP_LIMIT)
      throw new Error('Choose a regular backup file under 4 MB.');
    const buffer = Buffer.alloc(BACKUP_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > BACKUP_LIMIT) throw new Error('Backup exceeds 4 MB.');
    return parseBackup(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    await handle.close();
  }
}
export async function writeBackupFile(
  file: string,
  contents: string,
  userData: string,
) {
  const parent = await realpath(dirname(file));
  const protectedDirectory = await realpath(userData);
  const location = relative(protectedDirectory, parent);
  if (
    !location ||
    (location !== '..' &&
      !location.startsWith(`..${sep}`) &&
      !isAbsolute(location))
  )
    throw new Error('Export outside the Canopy user-data directory.');
  // Rename replaces a destination symlink itself, never its target.
  const temporary = join(parent, `.canopy-backup-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await replaceFile(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
