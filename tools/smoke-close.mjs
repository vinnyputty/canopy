import { expect } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep the debounce pending deterministically, rather than racing a 180 ms timer.
async function holdDebounce(page) {
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (handler, delay, ...args) =>
      original(handler, delay === 180 ? 60_000 : delay, ...args);
  });
}

export async function auditWorkspaceClose({
  launch,
  close,
  current,
  userData,
}) {
  await close();
  await rm(join(userData, 'demo-removed.json'), { force: true });
  for (const route of ['close', 'quit', 'session']) {
    const tab = (key) => ({
      id: key,
      connectionId: 'demo',
      rootKey: key,
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    });
    await writeFile(
      join(userData, 'workspace.json'),
      JSON.stringify({
        tabs: [tab('CAN-100'), tab('CAN-200')],
        activeTabId: 'CAN-100',
        theme: 'dark',
        reading: { textSize: 'medium', spacing: 'compact' },
        sidebarCollapsed: false,
        shortcuts: {},
        seenRoots: {
          'demo:CAN-100': {
            touchedAt: 1,
            issues: {
              'CAN-100': { seenAt: 1, fields: { Summary: 'Old summary' } },
            },
          },
        },
      }),
    );
    await launch();
    let { app, page } = current();
    await expect(
      page.getByRole('button', { name: /Mark root seen/ }),
    ).toBeVisible();
    await page.evaluate(() => window.canopy.flushWorkspace());
    await holdDebounce(page);
    await page
      .getByRole('tab', { name: /CAN-200/ })
      .click({ button: 'middle' });
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .check();
    await page.getByLabel('Filter priority').selectOption('2');
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Show Assignee column').uncheck();
    await page.locator('.view-settings > summary').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Text size', { exact: true }).selectOption('small');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: /Mark root seen/ }).click();
    const before = JSON.parse(
      await readFile(join(userData, 'workspace.json'), 'utf8'),
    );
    expect(before.tabs).toHaveLength(2);
    expect(before.tabs[0].hideDone).toBe(false);
    expect(before.reading).toEqual({ textSize: 'medium', spacing: 'compact' });
    const closingPage = page.waitForEvent('close');
    await app.evaluate(({ app, BrowserWindow }, route) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (route === 'close') window.close();
      else if (route === 'quit') app.quit();
      else {
        let prevented = 0;
        let deadlines = 0;
        let quitRequests = 0;
        const timer = globalThis.setTimeout;
        const beforeQuit = () => quitRequests++;
        app.on('before-quit', beforeQuit);
        globalThis.setTimeout = (callback, delay, ...args) => {
          if (delay === 15_000) deadlines++;
          return timer(callback, delay, ...args);
        };
        try {
          window.emit('query-session-end', {
            reasons: ['logoff', 'critical'],
            preventDefault() {
              prevented++;
            },
          });
          if (prevented || deadlines || quitRequests || window.isDestroyed())
            throw new Error(
              'Critical session request started a blocking close.',
            );
          for (let request = 0; request < 3; request++) {
            window.emit('query-session-end', {
              reasons: ['shutdown'],
              preventDefault() {
                prevented++;
              },
            });
          }
          if (prevented !== 3 || deadlines !== 1)
            throw new Error(
              'Repeated session requests did not share one deadline.',
            );
        } finally {
          globalThis.setTimeout = timer;
          app.removeListener('before-quit', beforeQuit);
        }
      }
    }, route);
    await closingPage;
    await close();
    const saved = JSON.parse(
      await readFile(join(userData, 'workspace.json'), 'utf8'),
    );
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs[0].hideDone).toBe(true);
    expect(saved.tabs[0].filters.priority).toBe('2');
    expect(
      saved.rootViews[JSON.stringify(['demo', 'CAN-100'])].columns,
    ).not.toContain('assignee');
    expect(saved.reading).toEqual({ textSize: 'small', spacing: 'compact' });
    expect(
      saved.seenRoots['demo:CAN-100'].issues['CAN-100'].seenAt,
    ).toBeGreaterThan(1);
    await launch();
    ({ app, page } = current());
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByLabel('Filter priority')).toHaveValue('2');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).toBeChecked();
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await expect(
      page.getByRole('button', { name: 'Sort by Assignee', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Text size', { exact: true })).toHaveValue(
      'small',
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /Mark root seen/ }),
    ).toHaveCount(0);

    // An existing refresh error must not conceal a failed final write.
    await app.evaluate(({ ipcMain }) => {
      globalThis.closeTreeHandler = ipcMain._invokeHandlers.get('canopy:tree');
      ipcMain.removeHandler('canopy:tree');
      ipcMain.handle('canopy:tree', () => {
        throw new Error('Injected tree refresh failure');
      });
    });
    await page.getByTitle('Refresh', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Injected tree refresh failure',
    );
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('canopy:tree');
      ipcMain.handle('canopy:tree', globalThis.closeTreeHandler);
    });
    // A failed final write must cancel close and retain the actual save error.
    await app.evaluate(({ ipcMain }) => {
      globalThis.closeSaveHandler = ipcMain._invokeHandlers.get(
        'canopy:saveWorkspace',
      );
      ipcMain.removeHandler('canopy:saveWorkspace');
      ipcMain.handle('canopy:saveWorkspace', () => {
        throw new Error('Injected close write failure');
      });
    });
    await holdDebounce(page);
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .uncheck();
    await app.evaluate(({ app, BrowserWindow }, route) => {
      if (route === 'close') BrowserWindow.getAllWindows()[0].close();
      else app.quit();
    }, route);
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Injected close write failure' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Injected tree refresh failure' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Dismiss workspace save error' })
      .click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Injected tree refresh failure' }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Injected close write failure' }),
    ).toBeVisible();
    expect(page.isClosed()).toBe(false);
    expect(
      JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8'))
        .tabs[0].hideDone,
    ).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('canopy:saveWorkspace');
      ipcMain.handle('canopy:saveWorkspace', globalThis.closeSaveHandler);
    });
    await close();
    expect(
      JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8'))
        .tabs[0].hideDone,
    ).toBe(false);
  }
  await launch();
  let { app, page } = current();
  await holdDebounce(page);
  await page.evaluate(() => window.canopy.flushWorkspace());
  const beforeAppearance = JSON.parse(
    await readFile(join(userData, 'workspace.json'), 'utf8'),
  );
  const palette = beforeAppearance.palette === 'forest' ? 'Ocean' : 'Forest';
  await app.evaluate(({ ipcMain }, target) => {
    const channel = 'canopy:saveWorkspace';
    const original = ipcMain._invokeHandlers.get(channel);
    const audit = { release: null, calls: [] };
    globalThis.closeAppearanceSave = audit;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, workspace) => {
      audit.calls.push(workspace);
      if (workspace.palette !== target || audit.release)
        return original(event, workspace);
      return new Promise((resolve, reject) => {
        audit.release = () =>
          Promise.resolve(original(event, workspace)).then(resolve, reject);
      });
    });
  }, palette.toLowerCase());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Appearance' });
  await appearance.getByRole('radio', { name: palette }).check();
  await appearance.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(() => app.evaluate(() => !!globalThis.closeAppearanceSave.release))
    .toBe(true);
  // Exercise a concurrent workspace update while the appearance write waits.
  const hideDone = page.getByRole('checkbox', {
    name: 'Hide done',
    exact: true,
  });
  await hideDone.evaluate((element) => element.click());
  await expect(hideDone).toBeChecked();
  const appearanceClosed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  expect(page.isClosed()).toBe(false);
  await app.evaluate(() => globalThis.closeAppearanceSave.release());
  await appearanceClosed;
  await close();
  const savedAppearance = JSON.parse(
    await readFile(join(userData, 'workspace.json'), 'utf8'),
  );
  expect(savedAppearance.palette).toBe(palette.toLowerCase());
  expect(savedAppearance.tabs[0].hideDone).toBe(true);
  expect(savedAppearance.reading).toEqual(beforeAppearance.reading);
  await launch();
  ({ app, page } = current());
  await expect(page.locator('html')).toHaveAttribute(
    'data-palette',
    palette.toLowerCase(),
  );
  await expect(
    page.getByRole('checkbox', { name: 'Hide done', exact: true }),
  ).toBeChecked();
  console.log(
    'Workspace close, quit, session request, failure and retry persistence passed, including held appearance save with concurrent workspace changes.',
  );
}
