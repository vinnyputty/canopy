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
      accountFailed: true,
      accountCalls: [],
      treeCalls: [],
      searches: 0,
      reads: 0,
      lateCompleted: 0,
      fetchTime: Date.now(),
      fetches: {},
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
        {
          id: 'other-source',
          connectionId: 'other',
          rootKey: roots[0],
          selectedKey: roots[0],
          expanded: [roots[0]],
          hideDone: false,
          scrollTop: 0,
        },
      ],
      activeTabId: 'other-source',
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
      currentUser: (_event, connection) => {
        controls.accountCalls.push(connection);
        if (connection === 'jira' && controls.accountFailed)
          throw new Error('Sample Jira account lookup failed');
        return { id: `${connection}-user`, name: `${connection} user` };
      },
      search: () => {
        controls.searches++;
        throw new Error('Inbox must stay within known roots');
      },
      syncStatus: () => ({ retryAt: null }),
      priorityOrder: () => [],
      loadWorkspace: () => controls.saved ?? base,
      saveWorkspace: (_event, value) => {
        controls.saved = value;
      },
      tree: (_event, connection, key) => {
        controls.treeCalls.push({ connection, key });
        if (key === 'org/repo#10' && controls.failed)
          throw new Error('Sample root unavailable');
        controls.reads++;
        const fetchedAt = controls.fetchTime + controls.reads;
        controls.fetches[JSON.stringify([connection, key])] = fetchedAt;
        return {
          rootKey: key,
          fetchedAt,
          warnings: key === 'A-1' ? ['Sample partial hierarchy'] : [],
          issues: [
            issue(
              key,
              undefined,
              key === 'A-1'
                ? {
                    assignee: {
                      id: `${connection}-user`,
                      name: `${connection} user`,
                    },
                    status: {
                      id: 'review',
                      name: 'Review',
                      category: 'indeterminate',
                    },
                  }
                : {
                    assignee: {
                      id: `${connection}-user`,
                      name: `${connection} user`,
                    },
                  },
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
    // Install before App mounts so scheduling and RootRefreshGate share one clock.
    await page.clock.install({ time: new Date() });
    await page.reload();
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    const inbox = page.getByRole('region', { name: 'Triage inbox' });
    const expectOwner = async (id, connection, key) => {
      await expect
        .poll(() =>
          app.evaluate(
            (_electron, { id, connection, key }) => {
              const saved = globalThis.inboxAudit.saved;
              const active = saved?.tabs.find(
                (tab) => tab.id === saved.activeTabId,
              );
              return (
                active?.id === id &&
                active.connectionId === connection &&
                active.rootKey === key &&
                active.selectedKey === key
              );
            },
            { id, connection, key },
          ),
        )
        .toBe(true);
      const index = await app.evaluate(
        (_electron, id) =>
          globalThis.inboxAudit.saved.tabs.findIndex((tab) => tab.id === id),
        id,
      );
      await expect(page.getByRole('tab').nth(index)).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('[data-tree-key="' + key + '"]')).toHaveCount(
        1,
      );
      await expect(page.locator('[data-tree-key="' + key + '"]')).toBeVisible();
      await expect(page.locator('[data-tree-key="' + key + '"]')).toBeFocused();
    };
    await expect(
      inbox.getByText(/Sample Jira account lookup failed/),
    ).toBeVisible();

    await expect(inbox.getByText(/Sample root unavailable/)).toBeVisible();
    await expect(inbox.getByText(/Sample partial hierarchy/)).toBeVisible();
    await expect(inbox.getByText(/Blocked by org\/repo#9/)).toBeVisible();
    const work = inbox
      .locator('.inbox-item')
      .filter({
        has: page.getByRole('button', {
          name: 'org/repo#1 Sample org/repo#1',
          exact: true,
        }),
      })
      .filter({
        has: page.getByText('github · Work · work · roots: org/repo#1', {
          exact: true,
        }),
      });
    const other = inbox
      .locator('.inbox-item')
      .filter({
        has: page.getByRole('button', {
          name: 'org/repo#1 Sample org/repo#1',
          exact: true,
        }),
      })
      .filter({
        has: page.getByText('github · Other · other · roots: org/repo#1', {
          exact: true,
        }),
      });
    await expect(work).toHaveCount(1);
    await expect(other).toHaveCount(1);
    await expect(other.getByText(/Assigned to you/)).toBeVisible();
    await expect(work.getByText(/Assigned to you/)).toBeVisible();
    const quietRefresh = async () => {
      const before = await app.evaluate(() => ({
        fetchedAt:
          globalThis.inboxAudit.fetches[JSON.stringify(['work', 'org/repo#1'])],
        calls: globalThis.inboxAudit.calls.length,
        cancelled: globalThis.inboxAudit.cancelled.length,
      }));
      await app.evaluate(() => {
        globalThis.inboxAudit.fetchTime += 210_000;
      });
      await page.clock.fastForward(210_000);
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              globalThis.inboxAudit.fetches[
                JSON.stringify(['work', 'org/repo#1'])
              ],
          ),
        )
        .toBeGreaterThan(before.fetchedAt);
      const fetchedAt = await app.evaluate(
        () =>
          globalThis.inboxAudit.fetches[JSON.stringify(['work', 'org/repo#1'])],
      );
      await expect(work.getByText(/confirmed fetch/)).toContainText(
        new Date(fetchedAt).toLocaleString(),
      );
      expect(
        await app.evaluate(() => globalThis.inboxAudit.cancelled.length),
      ).toBe(before.cancelled);
      expect(await app.evaluate(() => globalThis.inboxAudit.calls.length)).toBe(
        before.calls,
      );
    };
    await expect(
      inbox.getByRole('button', {
        name: 'Retry partial / failed blockers',
        exact: true,
      }),
    ).toBeEnabled();
    const confirmedBefore = await work
      .getByText(/confirmed fetch/)
      .textContent();
    await quietRefresh();
    await expect(work.getByText(/Blocked by org\/repo#9/)).toBeVisible();
    await expect(work.getByText(/confirmed fetch/)).not.toHaveText(
      confirmedBefore,
    );

    const jira = inbox
      .locator('.inbox-item')
      .filter({
        has: page.getByRole('button', { name: 'A-1 Sample A-1', exact: true }),
      })
      .filter({
        has: page.getByText('jira · Jira · jira · roots: A-1', {
          exact: true,
        }),
      });
    await expect(jira.getByText(/Review: Review/)).toBeVisible();
    await expect(jira.getByText(/Assigned to you/)).toHaveCount(0);
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
        app.evaluate(() => {
          const triage = globalThis.inboxAudit.saved?.triage;
          const item = triage?.items.find(
            (item) =>
              item.connectionId === 'work' && item.issueKey === 'org/repo#1',
          );
          return (
            item?.pinned === true &&
            item.snoozedUntil > Date.now() &&
            JSON.stringify(triage.history.map((item) => item.action)) ===
              JSON.stringify(['seen', 'pin', 'snooze'])
          );
        }),
      )
      .toBe(true);
    await page.reload();
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await inbox.getByRole('checkbox', { name: /Show snoozed items/ }).check();
    await expect(
      work.getByRole('button', { name: 'Unpin', exact: true }),
    ).toBeVisible();
    await expect(work.getByText(/Unread changes/)).toHaveCount(0);
    await expect
      .poll(() =>
        app.evaluate(() =>
          globalThis.inboxAudit.saved?.triage.history.map(
            (item) => item.action,
          ),
        ),
      )
      .toEqual(['seen', 'pin', 'snooze']);
    await work.getByRole('button', { name: 'Wake now', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.inboxAudit.saved?.activeTabId))
      .toBe('other-source');
    await work
      .getByRole('button', {
        name: 'org/repo#1 Sample org/repo#1',
        exact: true,
      })
      .click();
    await expectOwner('source', 'work', 'org/repo#1');
    await expect
      .poll(() =>
        app.evaluate(() => {
          const triage = globalThis.inboxAudit.saved?.triage;
          const preference = triage?.items.find(
            (item) =>
              item.connectionId === 'work' && item.issueKey === 'org/repo#1',
          );
          return (
            preference?.pinned === true &&
            preference.snoozedUntil === undefined &&
            triage.history.at(-1)?.action === 'wake'
          );
        }),
      )
      .toBe(true);
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await other
      .getByRole('button', {
        name: 'org/repo#1 Sample org/repo#1',
        exact: true,
      })
      .click();
    await expectOwner('other-source', 'other', 'org/repo#1');
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await work
      .getByRole('button', {
        name: 'org/repo#1 Sample org/repo#1',
        exact: true,
      })
      .click();
    await expectOwner('source', 'work', 'org/repo#1');
    await page
      .getByRole('button', { name: 'Triage inbox', exact: true })
      .click();
    await app.evaluate(() => {
      globalThis.inboxAudit.failed = false;
      globalThis.inboxAudit.accountFailed = false;
    });
    await inbox
      .getByRole('button', {
        name: 'Refresh / Retry roots and accounts',
        exact: true,
      })
      .click();
    await expect(inbox.getByText(/Sample root unavailable/)).toHaveCount(0);
    await expect(
      inbox.getByText(/Sample Jira account lookup failed/),
    ).toHaveCount(0);
    await expect(jira.getByText(/Assigned to you/)).toBeVisible();
    await expect(other.getByText(/Assigned to you/)).toBeVisible();
    await expect(work.getByText(/Assigned to you/)).toBeVisible();
    await expect(
      inbox.getByRole('button', {
        name: 'org/repo#10 Sample org/repo#10',
        exact: true,
      }),
    ).toBeVisible();
    await expect(inbox.getByText(/Sample partial hierarchy/)).toBeVisible();
    expect(await app.evaluate(() => globalThis.inboxAudit.searches)).toBe(0);
    expect(
      await app.evaluate(() =>
        [
          ...new Set(
            globalThis.inboxAudit.treeCalls.map((item) =>
              JSON.stringify([item.connection, item.key]),
            ),
          ),
        ].sort(),
      ),
    ).toEqual(
      [
        JSON.stringify(['work', 'org/repo#1']),
        JSON.stringify(['other', 'org/repo#1']),
        JSON.stringify(['work', 'org/repo#10']),
        JSON.stringify(['jira', 'A-1']),
      ].sort(),
    );
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
    await quietRefresh();
    await expect(
      inbox.getByRole('button', {
        name: 'Cancel blocker inspection',
        exact: true,
      }),
    ).toBeVisible();
    const boundary = await app.evaluate(
      () => globalThis.inboxAudit.cancelled.length,
    );
    await inbox
      .getByRole('button', { name: 'Cancel blocker inspection', exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(
          (_electron, { held, boundary }) =>
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
    await expect(work.getByText(/Blocked by org\/repo#9/)).toBeVisible();
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
    await page.clock.resume();
    await page.clock.setSystemTime(new Date());
    await page.reload();
  }
}
