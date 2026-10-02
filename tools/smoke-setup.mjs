import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Isolated source/UI fixtures; no provider, browser, keychain, or clipboard use. */
export async function auditSetup(app, page) {
  await expect
    .poll(() => page.evaluate(() => window.canopy.loadWorkspace()))
    .not.toBeNull();
  const originalWorkspace = await page.evaluate(() =>
    window.canopy.loadWorkspace(),
  );
  await app.evaluate(({ ipcMain, dialog, app: desktop }) => {
    const other = {
      id: 'token:fixture-other',
      provider: 'jira',
      name: 'Other fixture',
      url: 'https://other.atlassian.net',
    };
    const team = {
      id: 'token:fixture-team',
      provider: 'jira',
      name: 'Team fixture',
      url: 'https://team.atlassian.net',
    };
    const state = (globalThis.setupAudit = {
      other,
      team,
      pending: [],
      handlers: new Map(),
      attempts: 0,
      rootReads: [],
    });
    state.saveDialog = dialog.showSaveDialog;
    state.exportMode = 'cancel';
    state.exportPath = `${desktop.getPath('userData')}/diagnostics-fixture.json`;
    dialog.showSaveDialog = async () =>
      state.exportMode === 'cancel'
        ? { canceled: true }
        : {
            canceled: false,
            filePath:
              state.exportMode === 'failure'
                ? `${desktop.getPath('userData')}/missing/report.json`
                : state.exportPath,
          };
    const replace = (name, handler) => {
      const channel = `canopy:${name}`;
      state.handlers.set(channel, ipcMain._invokeHandlers.get(channel));
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('connections', () => [other, team]);
    const deferredConnect = () => {
      state.attempts++;
      return new Promise((resolve, reject) =>
        state.pending.push({ resolve, reject }),
      );
    };
    replace('connect', deferredConnect);
    replace('connectGithub', deferredConnect);
    replace('currentUser', () => ({
      id: 'fixture-user',
      name: 'Fixture user',
    }));
    replace('search', () => ({ issues: [] }));
    replace('tree', (_event, id, rootKey) => {
      state.rootReads.push({ id, rootKey });
      return {
        rootKey,
        issues: [
          {
            id: rootKey,
            key: rootKey,
            summary: 'Fixture root',
            type: 'Task',
            priority: null,
            assignee: null,
            status: { id: 'todo', name: 'To do', category: 'new' },
            links: [],
          },
        ],
        warnings: [],
        fetchedAt: Date.now(),
      };
    });
    replace('syncStatus', () => ({ retryAt: null }));
    replace('priorityOrder', () => []);
    replace('transitions', () => []);
    replace('workflowGraph', () => null);
  });
  const sidebar = page.getByRole('complementary', { name: 'Canopy sidebar' });
  const start = () =>
    sidebar
      .getByRole('button', { name: 'Connect Jira or GitHub', exact: true })
      .first()
      .click();
  const fillJira = async (url) => {
    await page.getByLabel('Jira site URL').fill(url);
    await page.getByLabel('Atlassian email').fill('fixture@example.invalid');
    await page.getByPlaceholder('Paste your token').fill('fixture-only-token');
  };
  const settle = (failure = false) =>
    app.evaluate((_electron, failure) => {
      const state = globalThis.setupAudit;
      const pending = state.pending.shift();
      if (failure) pending.reject(new Error('Fixture late failure'));
      else pending.resolve([state.other, state.team]);
    }, failure);
  const flushRenderer = () =>
    page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  try {
    await page.evaluate(
      (workspace) =>
        window.canopy.saveWorkspace({
          ...workspace,
          tabs: [
            {
              id: 'fixture-root',
              connectionId: 'token:fixture-other',
              rootKey: 'OTHER-1',
              summary: 'Fixture root',
              expanded: ['OTHER-1'],
              linkedExpanded: [],
              hideDone: true,
              selectedKey: 'OTHER-1',
              filters: { status: 'To do' },
              scrollTop: 0,
            },
          ],
          activeTabId: 'fixture-root',
        }),
      originalWorkspace,
    );
    await page.reload();
    await expect(
      page.getByRole('tree', { name: 'OTHER-1 issue tree' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.canopy.loadWorkspace())?.tabs[0]?.rootKey,
        ),
      )
      .toBe('OTHER-1');
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean((await window.canopy.loadWorkspace())?.tabs[0]?.view),
        ),
      )
      .toBe(true);
    await page
      .getByLabel('Filter status', { exact: true })
      .selectOption('To do');
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.canopy.loadWorkspace())?.tabs[0]?.filters?.status,
        ),
      )
      .toBe('todo');
    const before = await page.evaluate(() => window.canopy.loadWorkspace());
    let attempts = 0;
    for (const [method, provider, failure] of [
      ['close', 'jira', false],
      ['escape', 'oauth', true],
      ['backdrop', 'github', false],
    ]) {
      await start();
      if (provider === 'github') {
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'GitHub', exact: true })
          .click();
        await page
          .getByPlaceholder('owner/repo-one, owner/repo-two')
          .fill('fixture/repository');
        await page
          .getByPlaceholder('Paste your token')
          .fill('fixture-only-token');
        await page
          .getByRole('button', { name: 'Verify and save GitHub', exact: true })
          .click();
      } else if (provider === 'oauth') {
        await page
          .getByRole('button', { name: 'Sign in with browser', exact: true })
          .click();
      } else {
        await fillJira('https://team.atlassian.net');
        await page
          .getByRole('button', { name: 'Verify and save Jira', exact: true })
          .click();
      }
      await expect
        .poll(() => app.evaluate(() => globalThis.setupAudit.attempts))
        .toBe(++attempts);
      if (method === 'close')
        await page
          .getByRole('button', { name: 'Close dialog', exact: true })
          .click();
      else if (method === 'escape') await page.keyboard.press('Escape');
      else
        await page
          .locator('.dialog-backdrop')
          .click({ position: { x: 2, y: 2 } });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await sidebar
        .getByRole('button', { name: 'Setup help', exact: true })
        .click();
      await settle(failure);
      await flushRenderer();
      await expect(
        page.getByRole('dialog', { name: 'Setup help', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('dialog', { name: 'Connection verified', exact: true }),
      ).toHaveCount(0);
      const after = await page.evaluate(() => window.canopy.loadWorkspace());
      expect(after.tabs).toEqual(before.tabs);
      expect(after.activeTabId).toEqual(before.activeTabId);
      await expect(
        page.getByRole('tree', { name: 'OTHER-1 issue tree' }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Close dialog', exact: true })
        .click();
    }
    let rootNumber = 0;
    for (const url of [
      'https://TEAM.atlassian.net',
      'https://team.atlassian.net:443',
    ]) {
      await page.getByRole('tab', { name: /OTHER-1/ }).click();
      await start();
      await fillJira(url);
      await page
        .getByRole('button', { name: 'Verify and save Jira', exact: true })
        .click();
      await expect
        .poll(() => app.evaluate(() => globalThis.setupAudit.attempts))
        .toBe(++attempts);
      await settle();
      await expect(
        page.getByRole('dialog', { name: 'Connection verified' }),
      ).toContainText('Team fixture');
      await page
        .getByRole('button', { name: 'Open first root', exact: true })
        .click();
      await expect(
        page.getByRole('combobox', { name: 'Connection', exact: true }),
      ).toHaveValue('token:fixture-team');
      const rootKey = `TEAM-${++rootNumber}`;
      await page
        .getByRole('combobox', {
          name: 'Issue key, uppercase project prefix, Jira URL, or summary',
          exact: true,
        })
        .fill(rootKey);
      await page
        .getByRole('button', { name: 'Open tree', exact: true })
        .click();
      await expect(
        page.getByRole('tree', { name: `${rootKey} issue tree` }),
      ).toBeVisible();
      const rootRead = await app.evaluate(
        (_electron, rootKey) =>
          globalThis.setupAudit.rootReads.find(
            (read) => read.rootKey === rootKey,
          ),
        rootKey,
      );
      expect(rootRead).toEqual({ id: 'token:fixture-team', rootKey });
    }
    await sidebar
      .getByRole('button', { name: 'Setup help', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review diagnostics', exact: true })
      .click();
    const report = page.getByLabel('Diagnostics report');
    await expect(report).toContainText('canopy-support-v1');
    const reviewed = await report.textContent();
    expect(reviewed).not.toMatch(
      /fixture-only-token|fixture@example|other\.atlassian|team\.atlassian|OTHER-1|TEAM-[12]|Fixture root/,
    );
    const save = page.getByRole('button', {
      name: 'Save reviewed diagnostics…',
      exact: true,
    });
    await save.click();
    await expect(
      page
        .getByRole('dialog', { name: 'Setup help', exact: true })
        .getByRole('status'),
    ).toContainText('Export canceled.');
    await app.evaluate(() => {
      globalThis.setupAudit.exportMode = 'save';
    });
    await save.click();
    await expect(
      page
        .getByRole('dialog', { name: 'Setup help', exact: true })
        .getByRole('status'),
    ).toContainText('Diagnostics saved.');
    const savedPath = await app.evaluate(
      () => globalThis.setupAudit.exportPath,
    );
    const saved = await readFile(savedPath, 'utf8');
    expect(saved).toBe(reviewed);
    await app.evaluate(() => {
      globalThis.setupAudit.exportMode = 'failure';
    });
    await save.click();
    await expect(
      page
        .getByRole('dialog', { name: 'Setup help', exact: true })
        .getByRole('status'),
    ).toContainText('Could not save diagnostics.');
    await expect(report).toHaveText(reviewed);
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    console.log(
      'Setup regressions passed: dismissal, late results, workspace, canonical reconnect, reviewed diagnostics save/cancel/failure.',
    );
  } finally {
    await app.evaluate(({ ipcMain, dialog }) => {
      const state = globalThis.setupAudit;
      dialog.showSaveDialog = state.saveDialog;
      for (const pending of state.pending)
        pending.reject(new Error('Fixture cleanup'));
      for (const [channel, handler] of state.handlers) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      }
      delete globalThis.setupAudit;
    });
    await page.evaluate(
      (workspace) => window.canopy.saveWorkspace(workspace),
      originalWorkspace,
    );
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'See the whole tree.' }),
    ).toBeVisible();
  }
}
