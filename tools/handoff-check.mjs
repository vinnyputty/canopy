// Manual target: requires fresh source review and the lead's exclusive native token.
import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const reviewedHead = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(reviewedHead ?? ''))
  throw new Error(
    'Pass the freshly reviewed exact head. Run only with the exclusive native token.',
  );
const profile = await mkdtemp(join(tmpdir(), 'canopy-handoff-audit-'));
await writeFile(
  join(profile, 'handoff-audit.json'),
  JSON.stringify({ kind: 'canopy-handoff-audit', reviewedHead }),
  { mode: 0o600 },
);
const appPath = process.env.CANOPY_APP_PATH;
const executablePath = process.env.CANOPY_ELECTRON_PATH;
if (!appPath || !executablePath)
  throw new Error('Use the handoff_check target.');
const env = { ...process.env, CANOPY_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANOPY_DEMO_TEMP;
const payload = (key) =>
  `canopy://handoff/issue?${new URLSearchParams({ connection: 'demo', provider: 'jira', host: 'example.invalid', root: 'CAN-100', key })}`;
const command = (key) => [
  appPath,
  '--canopy-demo',
  '--canopy-open',
  payload(key),
];
let session;
async function duplicate(key) {
  const child = spawn(
    executablePath,
    [
      ...command(key),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    { env, stdio: 'ignore' },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Duplicate launch timed out'));
    }, 10000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('Duplicate launch failed'));
    });
  });
}
try {
  session = await electron.launch({
    executablePath,
    args: command('CAN-111'),
    env,
  });
  const page = await session.firstWindow();
  await expect(page.locator('[data-tree-key="CAN-111"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await session.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].minimize(),
  );
  await duplicate('CAN-112');
  await expect(page.locator('[data-tree-key="CAN-112"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() =>
      session.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return (
          windows.length === 1 &&
          !windows[0].isMinimized() &&
          windows[0].isFocused()
        );
      }),
    )
    .toBe(true);
  await page.locator('[data-tree-key="CAN-112"]').press('Space');
  await page
    .getByRole('button', { name: 'Copy work brief', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Copy format').selectOption('custom');
  const text = await dialog.locator('pre').textContent();
  await dialog
    .getByRole('button', { name: 'Copy issue context', exact: true })
    .click();
  const copied = await session.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  if (copied !== text)
    throw new Error('Clipboard differs from reviewed sample text.');
  await writeFile(
    join(profile, 'result.json'),
    JSON.stringify(
      {
        reviewedHead,
        platform: process.platform,
        startup: true,
        running: true,
        minimizedFocus: true,
        reviewedCopy: true,
      },
      null,
      2,
    ),
  );
  console.log(`Handoff audit evidence retained in ${profile}`);
} finally {
  if (session) await session.close();
}
