import React, { useState, useEffect } from 'react';
import type { Connection, Workspace } from '../shared/types';
import type {
  ImportMode,
  ImportPreview,
  WorkspaceBackup,
} from '../shared/workspace-backup';

export function WorkspaceBackupPanel({
  connections,
  flush,
  onApply,
}: {
  connections: Connection[];
  flush: () => Promise<void>;
  onApply: (operation: () => Promise<Workspace>) => Promise<void>;
}) {
  const [exported, setExported] = useState<{
    token: string;
    backup: WorkspaceBackup;
  } | null>(null);
  const [backup, setBackup] = useState<WorkspaceBackup | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ImportMode>('merge');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  useEffect(() => {
    void window.canopy
      .canUndoWorkspaceImport()
      .then(setCanUndo)
      .catch(() => {});
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-content">
      <p>
        Backup includes server URLs and names, connection IDs, root keys and
        summaries, favorites, recent and closed roots, saved view names and
        filters, appearance, reading, pane sizes, and keyboard shortcuts. These
        metadata may reveal private project names, issue titles, account
        identifiers in saved filters, and workflow details. Store the file
        privately.
      </p>
      <p>
        Credentials and tokens, issue snapshots, comments, descriptions, and
        seen baselines are always excluded. Sensitive cache transfer is
        unavailable. Reconnect on the destination machine before importing;
        Canopy never creates credentials from a backup.
      </p>
      <fieldset disabled={busy}>
        <legend>Export</legend>
        <button
          onClick={() =>
            void run(async () => {
              await flush();
              setExported(await window.canopy.prepareWorkspaceExport());
            })
          }
        >
          Review export metadata
        </button>
        {exported && (
          <>
            <details open>
              <summary>Exact exported metadata</summary>
              <pre
                style={{
                  maxHeight: 280,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {JSON.stringify(exported.backup, null, 2)}
              </pre>
            </details>
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  const saved = await window.canopy.exportWorkspace(
                    exported.token,
                  );
                  setMessage(saved ? 'Backup exported.' : 'Export canceled.');
                })
              }
            >
              Export reviewed backup…
            </button>
          </>
        )}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Import</legend>
        <p>
          Applying or undoing reloads the workspace to discard stale issue
          displays. Undo last import is available in this dialog until the
          workspace changes or Canopy quits.
        </p>
        <button
          onClick={() =>
            void run(async () => {
              const selected = await window.canopy.chooseWorkspaceBackup();
              if (selected) {
                setBackup(selected);
                setMapping({});
                setPreview(null);
              }
            })
          }
        >
          Choose backup to preview…
        </button>
        {backup && (
          <>
            <p>
              Backup created {backup.createdAt}. Map every source explicitly to
              an existing connection with the same provider and server. Verify
              the destination account and repository access; imported roots will
              load under that account. If unavailable, close this dialog,
              reconnect in Connection setup, then select the backup again.
            </p>
            {backup.connections.map((source) => (
              <label key={source.id}>
                {source.name} ({source.provider}, {source.url}, {source.id}){' '}
                <select
                  aria-label={`Map ${source.name}`}
                  value={mapping[source.id] ?? ''}
                  onChange={(event) => {
                    setMapping({ ...mapping, [source.id]: event.target.value });
                    setPreview(null);
                  }}
                >
                  <option value="">Reconnect / choose destination</option>
                  {connections
                    .filter(
                      (c) =>
                        c.provider === source.provider &&
                        c.url.replace(/\/$/, '') === source.url,
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.accountName ?? c.id}{' '}
                        {c.repositories?.join(', ')}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <label>
              Import behavior{' '}
              <select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as ImportMode);
                  setPreview(null);
                }}
              >
                <option value="merge">Merge — existing conflicts win</option>
                <option value="replace">Replace workspace settings</option>
              </select>
            </label>
            <button
              disabled={backup.connections.some((c) => !mapping[c.id])}
              onClick={() =>
                void run(async () => {
                  await flush();
                  setPreview(
                    await window.canopy.previewWorkspaceImport(
                      backup,
                      mapping,
                      mode,
                    ),
                  );
                })
              }
            >
              Preview effects and conflicts
            </button>
            {preview && (
              <>
                <ul>
                  {preview.effects.map((effect, i) => (
                    <li key={i}>{effect}</li>
                  ))}
                </ul>
                <p>
                  {preview.conflicts.length
                    ? 'Conflicts / destructive effects:'
                    : 'No conflicts.'}
                </p>
                <ul>
                  {preview.conflicts.map((conflict, i) => (
                    <li key={i}>{conflict}</li>
                  ))}
                </ul>
                <details>
                  <summary>Exact resulting workspace</summary>
                  <pre
                    style={{
                      maxHeight: 280,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {JSON.stringify(preview.workspace, null, 2)}
                  </pre>
                </details>
                <button
                  className="primary"
                  onClick={() =>
                    void run(async () => {
                      const token = preview.token;
                      setPreview(null);
                      await onApply(() =>
                        window.canopy.applyWorkspaceImport(token),
                      );
                      setCanUndo(true);
                      setMessage(
                        'Workspace imported. Undo is available until the workspace changes.',
                      );
                    })
                  }
                >
                  Apply reviewed {mode}
                </button>
              </>
            )}
          </>
        )}
        {canUndo && (
          <button
            onClick={() =>
              void run(async () => {
                await onApply(() => window.canopy.rollbackWorkspaceImport());
                setCanUndo(false);
                setMessage('Import undone.');
              })
            }
          >
            Undo last import
          </button>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="dialog-error">
          {error} Existing workspace remains intact if applying fails. Preview
          again after changes.
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
