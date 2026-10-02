import { expect } from '@playwright/test';

// Run only inside the lead-token-protected smoke launcher and disposable profile.
export async function auditRelationships(app, page) {
  await app.evaluate(({ ipcMain }) => {
    const issue = (key, parentKey, done = false) => ({
      id: key,
      key,
      parentKey,
      summary: `Sample ${key}`,
      type: 'Issue',
      priority: null,
      assignee: null,
      links: [],
      linksAvailable: false,
      status: {
        id: done ? 'closed' : 'open',
        name: done ? 'Closed' : 'Open',
        category: done ? 'done' : 'new',
      },
    });
    const tab = (id, connectionId, rootKey) => ({
      id,
      connectionId,
      rootKey,
      selectedKey: rootKey,
      expanded: [],
      hideDone: id === 'owner',
      focusKey: id === 'owner' ? 'team/a#12' : undefined,
      filters: id === 'owner' ? { status: 'open' } : {},
      scrollTop: 0,
    });
    const trees = {
      'team/a#1': [issue('team/a#1')],
      'team/a#10': [
        issue('team/a#10'),
        issue('team/a#11', 'team/a#10', true),
        issue('team/a#12', 'team/a#10'),
      ],
      'team/b#5': [issue('team/b#5')],
    };
    const controls = {
      calls: [],
      mode: 'normal',
      saved: null,
      cancelled: [],
      release: null,
    };
    globalThis.relationshipAudit = controls;
    const handlers = {
      connections: () =>
        ['work', 'other'].map((id) => ({
          id,
          name: `${id} account`,
          provider: 'github',
          url: 'https://github.com',
          repositories: ['team/a', 'team/b'],
        })),
      currentUser: () => null,
      priorityOrder: () => [],
      loadWorkspace: () => ({
        tabs: [
          tab('source', 'work', 'team/a#1'),
          tab('wrong', 'other', 'team/a#10'),
          tab('owner', 'work', 'team/a#10'),
        ],
        activeTabId: 'source',
        shortcuts: {},
        theme: 'light',
        sidebarCollapsed: false,
      }),
      saveWorkspace: (_event, value) => {
        controls.saved = value;
      },
      tree: (_event, _connection, key) => ({
        rootKey: key,
        issues: trees[key],
        fetchedAt: Date.now(),
        warnings: [],
      }),
      preview: (_event, _connection, key) => ({
        issue:
          Object.values(trees)
            .flat()
            .find((value) => value.key === key) ?? issue(key),
        description: 'Disposable relationship sample',
        comments: [],
        totalComments: 0,
      }),
      relationships: async (_event, connection, key, requestId) => {
        controls.calls.push({ connection, key, requestId });
        if (controls.mode === 'hold')
          await new Promise((resolve) => {
            controls.release = resolve;
          });
        const entry = (
          target,
          relationship,
          direction,
          access = 'available',
        ) => ({
          key: target,
          summary: `Sample ${target}`,
          relationship,
          direction,
          access,
          statusCategory: target === 'team/a#11' ? 'new' : undefined,
          crossRepository: !target.startsWith('team/a'),
        });
        const groups = [
          {
            kind: 'blockers',
            state: 'visible',
            items: [entry('team/a#11', 'blocked by', 'inward')],
          },
          {
            kind: 'blocked',
            state: 'visible',
            items: [entry('team/b#5', 'blocks', 'outward')],
          },
          {
            kind: 'related',
            state: 'visible',
            items: [
              entry(
                'private/repo#9',
                'relates to',
                'outward',
                'outside-connection',
              ),
            ],
          },
          { kind: 'parent', state: 'visible', items: [] },
          {
            kind: 'children',
            state: 'partial',
            problem: 'limit',
            reason: 'Showing at most 200 children; more may exist.',
            items: [],
          },
        ];
        if (controls.mode === 'error')
          groups[0] = {
            kind: 'blockers',
            state: 'unavailable',
            problem: 'inaccessible',
            reason:
              'Relationships are inaccessible, missing, or unavailable to this connection. Blocker state is unknown.',
            items: [],
          };
        if (controls.mode === 'partial') groups[0].state = 'partial';
        return { key, groups };
      },
      cancelRelationships: (_event, connection, requestId) => {
        controls.cancelled.push({ connection, requestId });
      },
    };
    globalThis.relationshipAuditHandlers = new Map();
    for (const [name, handler] of Object.entries(handlers)) {
      const channel = `canopy:${name}`;
      globalThis.relationshipAuditHandlers.set(
        channel,
        ipcMain._invokeHandlers.get(channel),
      );
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  });
  try {
    await page.reload();
    const source = page.locator('[data-tree-key="team/a#1"]');
    await expect(source).toBeVisible();
    await source.focus();
    await page.keyboard.press('Space');
    const pane = page.locator('.issue-preview');
    await expect(
      pane.getByRole('button', { name: 'Inspect relationships', exact: true }),
    ).toBeVisible();
    expect(
      await app.evaluate(() => globalThis.relationshipAudit.calls.length),
    ).toBe(0);
    await pane
      .getByRole('button', { name: 'Inspect relationships', exact: true })
      .click();
    await expect(
      pane.getByRole('region', { name: 'Blockers', exact: true }),
    ).toContainText('Incoming');
    await expect(pane).toContainText('GitHub · work account');
    await expect(pane).toContainText('children; more may exist');
    await expect(pane).toContainText('Outside this connection');
    await expect(
      pane.getByRole('button', { name: 'Show private/repo#9 in tree' }),
    ).toHaveCount(0);
    await pane
      .getByRole('button', { name: 'Show team/a#11 in tree', exact: true })
      .click();
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.relationshipAudit.saved?.activeTabId),
      )
      .toBe('owner');
    const target = page.locator('[data-tree-key="team/a#11"]');
    await expect(target).toBeVisible();
    await expect(target).toBeFocused();
    await page.getByRole('tab').first().click();
    await expect(source).toBeVisible();
    await source.focus();
    await page.keyboard.press('Space');
    // Escape or Space may close an already-open pane when returning to the source.
    if (!(await pane.isVisible())) await page.keyboard.press('Space');
    await expect(pane).toHaveAttribute('aria-label', 'Preview team/a#1');
    if (
      await pane
        .getByRole('button', { name: 'Inspect relationships', exact: true })
        .count()
    )
      await pane
        .getByRole('button', { name: 'Inspect relationships', exact: true })
        .click();
    await pane
      .getByRole('button', { name: 'Show team/b#5 in tree', exact: true })
      .click();
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.locator('[data-tree-key="team/b#5"]')).toBeFocused();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            globalThis.relationshipAudit.saved?.tabs.find(
              (tab) => tab.rootKey === 'team/b#5',
            )?.selectedKey,
        ),
      )
      .toBe('team/b#5');
    await page.getByRole('tab').first().click();
    await page.getByRole('button', { name: 'Next tasks', exact: true }).click();
    const tasks = page.getByRole('region', { name: 'Next tasks', exact: true });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Sample team/a#11');
    await expect(tasks).toContainText('Blocked by team/a#11');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'error';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Blocker state unknown');
    await expect(tasks).not.toContainText('No active visible blockers found');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'partial';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Blocked by team/a#11');
    await expect(tasks).toContainText('Blocker information is incomplete');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'hold';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(
      tasks.getByRole('button', { name: 'Loading relationships…' }),
    ).toBeVisible();
    await page.getByRole('tab').nth(1).click();
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.relationshipAudit.cancelled.length),
      )
      .toBeGreaterThan(0);
    await app.evaluate(() => {
      globalThis.relationshipAudit.release();
    });
    await expect(page.getByRole('tab').nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    await app.evaluate(({ ipcMain }) => {
      for (const [channel, handler] of globalThis.relationshipAuditHandlers) {
        ipcMain.removeHandler(channel);
        if (handler) ipcMain.handle(channel, handler);
      }
    });
  }
}
