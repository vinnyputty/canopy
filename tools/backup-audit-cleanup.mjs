// Lifecycle authority stays in the shared AuditOwner; this adapter retains work
// that a bounded wait cannot cancel before allowing disposable-profile removal.
import { finishAudit } from './audit-lifecycle.mjs';
import { rm } from 'node:fs/promises';

export function trackBackupOperation(pending, operation) {
  const promise = Promise.resolve().then(operation);
  pending.add(promise);
  const settled = () => pending.delete(promise);
  promise.then(settled, settled);
  return promise;
}

export async function finishBackupAudit({
  owner,
  confirmed = false,
  pending = new Set(),
  app,
  directory,
  failure,
  failed = failure !== undefined,
  diagnostics,
  timeoutMs = 5000,
}) {
  if (!owner) {
    const error = new Error('Missing audit owner; profile retained');
    throw new AggregateError(
      failed ? [failure, error] : [error],
      error.message,
      {
        cause: failed ? failure : error,
      },
    );
  }
  await finishAudit({
    owner,
    close:
      confirmed && app
        ? () => trackBackupOperation(pending, () => app.close())
        : undefined,
    primary: failure,
    primaryFailed: failed,
    diagnostics:
      failed && confirmed && diagnostics
        ? [
            {
              label: 'Sample diagnostics',
              run: () => trackBackupOperation(pending, diagnostics),
            },
          ]
        : [],
    removeProfile: async () => {
      if (!confirmed || !owner.child || pending.size)
        throw new Error(
          'Unconfirmed launch or unsettled audit operations; profile retained',
        );
      // Re-establish absence after all acquisitions/diagnostics/writers settle.
      // A prior timeout or parent exit cannot authorize directory deletion.
      const fresh = await owner.shutdown();
      if (!fresh.terminated || pending.size)
        throw new AggregateError(
          fresh.errors,
          'Owned scope uncertain; profile retained',
        );
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if (fresh.errors.length)
          throw new AggregateError(
            [error, ...fresh.errors],
            'Profile removal and fresh shutdown failed',
            { cause: error },
          );
        throw error;
      }
      if (fresh.errors.length)
        throw new AggregateError(
          fresh.errors,
          'Fresh audit shutdown failed after verified profile removal',
        );
    },
    writeEvidence: async () => {},
    secondary: (error) => console.error('Backup audit cleanup:', error),
    operationMs: timeoutMs,
  });
}
