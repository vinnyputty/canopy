// Desktop-token gate applies. Use a staged smoke-main sample app and runtime.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [sampleApp, runtime] = process.argv.slice(2);
if (!sampleApp || !runtime)
  throw new Error(
    'Usage after desktop token: node tools/smoke-backup.mjs <staged sample app> <Electron runtime>',
  );
const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-ui-'));
const userData = join(directory, 'profile');
const backupPath = join(directory, 'reviewed.json');
const importPath = join(directory, 'import.json');
const env = { ...process.env, CANOPY_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: [resolve(sampleApp)],
    executablePath: resolve(runtime),
    env,
  });
  expect(
    await app.evaluate(() => globalThis.canopyBackupKeychainForbidden),
  ).toBe(true);
  const page = await app.firstWindow();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const openPanel = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Workspace backup and transfer',
        exact: true,
      })
      .click();
    return page.getByRole('dialog', {
      name: 'Workspace backup and transfer',
      exact: true,
    });
  };
  // Only native choosers are stubbed; transfer IPC, validator, Storage and reload are real.
  await app.evaluate(
    ({ dialog }, paths) => {
      globalThis.backupChooser = { cancel: false };
      dialog.showSaveDialog = async () =>
        globalThis.backupChooser.cancel
          ? { canceled: true }
          : { canceled: false, filePath: paths.backup };
      dialog.showOpenDialog = async () =>
        globalThis.backupChooser.cancel
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [paths.imported] };
    },
    { backup: backupPath, imported: importPath },
  );
  let panel = await openPanel();
  await panel
    .getByRole('button', { name: 'Review export metadata', exact: true })
    .click();
  await expect(panel.locator('pre').first()).toContainText('canopy-workspace');
  const reviewed = JSON.parse(await panel.locator('pre').first().innerText());
  for (const name of ['credentials', 'token', 'seenRoots', 'issueSnapshots'])
    expect(Object.hasOwn(reviewed.workspace, name)).toBe(false);
  await panel
    .getByRole('button', { name: 'Export reviewed backup…', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Backup exported.');
  expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(reviewed);
  await app.evaluate(() => {
    globalThis.backupChooser.cancel = true;
  });
  await panel
    .getByRole('button', { name: 'Export reviewed backup…', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Export canceled.');
  await panel
    .getByRole('button', { name: 'Choose backup to preview…', exact: true })
    .click();
  await app.evaluate(() => {
    globalThis.backupChooser.cancel = false;
  });
  await writeFile(importPath, '{"format":');
  await panel
    .getByRole('button', { name: 'Choose backup to preview…', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('complete JSON');
  const incoming = structuredClone(reviewed);
  incoming.workspace.theme = 'dark';
  incoming.workspace.palette = 'forest';
  incoming.workspace.savedViews ??= [];
  incoming.workspace.savedViews.push({
    id: 'transfer-sample',
    name: 'Transferred sample',
    roots: [],
    connectionIds: incoming.connections.map((c) => c.id),
    filters: { assignee: 'any', statuses: [], priority: '', hideDone: false },
    sort: { column: 'key', direction: 'asc' },
  });
  await writeFile(importPath, JSON.stringify(incoming));
  await panel
    .getByRole('button', { name: 'Choose backup to preview…', exact: true })
    .click();
  await expect(
    panel.getByRole('button', {
      name: 'Preview effects and conflicts',
      exact: true,
    }),
  ).toBeDisabled();
  for (const c of incoming.connections)
    await panel.getByLabel(`Map ${c.name}`, { exact: true }).selectOption(c.id);
  await panel
    .getByRole('button', { name: 'Preview effects and conflicts', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Apply reviewed merge', exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'Import behavior', exact: true })
    .selectOption('replace');
  await expect(
    panel.getByRole('button', { name: 'Apply reviewed merge', exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole('button', { name: 'Preview effects and conflicts', exact: true })
    .click();
  await expect(panel).toContainText('Replace removes existing roots');
  await panel
    .getByRole('button', { name: 'Apply reviewed replace', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  panel = await openPanel();
  await expect(
    panel.getByRole('button', { name: 'Undo last import', exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Undo last import', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    reviewed.workspace.theme,
  );
  expect(await app.evaluate(() => globalThis.canopyKeychainAccesses ?? 0)).toBe(
    0,
  );
  console.log(
    'Sample backup UI audit passed with stubbed choosers. Native acceptance remains separate.',
  );
} finally {
  try {
    if (app) await app.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
