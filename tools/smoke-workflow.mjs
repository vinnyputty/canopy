import { expect } from '@playwright/test';

/** Intercepts HTTP and browser launches; uses real auth, provider caches, and IPC. */
export async function auditWorkflow(app, page) {
  await app.evaluate(({ ipcMain, shell, safeStorage }) => {
    // Synthetic credentials stay in the temporary smoke profile on every OS.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    safeStorage.encryptString = (value) => Buffer.from(value);
    safeStorage.decryptString = (value) => value.toString();
    const controls = {
      opens: [],
      trees: [],
      metadata: [],
      writes: 0,
      hold: false,
      release: null,
      version: 0,
      failBrowser: false,
    };
    globalThis.workflowTest = controls;
    shell.openExternal = async (url) => {
      if (controls.failBrowser) throw new Error('Browser launch failed');
      controls.opens.push(url);
    };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (
        ![
          'workflow-first.atlassian.net',
          'workflow-second.atlassian.net',
        ].includes(url.hostname)
      )
        throw new Error('Unexpected test destination');
      if ((init.method || 'GET') !== 'GET') {
        controls.writes++;
        throw new Error('Unexpected Jira write');
      }
      let body;
      if (url.pathname.endsWith('/myself'))
        body = { accountId: 'fixture', displayName: 'Fixture' };
      else if (url.pathname.endsWith('/transitions')) {
        controls.metadata.push(url.hostname);
        body = {
          transitions: [
            {
              id: 'required',
              name: controls.version ? 'Updated workflow' : 'Finish',
              fields: { resolution: { required: true } },
            },
          ],
        };
      } else throw new Error(`Unexpected Jira read: ${url.pathname}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    ipcMain.removeHandler('canopy:tree');
    ipcMain.handle('canopy:tree', async (_event, connection) => {
      controls.trees.push(connection);
      const snapshot = {
        rootKey: 'TEST-1',
        fetchedAt: Date.now(),
        warnings: [],
        issues: Array.from({ length: 60 }, (_, i) => ({
          id: String(i + 1),
          key: `TEST-${i + 1}`,
          ...(i ? { parentKey: 'TEST-1' } : {}),
          summary: `Issue ${i + 1}`,
          type: 'Task',
          priority: null,
          assignee: null,
          status: { id: 'open', name: 'Open', category: 'new' },
          links: [],
        })),
      };
      if (controls.hold) {
        controls.hold = false;
        await new Promise((resolve) => {
          controls.release = resolve;
        });
      }
      return snapshot;
    });
    ipcMain.removeHandler('canopy:priorityOrder');
    ipcMain.handle('canopy:priorityOrder', () => []);
    ipcMain.removeHandler('canopy:update');
    ipcMain.handle('canopy:update', () => {
      controls.writes++;
      throw new Error('Unexpected partial transition');
    });
  });
  const connections = await page.evaluate(async () => {
    for (const name of ['first', 'second'])
      await window.canopy.connect({
        siteUrl: `https://workflow-${name}.atlassian.net`,
        email: 'fixture@example.invalid',
        token: 'fixture-not-a-secret',
        scoped: false,
      });
    return window.canopy.connections();
  });
  await app.evaluate(({ ipcMain }, connections) => {
    ipcMain.removeHandler('canopy:loadWorkspace');
    ipcMain.handle('canopy:loadWorkspace', () => ({
      tabs: connections.map((connection, i) => ({
        id: `workflow-${i}`,
        connectionId: connection.id,
        rootKey: 'TEST-1',
        selectedKey: 'TEST-25',
        expanded: ['TEST-1'],
        hideDone: false,
        scrollTop: 0,
      })),
      activeTabId: 'workflow-0',
      shortcuts: {},
      theme: 'system',
      sidebarCollapsed: false,
    }));
  }, connections);
  await page.reload();
  const row = page.locator('[data-tree-key="TEST-25"]');
  const field = page.getByRole('button', {
    name: 'Edit status for TEST-25',
    exact: true,
  });
  const shortcut = (name) =>
    page.getByRole('menuitem', {
      name: `Open TEST-25 in Jira for ${name}`,
      exact: true,
    });
  const controls = () =>
    app.evaluate(() => ({ ...globalThis.workflowTest, release: undefined }));
  const set = (patch) =>
    app.evaluate(
      (_electron, patch) => Object.assign(globalThis.workflowTest, patch),
      patch,
    );
  const returnToApp = async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
  };
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await set({ hold: true });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => Boolean(globalThis.workflowTest.release)))
    .toBe(true);
  const oldCount = (await controls()).trees.length;
  await field.click();
  await expect(
    page.getByRole('menuitem', { name: 'Finish Requires fields', exact: true }),
  ).toBeDisabled();
  await expect(shortcut('Finish')).toBeFocused();
  // Measure the shortcut itself after picker autofocus/layout. Keep the row
  // inside a long tree so scrollbar rounding cannot clamp a bottom-edge sample.
  const position = await page.locator('.tree-scroll').evaluate(
    (el) =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          resolve({
            top: el.scrollTop,
            maximum: el.scrollHeight - el.clientHeight,
          }),
        ),
      ),
  );
  expect(position.top).toBeGreaterThan(0);
  expect(position.top).toBeLessThan(position.maximum);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('.status-popover')).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(
    await page.locator('.tree-scroll').evaluate((el) => el.scrollTop),
  ).toBe(position.top);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => (await controls()).opens)
    .toEqual(['https://workflow-first.atlassian.net/browse/TEST-25']);
  await set({ version: 1 });
  await returnToApp();
  expect((await controls()).trees.length).toBe(oldCount);
  await app.evaluate(() => globalThis.workflowTest.release());
  await expect
    .poll(async () => (await controls()).trees.length)
    .toBe(oldCount + 1);
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await field.click();
  await expect(shortcut('Updated workflow')).toBeVisible();
  expect((await controls()).metadata).toEqual([
    'workflow-first.atlassian.net',
    'workflow-first.atlassian.net',
  ]);
  await page.keyboard.press('Escape');

  await page.getByRole('tab').nth(1).click();
  await field.click();
  await shortcut('Updated workflow').press('Enter');
  await expect
    .poll(async () => (await controls()).opens)
    .toEqual([
      'https://workflow-first.atlassian.net/browse/TEST-25',
      'https://workflow-second.atlassian.net/browse/TEST-25',
    ]);
  const beforeOffline = (await controls()).trees.length;
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event('offline'));
  });
  await returnToApp();
  expect((await controls()).trees.length).toBe(beforeOffline);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });
    window.dispatchEvent(new Event('online'));
  });
  await expect
    .poll(async () => (await controls()).trees.length)
    .toBe(beforeOffline + 1);
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await set({ failBrowser: true });
  await field.click();
  await shortcut('Updated workflow').press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Browser launch failed' }),
  ).toBeVisible();
  await expect(page.locator('.status-popover')).toHaveCount(0);
  await expect(row).toBeFocused();
  expect((await controls()).writes).toBe(0);
}
