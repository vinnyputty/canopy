import { AuditOwner, deadline, finishAudit } from './audit-lifecycle.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = require('electron/package.json');
const executablePath =
  process.env.CANOPY_ELECTRON_PATH ??
  join(
    tmpdir(),
    `canopy-electron-${version}-${process.platform}-${process.arch}`,
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron',
  );
const directory = await mkdtemp(join(tmpdir(), 'canopy-palette-85-'));
const evidence =
  process.env.CANOPY_PALETTE_EVIDENCE ??
  join(tmpdir(), 'canopy-issue-85-palette-evidence');
const owner = new AuditOwner({
  profile: directory,
  executable: executablePath,
});
const log = [];
const record = (message) => {
  log.push(message);
  console.log(message);
};
let app;
let page;
let failure;
let failed = false;
let auditSettled = false;
let auditRetained = false;
const errors = [];
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
async function audit() {
  const env = { ...process.env, CANOPY_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await owner.launch(() =>
    electron.launch({
      executablePath,
      args: [join(root, 'dist/smoke-main.cjs')],
      env,
      timeout: 30000,
    }),
  );
  owner.confirm(app.process());
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByText('Opening Canopy…')).toBeHidden();
  await app.evaluate(({ ipcMain }) => {
    const issue = (key, parentKey, done = false) => ({
      id: key,
      key,
      parentKey,
      summary: `Fixture ${key}`,
      type: 'Task',
      priority: { id: 'medium', name: 'Medium' },
      assignee: null,
      status: {
        id: done ? 'done' : 'todo',
        name: done ? 'Done' : 'To do',
        category: done ? 'done' : 'new',
      },
      links: [],
      labels: [],
    });
    const connections = [
      {
        id: 'demo',
        name: 'Fixture Alpha',
        provider: 'jira',
        url: 'https://alpha.example.invalid',
      },
      {
        id: 'fixture-beta',
        name: 'Fixture Beta',
        provider: 'jira',
        url: 'https://beta.example.invalid',
      },
    ];
    const state = {
      originals: new Map(),
      searchCalls: [],
      cancellations: [],
      holds: new Map(),
      treeCalls: [],
      issue,
      connections,
    };
    globalThis.paletteAudit = state;
    const replace = (name, handler) => {
      const channel = `canopy:${name}`;
      state.originals.set(channel, ipcMain._invokeHandlers.get(channel));
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => handler(...args));
    };
    replace('connections', () => connections);
    replace('currentUser', () => ({
      id: 'fixture-user',
      name: 'Sample user',
    }));
    replace('syncStatus', () => ({ retryAt: null }));
    replace('tree', (connectionId, rootKey) => {
      state.treeCalls.push([connectionId, rootKey]);
      const issues =
        rootKey === 'SHARED-1'
          ? [
              issue(rootKey),
              issue('PARENT-1', rootKey),
              issue('HIDDEN-1', 'PARENT-1', true),
              issue('DUP-1', rootKey),
              ...Array.from({ length: 100 }, (_, i) =>
                issue(`FILLER-${i}`, rootKey),
              ),
            ]
          : rootKey === 'SOURCE-1'
            ? [issue(rootKey), issue('SOURCE-CHILD', rootKey)]
            : [issue(rootKey)];
      return {
        rootKey,
        fetchedAt: Date.now(),
        warnings: ['Controlled partial snapshot'],
        issues,
        ranking: { state: 'unsupported', issueKeys: [] },
      };
    });
    replace('search', (connectionId, query, options) => {
      state.searchCalls.push({
        connectionId,
        query,
        requestId: options.requestId,
      });
      if (query.startsWith('hold'))
        return new Promise((resolve, reject) =>
          state.holds.set(query, { resolve, reject }),
        );
      return {
        issues: [issue(`REMOTE-${connectionId === 'demo' ? '1' : '2'}`)],
        boundaries: [],
        nextPageToken: undefined,
      };
    });
    // Intentionally ignore aborts; UI generation checks must reject late responses.
    replace('cancelSearch', (connectionId, requestId) => {
      state.cancellations.push({ connectionId, requestId });
    });
  });
  const fixtureWorkspace = {
    tabs: ['demo', 'fixture-beta'].map((connectionId, i) => ({
      id: `fixture-${i}`,
      connectionId,
      rootKey: 'SHARED-1',
      expanded: ['SHARED-1'],
      hideDone: true,
      filters: { status: 'todo' },
      selectedKey: 'SHARED-1',
      scrollTop: 0,
    })),
    activeTabId: 'fixture-0',
    recentRoots: [
      {
        connectionId: 'demo',
        rootKey: 'RECENT-1',
        summary: 'Recent fixture root',
      },
    ],
    savedViews: [
      {
        id: 'fixture-source',
        name: 'Fixture Source View',
        roots: [{ connectionId: 'fixture-beta', rootKey: 'SOURCE-1' }],
        connectionIds: [],
        filters: {
          assignee: 'any',
          statuses: [],
          priority: '',
          hideDone: false,
        },
        sort: { column: 'key', direction: 'asc' },
      },
    ],
    activeSavedViewId: 'fixture-source',
    shortcuts: {},
    theme: 'dark',
    sidebarCollapsed: false,
  };
  await page.evaluate(
    (workspace) => window.canopy.saveWorkspace(workspace),
    fixtureWorkspace,
  );
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Fixture Source View saved view' }),
  ).toBeVisible();
  await expect(
    page.getByText('Fixture SOURCE-CHILD', { exact: true }),
  ).toBeVisible();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox', { name: 'Search workspace' });
  const remote = page.getByRole('dialog', { name: 'Open issue tree' });
  const remoteInput = remote.getByRole('combobox', {
    name: 'Issue key, uppercase project prefix, Jira URL, or summary',
    exact: true,
  });
  const calls = () => app.evaluate(() => globalThis.paletteAudit.searchCalls);
  const open = async (query = '') => {
    await page.keyboard.press(`${modifier}+K`);
    await expect(input).toBeFocused();
    if (query) await input.fill(query);
  };
  const choose = async (query, type, context) => {
    await open(query);
    let result = palette.getByRole('option').filter({ hasText: type });
    if (context) result = result.filter({ hasText: context });
    await expect(result).toHaveCount(1);
    await result.click();
  };
  const snapshotFocus = async () =>
    page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      key: document.activeElement?.getAttribute('data-tree-key'),
    }));

  // Only an active saved view owns SOURCE-CHILD at this point; it has no open tab.
  await choose('SOURCE-CHILD', 'Loaded issue', 'Fixture Beta');
  await expect(
    page.getByRole('tree', { name: 'SOURCE-1 issue tree' }),
  ).toBeVisible();
  await expect(page.locator('[data-tree-key="SOURCE-CHILD"]')).toBeFocused();
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => window.canopy.loadWorkspace());
      return saved.tabs.find((tab) => tab.id === saved.activeTabId);
    })
    .toMatchObject({
      connectionId: 'fixture-beta',
      rootKey: 'SOURCE-1',
      selectedKey: 'SOURCE-CHILD',
    });
  record(
    'PASS saved-source-only loaded issue opens owning Fixture Beta SOURCE-1 root and focuses child',
  );

  await choose('SHARED-1', 'Open root', 'Fixture Alpha');
  await expect(
    page.getByRole('tree', { name: 'SHARED-1 issue tree' }),
  ).toBeVisible();
  await expect(page.locator('[data-tree-key="HIDDEN-1"]')).toHaveCount(0);
  const origin = page.locator('[data-tree-key="SHARED-1"]');
  await origin.focus();
  await open('DUP-1');
  const duplicates = palette
    .getByRole('option')
    .filter({ hasText: 'Loaded issue' });
  await expect(duplicates).toHaveCount(2);
  await expect(duplicates.nth(0)).toContainText('Fixture Alpha');
  await expect(duplicates.nth(1)).toContainText('Fixture Beta');
  await input.press('End');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.last().getAttribute('id'),
  );
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.first().getAttribute('id'),
  );
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.first().getAttribute('id'),
  );
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.last().getAttribute('id'),
  );
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.last().getAttribute('id'),
  );
  await input.press('Home');
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    await duplicates.first().getAttribute('id'),
  );
  await input.press('End');
  await input.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('[data-tree-key="DUP-1"]')).toBeFocused();
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => window.canopy.loadWorkspace());
      return saved.tabs.find((tab) => tab.id === saved.activeTabId);
    })
    .toMatchObject({
      connectionId: 'fixture-beta',
      rootKey: 'SHARED-1',
      selectedKey: 'DUP-1',
    });
  record(
    'PASS duplicate keys preserve connection identity; Home/End/ArrowUp/ArrowDown and Enter select Fixture Beta destination',
  );

  await choose('SHARED-1', 'Open root', 'Fixture Alpha');
  await origin.focus();
  await open('HIDDEN-1');
  await input.press('Home');
  await input.press('Enter');
  const hidden = page.locator('[data-tree-key="HIDDEN-1"]');
  await expect(hidden).toBeVisible();
  await expect(hidden).toBeFocused();
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => window.canopy.loadWorkspace());
      return saved.tabs.find((tab) => tab.id === saved.activeTabId);
    })
    .toMatchObject({
      hideDone: true,
      filters: { status: 'todo' },
      selectedKey: 'HIDDEN-1',
    });
  await expect(page.locator('[data-tree-key="PARENT-1"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  record(
    'PASS Enter reveals and focuses hidden done child below collapsed ancestors while retaining status filter/hide-done',
  );

  await hidden.focus();
  const scrollBefore = await page
    .locator('.tree-scroll')
    .evaluate((element) => {
      element.scrollTop = 150;
      return { top: element.scrollTop, left: element.scrollLeft };
    });
  expect(scrollBefore.top).toBeGreaterThan(0);
  await open('no-such-fixture-result');
  await expect(palette.getByText('No local matches')).toBeVisible();
  await input.press('Escape');
  await expect(hidden).toBeFocused();
  expect(
    await page.locator('.tree-scroll').evaluate((element) => ({
      top: element.scrollTop,
      left: element.scrollLeft,
    })),
  ).toEqual(scrollBefore);
  record(
    'PASS no-match Escape restores originating issue focus and nonzero scroll exactly',
  );
  for (const mode of ['close', 'backdrop']) {
    await open('DUP-1');
    if (mode === 'close')
      await palette.getByRole('button', { name: 'Close dialog' }).click();
    else
      await page
        .locator('.dialog-backdrop')
        .click({ position: { x: 3, y: 3 } });
    await expect(palette).toBeHidden();
    await expect(hidden).toBeFocused();
    record(`PASS ${mode} dismissal restores origin focus`);
  }
  await open('DUP-1');
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key);
      expect(
        await page.evaluate(() =>
          document.activeElement
            ?.closest('[role="dialog"]')
            ?.getAttribute('aria-labelledby'),
        ),
      ).toBe('dialog-title');
    }
  }
  await page.keyboard.press('Escape');
  await expect(hidden).toBeFocused();
  record('PASS repeated Tab and Shift+Tab remain contained in palette');

  await choose('RECENT-1', 'Recent root');
  await expect(
    page.getByRole('tree', { name: 'RECENT-1 issue tree' }),
  ).toBeVisible();
  await choose('Fixture Source View', 'Saved view');
  await expect(
    page.getByRole('region', { name: 'Fixture Source View saved view' }),
  ).toBeVisible();
  record('PASS recent root and saved view activation');

  await page.getByRole('button', { name: 'Triage inbox', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'Triage inbox', exact: true });
  await expect(inbox).toBeVisible();
  await choose('Fixture Source View', 'Saved view');
  await expect(
    page.getByRole('region', { name: 'Fixture Source View saved view' }),
  ).toBeVisible();
  await expect(inbox).toBeHidden();
  await expect(palette).toBeHidden();
  record(
    'PASS Inbox-to-saved-view palette handoff displays the requested view',
  );
  await choose('SHARED-1', 'Open root', 'Fixture Alpha');
  await origin.focus();
  await choose('Find in tree', 'Action');
  await expect(
    page.getByRole('textbox', { name: 'Find in tree' }),
  ).toBeFocused();
  await origin.focus();
  await choose('Refresh current tree', 'Action');
  await expect(origin).toBeFocused();
  await origin.press('ArrowDown');
  expect((await snapshotFocus()).key).not.toBe('SHARED-1');
  record(
    'PASS Find in tree action focuses search; Refresh action restores usable row keyboard focus',
  );

  const originBeforeRemote = await snapshotFocus();
  await choose('Fixture Beta', 'Connection');
  await expect(
    remote.getByRole('combobox', { name: 'Connection', exact: true }),
  ).toHaveValue('fixture-beta');
  await remoteInput.fill('local-only');
  await page.waitForTimeout(350);
  expect(await calls()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('Fixture Beta');
  await page.keyboard.press('Escape');
  expect(await snapshotFocus()).toEqual(originBeforeRemote);
  record(
    'PASS connection result scopes remote step; local typing and handoff make zero provider search calls; back/dismiss preserve focus',
  );

  const hold = async (query) => {
    await remoteInput.fill(query);
    await remote
      .getByRole('button', { name: 'Search issues', exact: true })
      .click();
    await expect
      .poll(async () => (await calls()).some((call) => call.query === query))
      .toBe(true);
  };
  const release = (query, reject = false) =>
    app.evaluate(
      (_electron, { query, reject }) => {
        const state = globalThis.paletteAudit;
        const held = state.holds.get(query);
        if (!held) throw new Error(`Missing hold ${query}`);
        if (reject) held.reject(new Error('Obsolete controlled failure'));
        else
          held.resolve({
            issues: [state.issue('OBSOLETE-1')],
            boundaries: [{ repository: 'old/repo', reason: 'incomplete' }],
            nextPageToken: 'old-page',
          });
        state.holds.delete(query);
      },
      { query, reject },
    );
  await open('handoff-query');
  await palette.getByRole('button', { name: 'Search remote issues…' }).click();
  await expect(remoteInput).toHaveValue('handoff-query');
  await hold('hold-query');
  await remoteInput.fill('fresh-query');
  await release('hold-query');
  await page.waitForTimeout(150);
  await expect(
    remote.getByRole('listbox', { name: 'Issue results' }).getByRole('option'),
  ).toHaveCount(0);
  await expect(
    remote.getByText(/old\/repo|OBSOLETE|Obsolete controlled failure/),
  ).toHaveCount(0);
  await expect(remoteInput).toBeFocused();
  record(
    'PASS query-change race rejects ignored-abort late success/boundaries/pagination and retains remote input focus',
  );

  await hold('hold-connection');
  await remote
    .getByRole('combobox', { name: 'Connection', exact: true })
    .selectOption('fixture-beta');
  await remoteInput.focus();
  await release('hold-connection', true);
  await page.waitForTimeout(150);
  await expect(remote.getByRole('alert')).toHaveCount(0);
  await expect(
    remote.getByRole('listbox', { name: 'Issue results' }).getByRole('option'),
  ).toHaveCount(0);
  await expect(remoteInput).toBeFocused();
  await remoteInput.fill('fresh-beta');
  await remote
    .getByRole('button', { name: 'Search issues', exact: true })
    .click();
  await expect(
    remote.getByRole('listbox', { name: 'Issue results' }).getByRole('option'),
  ).toContainText('REMOTE-2');
  expect((await calls()).at(-1)).toMatchObject({
    connectionId: 'fixture-beta',
    query: 'fresh-beta',
  });
  record(
    'PASS connection-change race rejects ignored-abort late failure; explicit fresh search uses Fixture Beta',
  );

  await hold('hold-back');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('handoff-query');
  await release('hold-back');
  await page.waitForTimeout(150);
  await expect(remote).toBeHidden();
  await expect(input).toBeFocused();
  await expect(palette.getByText(/OBSOLETE|old\/repo/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await snapshotFocus()).toEqual(originBeforeRemote);
  record(
    'PASS remote-dismiss race rejects late success and preserves palette/origin focus',
  );
  await open('handoff-query');
  await palette.getByRole('button', { name: 'Search remote issues…' }).click();
  await hold('hold-full-dismiss');
  await remote.getByRole('button', { name: 'Close dialog' }).click();
  await palette.getByRole('button', { name: 'Close dialog' }).click();
  expect(await snapshotFocus()).toEqual(originBeforeRemote);
  await release('hold-full-dismiss', true);
  await page.waitForTimeout(150);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await snapshotFocus()).toEqual(originBeforeRemote);
  record(
    'PASS full-dismiss race rejects late failure and does not reopen a dialog or steal origin focus',
  );
  expect(
    await app.evaluate(() => globalThis.paletteAudit.cancellations.length),
  ).toBeGreaterThanOrEqual(4);
  expect(errors).toEqual([]);
  record(
    `PASS renderer errors: zero; platform ${process.platform}/${process.arch}; native default ${modifier}+K exercised, no claim of other OS execution`,
  );
  await app.evaluate(({ BrowserWindow }, modifier) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.focus();
    const modifiers = [modifier === 'Meta' ? 'meta' : 'control'];
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'K',
      modifiers,
    });
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'K',
      modifiers,
    });
  }, modifier);
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await snapshotFocus()).toEqual(originBeforeRemote);
  record(
    `PASS Electron sendInputEvent native ${modifier}+K opens palette and Escape restores focus`,
  );
  await mkdir(evidence, { recursive: true });
  await open('DUP-1');
  await page.screenshot({
    path: join(evidence, 'duplicate-connections.png'),
  });
  await page.keyboard.press('Escape');
}
try {
  await deadline(
    () =>
      Promise.resolve()
        .then(audit)
        .finally(() => {
          auditSettled = true;
        }),
    180000,
    'Palette audit',
  );
} catch (error) {
  if (!auditSettled) auditRetained = true;
  failed = true;
  failure = error;
  record(`FAIL ${String(error?.stack ?? error)}`);
} finally {
  await finishAudit({
    owner,
    close: app ? () => app.close() : undefined,
    primary: failure,
    primaryFailed: failed,
    operationsSettled: () => auditSettled && !auditRetained,
    diagnostics:
      failed && page && !page.isClosed()
        ? [
            {
              label: 'Failure screenshot',
              run: async () => {
                await mkdir(evidence, { recursive: true });
                await page.screenshot({
                  path: join(evidence, 'failure.png'),
                  timeout: 3000,
                });
              },
            },
            {
              label: 'Failure DOM',
              run: async () => {
                await mkdir(evidence, { recursive: true });
                const content = await page
                  .locator('body')
                  .innerText({ timeout: 3000 });
                await writeFile(join(evidence, 'failure-dom.txt'), content);
              },
            },
          ]
        : [],
    removeProfile: async () => {
      await rm(directory, { recursive: true, force: true });
      record(
        `CLEANUP verified owned scope terminated; sample profile removed: ${directory}`,
      );
    },
    writeEvidence: async () => {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'checks.log'), log.join('\n') + '\n');
    },
    secondary: (error) => record(`SECONDARY ${String(error?.stack ?? error)}`),
  });
}
