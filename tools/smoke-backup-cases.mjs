import { finishBackupAudit } from './backup-audit-cleanup.mjs';
// Exclusive desktop token required; stage-backup-smoke supplies forbidden keychain and fake providers.
import { _electron as electron, expect } from '@playwright/test';
import { auditSearch } from './smoke-search.mjs';
import { auditRefresh } from './smoke-refresh.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const [sampleApp, runtime] = process.argv.slice(2);
if (!sampleApp || !runtime)
  throw new Error(
    'Usage: smoke-backup-cases.mjs <staged backup sample app> <Electron runtime>',
  );
const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-cases-'));
const profile = join(directory, 'profile');
const importedFile = join(directory, 'incoming.json');
const exportedFile = join(directory, 'exported.json');
const env = { ...process.env, CANOPY_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
let failure;
let failed = false;
const errors = [];
const mark = (label) => {
  console.log(`PASS ${label}`);
};
try {
  app = await electron.launch({
    args: [resolve(sampleApp)],
    executablePath: resolve(runtime),
    env,
  });
  expect(
    await app.evaluate(() => globalThis.canopyBackupKeychainForbidden),
  ).toBe(true);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: paths.exported,
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths.imported],
      });
    },
    { imported: importedFile, exported: exportedFile },
  );
  const panelLocator = () =>
    page.getByRole('dialog', {
      name: 'Workspace backup and transfer',
      exact: true,
    });
  const open = async (keyboard = false) => {
    const trigger = page.getByRole('button', { name: 'Settings', exact: true });
    if (keyboard) {
      await trigger.focus();
      await trigger.press('Enter');
    } else await trigger.click();
    const link = page.getByRole('button', {
      name: 'Workspace backup and transfer',
      exact: true,
    });
    if (keyboard) await link.press('Enter');
    else await link.click();
    await expect(panelLocator()).toBeVisible();
    return panelLocator();
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await expect(panelLocator()).toHaveCount(0);
  };
  const saved = async () =>
    JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8'));
  const seed = async (workspace) => {
    await page.evaluate(async (value) => {
      await window.canopy.saveWorkspace(value);
      await window.canopy.reloadWorkspace();
    }, workspace);
    await expect(
      page.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await saved()).theme).toBe(workspace.theme);
  };
  let panel = await open(true);
  await expect(
    panel.getByRole('button', { name: 'Close dialog', exact: true }),
  ).toBeFocused();
  for (const key of ['Tab', 'Shift+Tab'])
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      expect(
        await panel.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
  await close();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  mark(
    'Settings keyboard entry, initial focus, Tab/Shift+Tab containment, Escape and trigger focus',
  );
  panel = await open();
  await panel
    .getByRole('button', { name: 'Review export metadata', exact: true })
    .click();
  const initial = JSON.parse(await panel.locator('pre').first().innerText());
  await close();
  const rootView = {
    columns: ['issue', 'priority', 'assignee', 'status'],
    widths: { issue: 888, priority: 104, assignee: 165, status: 128 },
    sort: { column: 'rank', direction: 'asc' },
    hideDone: false,
    assumeMatchingStatusTransitions: true,
    filters: {},
  };
  const tab = (id, connectionId, rootKey = 'CAN-100', view = rootView) => ({
    id,
    connectionId,
    rootKey,
    summary: 'Sample issue root',
    expanded: [],
    hideDone: false,
    scrollTop: 0,
    view,
  });
  const baseline = {
    ...initial.workspace,
    tabs: [],
    activeTabId: null,
    theme: 'system',
    palette: 'default',
    reading: { textSize: 'medium', spacing: 'compact' },
    savedViews: [
      {
        id: 'collision-id',
        name: 'Local sample',
        roots: [],
        connectionIds: ['demo'],
        filters: {
          assignee: 'any',
          statuses: [],
          priority: '',
          hideDone: false,
        },
        sort: { column: 'key', direction: 'asc' },
      },
    ],
    activeSavedViewId: null,
    pinnedRoots: [{ connectionId: 'demo', rootKey: 'CAN-100' }],
    recentRoots: [],
    rootViews: {},
    viewDefaults: {},
    closedTabs: [
      tab('closed-new', 'demo', 'CAN-200'),
      tab('closed-old', 'demo', 'CAN-200'),
    ],
    seenRoots: {
      'demo:CAN-100': {
        touchedAt: 1,
        issues: {
          'CAN-100': {
            seenAt: 1,
            fields: { summary: 'PRIVATE SAMPLE BASELINE' },
          },
        },
      },
    },
  };
  await seed(baseline);
  await writeFile(join(profile, 'credentials.json'), 'FAKE OPAQUE SAMPLE FILE');
  await writeFile(join(profile, 'tree-cache.json'), 'PRIVATE SAMPLE CACHE');
  panel = await open();
  await panel
    .getByRole('button', { name: 'Review export metadata', exact: true })
    .click();
  const exact = await panel.locator('pre').first().innerText();
  expect(exact).not.toContain('PRIVATE SAMPLE');
  expect(exact).not.toContain('FAKE OPAQUE');
  const portable = JSON.parse(exact);
  expect(portable.workspace.closedTabs).toHaveLength(1);
  for (const c of portable.connections)
    expect(Object.keys(c).sort()).toEqual(['id', 'name', 'provider', 'url']);
  await panel
    .getByRole('button', { name: 'Export reviewed backup…', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Backup exported.');
  expect(await readFile(exportedFile, 'utf8')).toBe(exact);
  await close();
  mark(
    'Exact reviewed export bytes, newest closed history, private baseline/cache/credential exclusions',
  );
  const local = {
    ...baseline,
    closedTabs: [],
    tabs: [tab('shared-id', 'demo')],
    activeTabId: 'shared-id',
  };
  delete local.rootViews;
  delete local.viewDefaults;
  await seed(local);
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  const incomingView = {
    ...rootView,
    widths: { ...rootView.widths, issue: 777 },
  };
  const incoming = {
    format: 'canopy-workspace',
    version: 1,
    createdAt: new Date().toISOString(),
    connections: [
      {
        id: 'origin-a',
        name: 'Origin A',
        provider: 'jira',
        url: 'https://example.invalid',
      },
      {
        id: 'origin-b',
        name: 'Origin B',
        provider: 'jira',
        url: 'https://example.invalid',
      },
    ],
    workspace: {
      ...initial.workspace,
      tabs: [
        tab('shared-id', 'origin-a', 'CAN-100', incomingView),
        tab('beta-tab', 'origin-b', 'CAN-100', incomingView),
      ],
      activeTabId: 'shared-id',
      theme: 'dark',
      palette: 'forest',
      savedViews: [
        {
          ...baseline.savedViews[0],
          name: 'Imported collision',
          connectionIds: ['origin-a'],
        },
      ],
      activeSavedViewId: null,
      pinnedRoots: [
        { connectionId: 'origin-a', rootKey: 'CAN-100' },
        { connectionId: 'origin-b', rootKey: 'CAN-100' },
      ],
      recentRoots: [],
      closedTabs: [],
    },
  };
  delete incoming.workspace.rootViews;
  delete incoming.workspace.viewDefaults;
  const choose = async (value = incoming) => {
    await writeFile(importedFile, JSON.stringify(value));
    const panel = panelLocator();
    await panel
      .getByRole('button', { name: 'Choose backup to preview…', exact: true })
      .click();
    return panel;
  };
  const map = async (a = 'demo', b = 'fixture-beta') => {
    const panel = panelLocator();
    await panel.getByLabel('Map Origin A', { exact: true }).selectOption(a);
    await panel.getByLabel('Map Origin B', { exact: true }).selectOption(b);
  };
  const preview = async (mode = 'merge') => {
    const panel = panelLocator();
    await panel
      .getByRole('combobox', { name: /^Import behavior/ })
      .selectOption(mode);
    await panel
      .getByRole('button', {
        name: 'Preview effects and conflicts',
        exact: true,
      })
      .click();
    await expect(
      panel.getByRole('button', {
        name: `Apply reviewed ${mode}`,
        exact: true,
      }),
    ).toBeVisible();
    return JSON.parse(await panel.locator('pre').last().textContent());
  };
  const apply = async (mode) => {
    await page.evaluate(() => {
      window.backupReloadSentinel = true;
    });
    await panelLocator()
      .getByRole('button', { name: `Apply reviewed ${mode}`, exact: true })
      .click();
    await expect(panelLocator()).toHaveCount(0);
    expect(
      await page.evaluate(() => window.backupReloadSentinel),
    ).toBeUndefined();
  };
  panel = await open();
  await choose();
  await expect(
    panel.getByRole('button', {
      name: 'Preview effects and conflicts',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(panel).toContainText('beta-sample-account');
  await expect(panel).toContainText('sample/repo');
  await map('demo', 'demo');
  await panel
    .getByRole('button', { name: 'Preview effects and conflicts', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('distinct destination');
  const incompatible = structuredClone(incoming);
  incompatible.connections[1].url = 'https://other.invalid';
  await choose(incompatible);
  await expect(
    panel.getByLabel('Map Origin B', { exact: true }).locator('option'),
  ).toHaveCount(1);
  await choose();
  await map();
  const merged = await preview();
  expect(merged.tabs.map((t) => [t.connectionId, t.rootKey])).toEqual([
    ['demo', 'CAN-100'],
    ['fixture-beta', 'CAN-100'],
  ]);
  expect(merged.tabs[0].view.widths.issue).toBe(888);
  expect(merged.tabs[1].view.widths.issue).toBe(777);
  expect(merged.theme).toBe('system');
  expect(merged.savedViews[0].name).toBe('Local sample');
  await expect(panel).toContainText('Open root:');
  await expect(panel).toContainText('Saved view:');
  await expect(panel).toContainText('Root view:');
  const replaced = await preview('replace');
  expect(replaced.tabs[0].view.widths.issue).toBe(777);
  expect(replaced.theme).toBe('dark');
  await expect(panel).toContainText('Replace removes existing roots');
  await preview();
  await apply('merge');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect
    .poll(() => app.evaluate(() => globalThis.canopyBackupBetaFetches ?? 0))
    .toBeGreaterThan(0);
  mark(
    'Explicit provider/account mapping, unavailable server, duplicate destination rejection, duplicate keys across connections, conflict precedence, merge/replace effects, fresh mapped fetch and renderer reload',
  );
  panel = await open();
  await choose();
  await map();
  await preview();
  await app.evaluate(() => {
    globalThis.canopyBackupExtraConnections = [
      {
        id: 'fixture-beta',
        name: 'Sample Beta',
        provider: 'jira',
        url: 'https://example.invalid',
        accountName: 'changed-sample-account',
        repositories: ['sample/repo'],
      },
    ];
  });
  await panel
    .getByRole('button', { name: 'Apply reviewed merge', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('preview expired');
  await app.evaluate(() => {
    delete globalThis.canopyBackupExtraConnections;
  });
  await close();
  mark('Stale connection/account approval rejected by actual Apply UI');
  await seed({ ...baseline, closedTabs: [], seenRoots: {} });
  const noRoots = structuredClone(incoming);
  noRoots.workspace.tabs = [];
  noRoots.workspace.activeTabId = null;
  noRoots.workspace.savedViews = [];
  noRoots.workspace.pinnedRoots = [];
  panel = await open();
  await choose(noRoots);
  await map();
  await preview('replace');
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('canopy:applyWorkspaceImport');
    const save = ipcMain._invokeHandlers.get('canopy:saveWorkspace');
    const load = ipcMain._invokeHandlers.get('canopy:loadWorkspace');
    ipcMain.removeHandler('canopy:applyWorkspaceImport');
    ipcMain.handle('canopy:applyWorkspaceImport', async (event, token) => {
      ipcMain.removeHandler('canopy:applyWorkspaceImport');
      ipcMain.handle('canopy:applyWorkspaceImport', original);
      const value = await load(event);
      await save(event, {
        ...value,
        sidebarCollapsed: !value.sidebarCollapsed,
      });
      return original(event, token);
    });
  });
  await panel
    .getByRole('button', { name: 'Apply reviewed replace', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('changed after preview');
  expect((await saved()).sidebarCollapsed).toBe(true);
  await close();
  mark(
    'Concurrent sample workspace write rejects stale preview and preserves the intervening edit',
  );
  for (const mode of ['staging', 'replacement']) {
    await seed({ ...baseline, closedTabs: [], seenRoots: {} });
    panel = await open();
    await choose(noRoots);
    await map();
    await preview('replace');
    const before = await readFile(join(profile, 'workspace.json'), 'utf8');
    await app.evaluate((_electron, mode) => {
      globalThis.canopyBackupFault = { mode, theme: 'dark' };
    }, mode);
    await panel
      .getByRole('button', { name: 'Apply reviewed replace', exact: true })
      .click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(await readFile(join(profile, 'workspace.json'), 'utf8')).toBe(
      before,
    );
    const result = await app.evaluate(() => globalThis.canopyBackupFaultResult);
    expect(result.mode).toBe(mode);
    expect(['EISDIR', 'EACCES', 'EPERM']).toContain(result.code);
    await expect
      .poll(async () => {
        try {
          await readFile(join(profile, 'workspace.json.tmp'));
          return false;
        } catch (e) {
          return e.code === 'ENOENT';
        }
      })
      .toBe(true);
    await close();
    mark(
      `Actual macOS filesystem ${mode} failure preserves workspace bytes and removes staging file`,
    );
  }
  await seed({ ...baseline, closedTabs: [], seenRoots: {} });
  panel = await open();
  await choose(noRoots);
  await map();
  await preview('replace');
  await apply('replace');
  panel = await open();
  await panel
    .getByRole('button', { name: 'Undo last import', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  panel = await open();
  await choose(noRoots);
  await map();
  await preview('replace');
  await apply('replace');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Text size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => (await saved()).reading.textSize).toBe('large');
  panel = await open();
  await panel
    .getByRole('button', { name: 'Undo last import', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('changed after preview');
  expect((await saved()).reading.textSize).toBe('large');
  expect((await saved()).theme).toBe('dark');
  await close();
  mark(
    'Renderer reload and successful Undo before edits; Undo refusal preserves subsequent reading edits',
  );
  expect(await readFile(join(profile, 'credentials.json'), 'utf8')).toBe(
    'FAKE OPAQUE SAMPLE FILE',
  );
  expect(await readFile(join(profile, 'tree-cache.json'), 'utf8')).toBe(
    'PRIVATE SAMPLE CACHE',
  );
  await app.evaluate(() => {
    globalThis.canopyBackupExtraConnections = [];
  });
  const surrounding = {
    ...baseline,
    closedTabs: [],
    seenRoots: {},
    tabs: [tab('can100', 'demo'), tab('can200', 'demo', 'CAN-200')],
    activeTabId: 'can200',
    savedViews: [],
    pinnedRoots: [],
    rootViews: {},
    viewDefaults: {},
  };
  await seed(surrounding);
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await auditSearch(app, page);
  await seed(surrounding);
  await auditRefresh(app, page, async (height) => {
    await app.evaluate(
      ({ BrowserWindow }, height) =>
        BrowserWindow.getAllWindows()[0].setSize(1100, height),
      height,
    );
  });
  mark(
    'Existing search and adaptive-refresh smoke on controlled sample provider',
  );
  expect(await app.evaluate(() => globalThis.canopyKeychainAccesses ?? 0)).toBe(
    0,
  );
  expect(errors).toEqual([]);
  mark(
    'Zero forbidden keychain accesses, unchanged fake credential/cache files, no renderer page errors',
  );
} catch (error) {
  failure = error;
  failed = true;
} finally {
  await finishBackupAudit({
    app,
    directory,
    failure,
    failed,
    diagnostics: async () => {
      if (page && !page.isClosed())
        console.error(
          'Sample UI diagnostics',
          await page.locator('body').innerText(),
        );
    },
  });
}
