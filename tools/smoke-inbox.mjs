import { expect } from '@playwright/test';

// Disposable fixtures only; invoked by the exclusive-token-protected full smoke harness.
export async function auditInbox(app, page) {
  await app.evaluate(({ ipcMain }) => {
    const issue = (key, parentKey, patch = {}) => ({
      id: key,
      key,
      parentKey,
      summary: `Sample ${key}`,
      type: 'Task',
      priority: null,
      assignee: { id: 'me', name: 'Me' },
      status: { id: 'open', name: 'Open', category: 'new' },
      links: [],
      linksAvailable: false,
      updated: '2026-10-01T10:00:00Z',
      ...patch,
    });
    const controls = {
      saved: null,
      calls: [],
      cancelled: [],
      release: null,
      mode: 'normal',
      failed: true,
      reads: 0,
      lateCompleted: 0,
    };
    globalThis.inboxAudit = controls;
    const roots = ['org/repo#1', 'org/repo#10'];
    const base = {
      tabs: [
        {
          id: 'source',
          connectionId: 'work',
          rootKey: roots[0],
          expanded: [],
          hideDone: true,
          scrollTop: 0,
        },
      ],
      activeTabId: 'source',
      shortcuts: {},
      theme: 'light',
      sidebarCollapsed: false,
      recentRoots: [
        { connectionId: 'other', rootKey: roots[0] },
        { connectionId: 'work', rootKey: roots[1] },
        { connectionId: 'jira', rootKey: 'A-1' },
      ],
      triage: {
        version: 1,
        items: [],
        history: [],
        reviewStatuses: { jira: ['Review'] },
      },
      seenRoots: {
        ['work:' + roots[0]]: {
          touchedAt: 1,
          issues: { [roots[0]]: { seenAt: 1, fields: { Summary: 'Old' } } },
        },
      },
    };
    const handlers = {
      connections: () => [
        {
          id: 'work',
          name: 'Work',
          provider: 'github',
          url: 'https://github.com',
        },
        {
          id: 'other',
          name: 'Other',
          provider: 'github',
          url: 'https://github.com',
        },
        {
          id: 'jira',
          name: 'Jira',
          provider: 'jira',
          url: 'https://sample.invalid',
        },
      ],
      currentUser: () => ({ id: 'me', name: 'Me' }),
      syncStatus: () => ({ retryAt: null }),
      priorityOrder: () => [],
      loadWorkspace: () => controls.saved ?? base,
      saveWorkspace: (_event, value) => {
        controls.saved = value;
      },
      tree: (_event, connection, key) => {
        if (key === 'org/repo#10' && controls.failed)
          throw new Error('Sample root unavailable');
        controls.reads++;
        return {
          rootKey: key,
          fetchedAt: Date.now() + controls.reads,
          warnings: key === 'A-1' ? ['Sample partial hierarchy'] : [],
          issues: [
            issue(
              key,
              undefined,
              key === 'A-1'
                ? {
                    status: {
                      id: 'review',
                      name: 'Review',
                      category: 'indeterminate',
                    },
                  }
                : {},
            ),
          ],
        };
      },
      relationships: async (_event, connection, key, requestId) => {
        controls.calls.push({ connection, key, requestId });
        const held = controls.mode === 'hold';
        if (held)
          await new Promise((resolve) => {
            controls.release = resolve;
          });
        if (held) controls.lateCompleted++;
        return {
          key,
          groups: [
            {
              kind: 'blockers',
              state: connection === 'jira' ? 'partial' : 'visible',
              reason: connection === 'jira' ? 'Sample page limit' : undefined,
              items:
                connection === 'work'
                  ? [
                      {
                        key: held ? 'org/repo#999' : 'org/repo#9',
                        summary: held ? 'Late result' : 'Sample blocker',
                        relationship: 'blocked by',
                        direction: 'inward',
                        statusCategory: 'new',
                        access: 'available',
                      },
                    ]
                  : [],
            },
          ],
        };
      },
      cancelRelationships: (_event, connection, requestId) => {
        controls.cancelled.push({ connection, requestId });
      },
      preview: (_event, _connection, key) => ({
        issue: issue(key),
        description: 'Sample inbox preview',
        comments: [],
        totalComments: 0,
      }),
    };
    globalThis.inboxAuditHandlers = new Map();
    for (const [name, handler] of Object.entries(handlers)) {
      const channel = `canopy:${name}`;
      globalThis.inboxAuditHandlers.set(
        channel,
        ipcMain._invokeHandlers.get(channel),
      );
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  });
  try {
    await page.reload();
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    const inbox = page.getByRole('region', { name: 'Triage inbox' });
    await expect(inbox.getByText(/Sample root unavailable/)).toBeVisible();
    await expect(inbox.getByText(/Sample partial hierarchy/)).toBeVisible();
    await expect(inbox.getByText(/Blocked by org\/repo#9/)).toBeVisible();
    const work = inbox
      .locator('.inbox-item')
      .filter({ hasText: 'roots: org/repo#1' })
      .filter({ hasText: '· Work · work' });
    const other = inbox
      .locator('.inbox-item')
      .filter({ hasText: '· Other · other' });
    await expect(work).toHaveCount(1);
    await expect(other).toHaveCount(1);
    await expect(work.getByText(/Unread changes/)).toBeVisible();
    await work.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(work.getByText(/Unread changes/)).toHaveCount(0);
    await work.getByRole('button', { name: 'Pin', exact: true }).click();
    await work.getByRole('combobox').selectOption(String(60 * 60 * 1000));
    await expect(work).toHaveCount(0);
    await inbox.getByRole('checkbox', { name: /Show snoozed items/ }).check();
    await expect(work.getByText(/Snoozed until/)).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.inboxAudit.saved?.triage.items.length),
      )
      .toBe(1);
    await page.reload();
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await inbox.getByRole('checkbox', { name: /Show snoozed items/ }).check();
    await expect(
      work.getByRole('button', { name: 'Unpin', exact: true }),
    ).toBeVisible();
    await work.getByRole('button', { name: 'Wake now', exact: true }).click();
    await work.getByRole('button', { name: /org\/repo#1 Sample/ }).click();
    await expect(
      page.locator('[role="tab"][aria-selected="true"]'),
    ).toContainText('org/repo#1');
    await expect(page.locator('[data-tree-key="org/repo#1"]')).toBeFocused();
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await app.evaluate(() => {
      globalThis.inboxAudit.failed = false;
    });
    await inbox
      .getByRole('button', {
        name: 'Refresh / Retry roots and accounts',
        exact: true,
      })
      .click();
    await expect(inbox.getByText(/Sample root unavailable/)).toHaveCount(0);
    await expect(
      inbox.locator('.inbox-item').filter({ hasText: 'roots: org/repo#10' }),
    ).toBeVisible();
    await app.evaluate(() => {
      globalThis.inboxAudit.mode = 'hold';
    });
    await inbox.getByRole('button', { name: /Inspect next 20/ }).click();
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.inboxAudit.release))
      .toBe('function');
    const held = await app.evaluate(() => globalThis.inboxAudit.calls.at(-1));
    const boundary = await app.evaluate(
      () => globalThis.inboxAudit.cancelled.length,
    );
    await inbox
      .getByRole('button', { name: 'Cancel blocker inspection', exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(
          ({ held, boundary }) =>
            globalThis.inboxAudit.cancelled
              .slice(boundary)
              .some(
                (item) =>
                  item.connection === held.connection &&
                  item.requestId === held.requestId,
              ),
          { held, boundary },
        ),
      )
      .toBe(true);
    await app.evaluate(() => {
      globalThis.inboxAudit.mode = 'normal';
      globalThis.inboxAudit.release();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.inboxAudit.lateCompleted))
      .toBe(1);
    await expect(inbox.getByText(/Blocked by org\/repo#999/)).toHaveCount(0);
    await inbox.getByRole('button', { name: /Inspect next 20/ }).click();
    await expect(
      inbox.getByText(/Blocked by org\/repo#9/).first(),
    ).toBeVisible();
    await expect(inbox.getByText(/Blocked by org\/repo#999/)).toHaveCount(0);
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.inboxAudit.release?.();
      for (const [channel, handler] of globalThis.inboxAuditHandlers) {
        ipcMain.removeHandler(channel);
        if (handler) ipcMain.handle(channel, handler);
      }
      delete globalThis.inboxAuditHandlers;
      delete globalThis.inboxAudit;
    });
    await page.reload();
  }
}
