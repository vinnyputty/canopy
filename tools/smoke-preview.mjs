import { expect } from '@playwright/test';

export async function installPreviewHandlers(
  app,
  restored = false,
  currentIssue,
  created,
) {
  await app.evaluate(
    ({ ipcMain }, { restored, currentIssue, created }) => {
      const issue = {
        id: '1',
        key: 'TEST-1',
        summary: 'Shared issue key',
        type: 'Task',
        status: { id: 'open', name: 'Open', category: 'new' },
        priority: null,
        assignee: null,
        links: [],
        commentCount: 1,
      };
      const controls = {
        mode: 'hold',
        completed: false,
        started: false,
        release: null,
        currentIssue: currentIssue ?? issue,
        created: created ?? null,
        clipboard: '',
        developmentCalls: 0,
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
        saveWorkspace: (_event, value) => {
          controls.savedWorkspace = structuredClone(value);
        },
        openComment: () => {
          throw new Error('Comment link unavailable');
        },
        currentUser: () => null,
        priorityOrder: () => [],
        tree: () => ({
          rootKey: 'TEST-1',
          issues: [controls.currentIssue],
          fetchedAt: Date.now(),
          warnings: [],
        }),
        preview: async (_event, connection) => {
          const mode = controls.mode;
          if (mode === 'brief-fail') throw new Error('Preview unavailable');
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
            issue: {
              ...issue,
              summary: `${connection} issue`,
              ...(mode === 'metadata-permission'
                ? {
                    type: 'Issue',
                    status: {
                      id: '',
                      name: 'Unknown',
                      category: 'indeterminate',
                    },
                    unavailableFields: ['type', 'status', 'priority', 'assignee'],
                  }
                : {}),
            },
            metadata: {
              reporter: 'Ada',
              created: '2026-01-01T12:00:00Z',
              updated: null,
            },
            description: '<img src=x onerror="window.previewExecuted=true">',
            ...(mode === 'success'
              ? {
                  descriptionDocument: {
                    type: 'doc',
                    content: [
                      {
                        type: 'heading',
                        attrs: { level: 2 },
                        content: [{ type: 'text', text: 'Formatted details' }],
                      },
                      {
                        type: 'bulletList',
                        content: [
                          {
                            type: 'listItem',
                            content: [
                              {
                                type: 'paragraph',
                                content: [{ type: 'text', text: 'Top item' }],
                              },
                              {
                                type: 'orderedList',
                                content: [
                                  {
                                    type: 'listItem',
                                    content: [
                                      {
                                        type: 'paragraph',
                                        content: [
                                          { type: 'text', text: 'Nested item' },
                                        ],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                }
              : {}),
            comments:
              mode === 'comments-permission'
                ? []
                : [
                    {
                      id: '1',
                      author: '<b>Ada</b>',
                      created: '2026-01-01T12:00:00Z',
                      body: '<script>window.previewExecuted=true</script>\nDocs (https://example.com)',
                      ...(mode === 'success'
                        ? {
                            bodyDocument: {
                              type: 'doc',
                              content: [
                                {
                                  type: 'paragraph',
                                  content: [
                                    {
                                      type: 'text',
                                      text: '<script>window.previewExecuted=true</script>',
                                    },
                                    {
                                      type: 'text',
                                      text: ' Docs',
                                      marks: [
                                        {
                                          type: 'link',
                                          attrs: {
                                            href: 'https://example.com',
                                          },
                                        },
                                      ],
                                    },
                                    {
                                      type: 'text',
                                      text: ' unsafe',
                                      marks: [
                                        {
                                          type: 'link',
                                          attrs: {
                                            href: 'javascript:alert(1)',
                                          },
                                        },
                                      ],
                                    },
                                  ],
                                },
                                {
                                  type: 'codeBlock',
                                  content: [
                                    {
                                      type: 'text',
                                      text: 'const safe = true;',
                                    },
                                  ],
                                },
                              ],
                            },
                          }
                        : {}),
                    },
                    ...(controls.created
                      ? [
                          {
                            id: '2',
                            author: 'Ada',
                            created: controls.created,
                            body: 'New comment',
                          },
                        ]
                      : []),
                  ],
            totalComments: controls.created ? 2 : 1,
            ...(mode === 'comments-permission'
              ? {
                  commentsError:
                    'Cannot load comments for TEST-1: Jira 403: Permission denied.',
                }
              : {}),
          };
        },
        issueUrl: (_event, connection, key) => {
          if (controls.mode === 'brief-fail')
            throw new Error('URL unavailable');
          return `https://${connection}.example.invalid/browse/${key}`;
        },
        development: () => {
          controls.developmentCalls++;
          return {
            state: 'unavailable',
            reason: 'Development links are unavailable for this Jira connection.',
            branches: {
              state: 'unavailable',
              reason: 'Development integration is unavailable.',
            },
            pullRequests: [],
            commits: [],
          };
        },
        copyText: (_event, value) => {
          controls.clipboard = value;
        },
      };
      if (restored) {
        delete handlers.loadWorkspace;
        handlers.saveWorkspace = () => {};
      }
      for (const [method, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(`canopy:${method}`);
        ipcMain.handle(`canopy:${method}`, handler);
      }
    },
    { restored, currentIssue, created },
  );
}

/** Exercise the app and preview IPC with isolated connections sharing an issue key. */
export async function auditPreview(app, page, restart) {
  await installPreviewHandlers(app);
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
  await expect(pane).toContainText('Ada');
  await expect(pane).toContainText('None');
  expect(
    await app.evaluate(() => globalThis.previewRecovery.developmentCalls),
  ).toBe(0);
  await pane.getByRole('button', { name: 'Show development' }).click();
  await expect(pane).toContainText(
    'Development links are unavailable for this Jira connection.',
  );
  expect(
    await app.evaluate(() => globalThis.previewRecovery.developmentCalls),
  ).toBe(1);
  await mode('metadata-permission');
  await page.keyboard.press('Escape');
  await open();
  await expect(pane.locator('.preview-metadata dd')).toHaveText([
    'Ada',
    /2026/,
    'None',
    'Unavailable',
    'Unavailable',
    'Unavailable',
    'Unavailable',
  ]);
  await expect(pane).toContainText(
    '<script>window.previewExecuted=true</script>',
  );
  await expect(pane).toContainText('<b>Ada</b>');
  await expect(pane.locator('.preview-text h2')).toHaveText(
    'Formatted details',
  );
  await expect(pane.locator('.preview-text ul ol li')).toHaveText(
    'Nested item',
  );
  await expect(pane.locator('.preview-text pre code')).toHaveText(
    'const safe = true;',
  );
  await expect(pane.locator('.preview-inline-link')).toHaveText(' Docs');
  await expect(
    pane.locator('script, img, a, input, textarea, [contenteditable=true]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.previewExecuted)).toBeUndefined();
  await pane.getByRole('button', { name: 'Copy work brief' }).click();
  const brief = page.getByRole('dialog', { name: 'Work brief for TEST-1' });
  await expect(
    brief.getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    '- Issue: Jira TEST-1',
  );
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    'https://second.example.invalid/browse/TEST-1',
  );
  await page.keyboard.press('Tab');
  await expect(brief.getByLabel('Work brief Markdown')).toBeFocused();
  await brief.getByRole('button', { name: 'Copy work brief' }).click();
  await expect(brief.getByRole('status')).toHaveText('Copied');
  expect(
    await app.evaluate(() => globalThis.previewRecovery.clipboard),
  ).toContain('<img src=x onerror="window.previewExecuted=true">');
  await brief.getByRole('button', { name: 'Close dialog' }).click();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menu', { name: 'Actions for TEST-1' })
    .getByRole('menuitem', { name: 'Copy work brief' })
    .click();
  await expect(
    brief.getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    '- Issue: Jira TEST-1',
  );
  await brief.getByRole('button', { name: 'Close dialog' }).click();
  await app.evaluate(() => {
    globalThis.previewRecovery.mode = 'brief-fail';
  });
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page
    .getByRole('menu', { name: 'Actions for TEST-1' })
    .getByRole('menuitem', { name: 'Copy work brief' })
    .click();
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    'Unavailable: source URL could not be loaded.',
  );
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    'Unavailable: some dependency links could not be loaded.',
  );
  await brief.getByRole('button', { name: 'Copy work brief' }).click();
  await expect(brief.getByText('Copied', { exact: true })).toBeVisible();
  await app.evaluate(() => {
    globalThis.previewRecovery.mode = 'success';
  });
  await brief.getByRole('button', { name: 'Retry' }).click();
  await expect(brief.getByText('Copied', { exact: true })).toHaveCount(0);
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    'https://second.example.invalid/browse/TEST-1',
  );
  await brief.getByRole('button', { name: 'Close dialog' }).click();
  await app.evaluate(() => {
    globalThis.previewRecovery.currentIssue = {
      ...globalThis.previewRecovery.currentIssue,
      summary: 'Updated summary',
      commentCount: 2,
    };
    globalThis.previewRecovery.created = new Date(
      Date.now() + 1000,
    ).toISOString();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row.getByLabel('Unseen changes on TEST-1')).toBeVisible();
  await open();
  await expect(pane.getByText('First', { exact: true })).toHaveCount(0);
  await expect(
    pane.getByText('Shared issue key → Updated summary'),
  ).toBeVisible();
  await expect(
    pane.getByText('1 more comment than at the last view.'),
  ).toBeVisible();
  await expect(
    pane.getByRole('button', { name: /New comment by Ada/ }),
  ).toBeVisible();
  await pane.getByRole('button', { name: /New comment by Ada/ }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Comment link unavailable',
  );
  await app.evaluate(() => {
    globalThis.previewRecovery.currentIssue.commentCount = 3;
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    pane.getByText('2 more comments than at the last view.'),
  ).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          globalThis.previewRecovery.savedWorkspace?.seenRoots?.[
            'second:TEST-1'
          ]?.issues?.['TEST-1']?.fields?.Summary,
      ),
    )
    .toBe('Shared issue key');
  const savedWorkspace = await app.evaluate(
    () => globalThis.previewRecovery.savedWorkspace,
  );
  const currentIssue = await app.evaluate(
    () => globalThis.previewRecovery.currentIssue,
  );
  const created = await app.evaluate(() => globalThis.previewRecovery.created);
  const restarted = await restart(savedWorkspace, currentIssue, created);
  const restartedRow = restarted.page.locator('[data-tree-key="TEST-1"]');
  await expect(
    restartedRow.getByLabel('Unseen changes on TEST-1'),
  ).toBeVisible();
  await restartedRow.focus();
  await restarted.page.keyboard.press('Space');
  const restartedPane = restarted.page.locator('.issue-preview');
  await expect(
    restartedPane.getByRole('button', { name: /New comment by Ada/ }),
  ).toBeVisible();
  await restartedPane.getByRole('button', { name: 'Mark issue seen' }).click();
  await expect(restartedRow.getByLabel('Unseen changes on TEST-1')).toHaveCount(
    0,
  );
}
