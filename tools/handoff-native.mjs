import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHandoffTransport,
  observeHandoffClose,
} from './handoff-transport.mjs';
import { runSampleAudit, requireHandoffLifecycle } from './handoff-audit.mjs';

// No timer or PID-based authority here. Observe the original handle's full close
// (including stdio), preserving spawn errors until that observation settles.
export const observeDuplicate = observeHandoffClose;

export async function runHandoffCheck({ reviewedHead }) {
  requireHandoffLifecycle([reviewedHead]);
  const appPath = process.env.CANOPY_APP_PATH;
  const executable = process.env.CANOPY_ELECTRON_PATH;
  if (!appPath || !executable)
    throw new Error('Use the staged handoff_check target.');
  const profile = await mkdtemp(join(tmpdir(), 'canopy-handoff-audit-'));
  const env = { ...process.env, CANOPY_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CANOPY_DEMO_TEMP;
  const command = (key) => [
    appPath,
    '--canopy-demo',
    '--canopy-open',
    `canopy://handoff/issue?${new URLSearchParams({ connection: 'demo', provider: 'jira', host: 'example.invalid', root: 'CAN-100', key })}`,
  ];
  const transport = createHandoffTransport({
    profile,
    executable,
    open: ({ key }) =>
      electron.launch({ executablePath: executable, args: command(key), env }),
    duplicate: ({ key }) => {
      const child = spawn(
        executable,
        [
          ...command(key),
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        ],
        { env, stdio: 'ignore', detached: process.platform !== 'win32' },
      );
      return { child, closed: observeDuplicate(child) };
    },
  });
  await transport.deadline(
    () =>
      writeFile(
        join(profile, 'handoff-audit.json'),
        JSON.stringify({ kind: 'canopy-handoff-audit', reviewedHead }),
        { mode: 0o600 },
      ),
    30_000,
    'Sample marker',
  );
  await runSampleAudit({
    transport,
    options: {},
    expect,
    writeEvidence: (result) =>
      writeFile(
        join(profile, 'result.json'),
        JSON.stringify(
          { reviewedHead, platform: process.platform, ...result },
          null,
          2,
        ),
        { mode: 0o600 },
      ),
  });
  console.log(
    `Sample audit evidence retained in ${profile}; system clipboard NOT RUN.`,
  );
}
