import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Connection } from '../shared/types';
import { replaceFile } from './replace-file';

/** Allowlist only: never serialize connection objects, workspace data, or errors. */
export function diagnosticReport(input: {
  version: string;
  platform: string;
  demoMode: boolean;
  credentialStorage: 'available' | 'unavailable' | 'unlock-failed';
  connections: Connection[];
  retryAt: (connection: Connection) => number | null;
}) {
  return (
    JSON.stringify(
      {
        format: 'canopy-support-v1',
        version: input.version,
        platform: input.platform,
        demoMode: input.demoMode,
        credentialStorage: input.credentialStorage,
        connections: input.connections.map((connection) => ({
          provider: connection.provider === 'github' ? 'github' : 'jira',
          repositoryCount:
            connection.provider === 'github'
              ? (connection.repositories?.length ?? 0)
              : 0,
          retryAt: input.retryAt(connection),
        })),
        excluded: [
          'credentials',
          'account and site identities',
          'repository names',
          'workspace roots',
          'issue content',
          'raw errors and logs',
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

/** Export exactly the reviewed allowlist snapshot, after the user chooses a file. */
export async function exportDiagnosticReport(
  reviewed: unknown,
  expected: string | undefined,
  choosePath: () => Promise<string | undefined>,
): Promise<boolean> {
  if (typeof reviewed !== 'string' || reviewed !== expected)
    throw new Error('Review a fresh diagnostics report before exporting.');
  const path = await choosePath();
  if (!path) return false;
  const staging = await mkdtemp(join(dirname(path), '.canopy-diagnostics-'));
  try {
    const temporary = join(staging, 'report.json');
    await writeFile(temporary, reviewed, { mode: 0o600 });
    await replaceFile(temporary, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return true;
}
