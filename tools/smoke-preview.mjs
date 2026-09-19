import { expect } from '@playwright/test';

/** Exercise the app and preview IPC with isolated connections sharing an issue key. */
export async function auditPreview(app, page) {
  await app.evaluate(({ ipcMain }) => {
    const issue = {
      id: '1',
      key: 'TEST-1',
      summary: 'Shared issue key',
      type: 'Task',
      status: { id: 'open', name: 'Open', category: 'new' },
      priority: null,
      assignee: null,
      links: [],
    };
    const controls = {
      mode: 'hold',
      completed: false,
      started: false,
      release: null,
    };
    globalThis.previewRecovery = controls;
    const handlers = {
      connections: () =>
        ['first', 'second'].map((id) => ({
          id,
          name: id,
          url: `https://${id}.example.invalid`,
          provider: 'jira',
        })),
      loadWorkspace: () => ({
        tabs: ['first', 'second'].map((id) => ({
          id,
          connectionId: id,
          rootKey: 'TEST-1',
          selectedKey: 'TEST-1',
          expanded: ['TEST-1'],
          hideDone: false,
          scrollTop: 0,
        })),
        activeTabId: 'first',
        shortcuts: {},
        theme: 'system',
        sidebarCollapsed: false,
      }),
      saveWorkspace: () => {},
      currentUser: () => null,
      priorityOrder: () => [],
      tree: () => ({
        rootKey: 'TEST-1',
        issues: [issue],
        fetchedAt: Date.now(),
        warnings: [],
      }),
      preview: async (_event, connection) => {
        const mode = controls.mode;
        if (
          connection === 'first' &&
          (mode === 'hold' || mode === 'hold-error')
        ) {
          controls.started = true;
          await new Promise((resolve) => {
            controls.release = resolve;
          });
          controls.completed = true;
          if (mode === 'hold-error')
            throw new Error('Old connection permission denied');
        }
        if (mode === 'permission')
          throw new Error(
            'Cannot load preview for TEST-1: Jira 403: Permission denied.',
          );
        return {
          issue: { ...issue, summary: `${connection} issue` },
          description: '<img src=x onerror="window.previewExecuted=true">',
          comments:
            mode === 'comments-permission'
              ? []
              : [
                  {
                    id: '1',
                    author: '<b>Ada</b>',
                    created: '2026-01-01T12:00:00Z',
                    body: '<script>window.previewExecuted=true</script>\nDocs (https://example.com)',
                  },
                ],
          totalComments: 1,
          ...(mode === 'comments-permission'
            ? {
                commentsError:
                  'Cannot load comments for TEST-1: Jira 403: Permission denied.',
              }
            : {}),
        };
      },
    };
    for (const [method, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(`canopy:${method}`);
      ipcMain.handle(`canopy:${method}`, handler);
    }
  });
  await page.reload();
  const pane = page.locator('.issue-preview');
  const row = page.locator('[data-tree-key="TEST-1"]');
  const open = async () => {
    await row.focus();
    await page.keyboard.press('Space');
  };
  const mode = (value) =>
    app.evaluate((_electron, value) => {
      Object.assign(globalThis.previewRecovery, {
        mode: value,
        started: false,
        completed: false,
      });
    }, value);
  for (const failure of [false, true]) {
    await mode(failure ? 'hold-error' : 'hold');
    await page.getByRole('tab').nth(0).click();
    await open();
    await expect(pane.getByRole('status')).toHaveText('Loading issue preview…');
    await expect
      .poll(() => app.evaluate(() => globalThis.previewRecovery.started))
      .toBe(true);
    await page.getByRole('tab').nth(1).click();
    await expect(pane).toHaveCount(0);
    await open();
    await expect(pane.locator('h2')).toHaveText('second issue');
    await app.evaluate(() => globalThis.previewRecovery.release());
    await expect
      .poll(() => app.evaluate(() => globalThis.previewRecovery.completed))
      .toBe(true);
    // Round-trip the renderer after the old IPC request has settled.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(pane.locator('h2')).toHaveText('second issue');
    await expect(pane.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
  }
  await mode('permission');
  await open();
  await expect(pane.getByRole('alert')).toContainText(
    'Jira 403: Permission denied.',
  );
  await expect(pane).not.toContainText('No description.');
  await mode('comments-permission');
  await pane.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(pane.locator('h2')).toHaveText('second issue');
  await expect(pane.getByRole('alert')).toContainText('Cannot load comments');
  await expect(pane).toContainText(
    '<img src=x onerror="window.previewExecuted=true">',
  );
  await expect(pane).not.toContainText('No comments.');
  await mode('success');
  await pane.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(pane).toContainText(
    '<script>window.previewExecuted=true</script>',
  );
  await expect(pane).toContainText('<b>Ada</b>');
  await expect(
    pane.locator('script, img, a, input, textarea, [contenteditable=true]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.previewExecuted)).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
}
