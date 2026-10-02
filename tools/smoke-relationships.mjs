import { expect } from '@playwright/test';

// Run only inside the lead-token-protected smoke launcher and disposable profile.
export async function auditRelationships(app, page) {
  let originalBounds;
  let clockPaused = false;
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
      'A-1': [issue('A-1')],
    };
    const controls = {
      calls: [],
      mode: 'normal',
      saved: null,
      cancelled: [],
      release: null,
      completed: 0,
      treeReads: 0,
      treeCalls: [],
      includeCompletedBlocker: false,
      heldTreeConnection: null,
      heldSourceTree: false,
      treeRelease: null,
      backgroundMarker: null,
      pollTargetUnavailable: false,
    };
    globalThis.relationshipAudit = controls;
    const handlers = {
      connections: () =>
        ['work', 'other', 'jira'].map((id) => ({
          id,
          name: `${id} account`,
          provider: id === 'jira' ? 'jira' : 'github',
          url: id === 'jira' ? 'https://sample.invalid' : 'https://github.com',
          repositories: ['team/a', 'team/b'],
        })),
      currentUser: () => null,
      syncStatus: () => ({ retryAt: null }),
      priorityOrder: () => [],
      loadWorkspace: () => ({
        tabs: [
          tab('source', 'work', 'team/a#1'),
          tab('wrong', 'other', 'team/a#10'),
          tab('owner', 'work', 'team/a#10'),
          tab('jira', 'jira', 'A-1'),
        ],
        activeTabId: 'source',
        shortcuts: {},
        theme: 'light',
        sidebarCollapsed: false,
      }),
      saveWorkspace: (_event, value) => {
        controls.saved = value;
      },
      tree: (_event, _connection, key) => {
        controls.treeReads++;
        controls.treeCalls.push({ connection: _connection, key });
        const read = () => ({
          rootKey: key,
          issues:
            key === 'team/a#1' && controls.includeCompletedBlocker
              ? [...trees[key], issue('team/a#11', key, true)]
              : trees[key].map((value) =>
                  key === 'team/a#10' &&
                  value.key === key &&
                  controls.backgroundMarker &&
                  _connection === controls.heldTreeConnection
                    ? { ...value, summary: controls.backgroundMarker }
                    : value.key === 'team/a#11' &&
                        _connection === 'work' &&
                        controls.pollTargetUnavailable
                      ? { ...value, unavailableFields: ['status'] }
                      : value,
                ),
          fetchedAt: Date.now() + controls.treeReads,
          warnings: [],
        });
        if (
          (key === 'team/a#10' &&
            _connection === controls.heldTreeConnection) ||
          (key === 'team/a#1' &&
            _connection === 'work' &&
            controls.heldSourceTree)
        )
          return new Promise((resolve) => {
            controls.treeRelease = () => resolve(read());
          });
        return read();
      },
      issueUrl: (_event, connection, key) =>
        connection === 'jira'
          ? `https://sample.invalid/browse/${key}`
          : `https://github.com/${key.replace('#', '/issues/')}`,
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
        const mode = controls.mode;
        if (mode === 'hold' || mode === 'background-hold')
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
          crossRepository: target.includes('#') && !target.startsWith('team/a'),
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
          {
            kind: 'parent',
            state: 'visible',
            items: [entry('team/a#10', 'child of', 'inward')],
          },
          {
            kind: 'children',
            state: 'partial',
            problem: 'limit',
            reason: 'Showing at most 200 children; more may exist.',
            items: [entry('team/a#12', 'parent of', 'outward')],
          },
        ];
        if (mode === 'error')
          groups[0] = {
            kind: 'blockers',
            state: 'unavailable',
            problem: 'inaccessible',
            reason:
              'Relationships are inaccessible, missing, or unavailable to this connection. Blocker state is unknown.',
            items: [],
          };
        if (mode === 'partial') groups[0].state = 'partial';
        if (mode === 'missing-status')
          groups[0].items[0].statusCategory = undefined;
        if (connection === 'jira') {
          groups[0] = {
            kind: 'blockers',
            state: mode === 'custom' ? 'partial' : 'visible',
            reason:
              mode === 'custom'
                ? 'Some custom link types have unknown dependency semantics; blocker state may be unknown.'
                : undefined,
            items:
              mode === 'custom'
                ? []
                : [
                    {
                      ...entry('B-2', 'depends on', 'outward'),
                      statusCategory: 'new',
                    },
                  ],
          };
          groups[1] = {
            kind: 'blocked',
            state: 'visible',
            items: [entry('B-3', 'is depended on by', 'inward')],
          };
          groups[2] = {
            kind: 'related',
            state: 'visible',
            items:
              mode === 'custom'
                ? [entry('B-4', 'requires approval from', 'outward')]
                : [],
          };
          groups[3] = {
            kind: 'parent',
            state: 'unavailable',
            reason:
              'Jira did not return a complete parent identity; the parent path is unknown.',
            items: [],
          };
          groups[4] = { kind: 'children', state: 'visible', items: [] };
        }
        if (mode === 'hold') groups[0].items[0].summary = 'Late ignored result';
        if (mode === 'background-hold')
          groups[0].items[0].summary = 'Background inspection retained';
        controls.completed++;
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
    originalBounds = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const bounds = window.getBounds();
      window.setBounds({ ...bounds, width: 1008, height: 640 });
      return bounds;
    });
    await page.clock.install();
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
      .getByRole('button', { name: 'Copy work brief', exact: true })
      .click();
    const brief = page.getByRole('dialog', { name: 'Work brief for team/a#1' });
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Uninspected',
    );
    await expect(brief.getByLabel('Work brief Markdown')).not.toContainText(
      '## Dependency links\n\nNone',
    );
    expect(
      await app.evaluate(() => globalThis.relationshipAudit.calls.length),
    ).toBe(0);
    await brief.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Sample team/a#11',
    );
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Incoming',
    );
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Partial',
    );
    await brief
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await pane
      .getByRole('button', { name: 'Inspect relationships', exact: true })
      .click();
    await expect(
      pane.getByRole('region', { name: 'Blockers', exact: true }),
    ).toContainText('Incoming');
    await expect(pane).toContainText('GitHub · work account');
    await expect(pane).toContainText('children; more may exist');
    await expect(pane).toContainText('Outside this connection');
    await pane
      .getByRole('button', { name: 'Copy work brief', exact: true })
      .click();
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Sample team/a#11',
    );
    await expect(brief.getByLabel('Work brief Markdown')).toContainText(
      'Cross-repository',
    );
    await expect(brief.getByLabel('Work brief Markdown')).not.toContainText(
      'Uninspected',
    );
    await brief
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(
      pane.getByRole('button', { name: 'Show private/repo#9 in tree' }),
    ).toHaveCount(0);
    await pane
      .getByRole('button', { name: 'Show team/a#11 in tree', exact: true })
      .click();
    await expect(page.getByRole('tab')).toHaveCount(4);
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
    await expect(page.getByRole('tab')).toHaveCount(5);
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
    const ensureSourcePreview = async () => {
      await source.focus();
      if (!(await pane.isVisible())) await page.keyboard.press('Space');
      await expect(pane).toHaveAttribute('aria-label', 'Preview team/a#1');
      const inspect = pane.getByRole('button', {
        name: 'Inspect relationships',
        exact: true,
      });
      if (await inspect.count()) await inspect.click();
    };
    const expectOwner = async (selectedKey) => {
      await expect(page.getByRole('tab').nth(2)).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect
        .poll(() =>
          app.evaluate(() => {
            const workspace = globalThis.relationshipAudit.saved;
            const active = workspace?.tabs.find(
              (tab) => tab.id === workspace.activeTabId,
            );
            return {
              id: active?.id,
              connection: active?.connectionId,
              selectedKey: active?.selectedKey,
            };
          }),
        )
        .toEqual({ id: 'owner', connection: 'work', selectedKey });
      await expect(
        page.locator(`[data-tree-key="${selectedKey}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-tree-key="${selectedKey}"]`),
      ).toBeFocused();
    };
    await ensureSourcePreview();
    await pane
      .getByRole('region', { name: 'Parent path', exact: true })
      .getByRole('button', { name: 'Show team/a#10 in tree', exact: true })
      .click();
    await expectOwner('team/a#10');
    await page.getByRole('tab').first().click();
    await ensureSourcePreview();
    await pane
      .getByRole('region', { name: 'Child paths', exact: true })
      .getByRole('button', { name: 'Show team/a#12 in tree', exact: true })
      .click();
    await expectOwner('team/a#12');
    await expect(page.getByRole('tab')).toHaveCount(5);
    await page.getByRole('tab').first().click();
    await page.getByRole('button', { name: 'Next tasks', exact: true }).click();
    const tasks = page.getByRole('region', { name: 'Next tasks', exact: true });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Sample team/a#11');
    await expect(tasks).toContainText('Blocked by team/a#11');
    // Exercise the real production scheduler; provider data, not rendered state,
    // controls whether polling preserves or invalidates inspection authority.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    clockPaused = true;
    const poll = async (milliseconds) => {
      const before = await app.evaluate(
        () =>
          globalThis.relationshipAudit.treeCalls.filter(
            (call) => call.connection === 'work' && call.key === 'team/a#1',
          ).length,
      );
      await page.clock.runFor(milliseconds);
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              globalThis.relationshipAudit.treeCalls.filter(
                (call) => call.connection === 'work' && call.key === 'team/a#1',
              ).length,
          ),
        )
        .toBeGreaterThan(before);
      await expect(page.locator('[role="tab"] .spin')).toHaveCount(0);
    };
    await poll(31_000);
    await expect(tasks).toContainText('Blocked by team/a#11');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'background-hold';
      globalThis.relationshipAudit.release = null;
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect
      .poll(() =>
        app.evaluate(() => typeof globalThis.relationshipAudit.release),
      )
      .toBe('function');
    const pollHeld = await app.evaluate(() => ({
      call: globalThis.relationshipAudit.calls.at(-1),
      cancelledBefore: globalThis.relationshipAudit.cancelled.length,
    }));
    expect(pollHeld.call).toMatchObject({
      connection: 'work',
      key: 'team/a#1',
    });
    expect(pollHeld.call.requestId).toEqual(expect.any(String));
    await poll(31_000);
    await expect(
      tasks.getByRole('button', { name: 'Loading relationships…' }),
    ).toBeVisible();
    expect(
      await app.evaluate(
        (_electron, { call, cancelledBefore }) =>
          globalThis.relationshipAudit.cancelled
            .slice(cancelledBefore)
            .some(
              (cancelled) =>
                cancelled.connection === call.connection &&
                cancelled.requestId === call.requestId,
            ),
        pollHeld,
      ),
    ).toBe(false);
    await app.evaluate(() => globalThis.relationshipAudit.release());
    await expect(tasks).toContainText('Background inspection retained');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(tasks).toContainText('Blocker state unknown');
    await expect(tasks).not.toContainText('Background inspection retained');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'normal';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Blocked by team/a#11');
    // Open the actual edit gate after the manual tree read starts. Its response
    // is deferred, and the eventual unchanged retry must keep manual intent.
    await app.evaluate(() => {
      const state = globalThis.relationshipAudit;
      state.mode = 'background-hold';
      state.release = null;
      state.heldSourceTree = true;
      state.treeRelease = null;
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect
      .poll(() =>
        app.evaluate(() => typeof globalThis.relationshipAudit.release),
      )
      .toBe('function');
    const deferredHeld = await app.evaluate(() => ({
      call: globalThis.relationshipAudit.calls.at(-1),
      cancelledBefore: globalThis.relationshipAudit.cancelled.length,
    }));
    expect(deferredHeld.call).toMatchObject({
      connection: 'work',
      key: 'team/a#1',
    });
    expect(deferredHeld.call.requestId).toEqual(expect.any(String));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => typeof globalThis.relationshipAudit.treeRelease),
      )
      .toBe('function');
    await source
      .getByRole('button', { name: 'Sample team/a#1', exact: true })
      .dblclick();
    const titleEditor = source.getByRole('textbox', {
      name: 'Title for team/a#1',
    });
    await expect(titleEditor).toBeVisible();
    await app.evaluate(() => globalThis.relationshipAudit.treeRelease());
    await expect(page.locator('[role="tab"] .spin')).toHaveCount(0);
    await expect(
      tasks.getByRole('button', { name: 'Loading relationships…' }),
    ).toBeVisible();
    const deferredCancelled = () =>
      app.evaluate(
        (_electron, { call, cancelledBefore }) =>
          globalThis.relationshipAudit.cancelled
            .slice(cancelledBefore)
            .some(
              (cancelled) =>
                cancelled.connection === call.connection &&
                cancelled.requestId === call.requestId,
            ),
        deferredHeld,
      );
    expect(await deferredCancelled()).toBe(false);
    await app.evaluate(() => {
      globalThis.relationshipAudit.heldSourceTree = false;
    });
    await titleEditor.press('Escape');
    // A retry inside the root cooldown must retain intent until a read succeeds.
    await page.clock.runFor(1_500);
    await expect(
      tasks.getByRole('button', { name: 'Loading relationships…' }),
    ).toBeVisible();
    expect(await deferredCancelled()).toBe(false);
    await poll(31_000);
    await expect(tasks).toContainText('Blocker state unknown');
    expect(await deferredCancelled()).toBe(true);
    const deferredCompleted = await app.evaluate(
      () => globalThis.relationshipAudit.completed,
    );
    await app.evaluate(() => globalThis.relationshipAudit.release());
    await expect
      .poll(() => app.evaluate(() => globalThis.relationshipAudit.completed))
      .toBeGreaterThan(deferredCompleted);
    await expect(tasks).not.toContainText('Background inspection retained');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'normal';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Blocked by team/a#11');
    await app.evaluate(() => {
      const state = globalThis.relationshipAudit;
      state.mode = 'background-hold';
      state.release = null;
      state.pollTargetUnavailable = true;
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect
      .poll(() =>
        app.evaluate(() => typeof globalThis.relationshipAudit.release),
      )
      .toBe('function');
    const changedHeld = await app.evaluate(() => ({
      call: globalThis.relationshipAudit.calls.at(-1),
      cancelledBefore: globalThis.relationshipAudit.cancelled.length,
    }));
    expect(changedHeld.call).toMatchObject({
      connection: 'work',
      key: 'team/a#1',
    });
    expect(changedHeld.call.requestId).toEqual(expect.any(String));
    await poll(121_000);
    await expect(tasks).toContainText('Blocker state unknown');
    expect(
      await app.evaluate(
        (_electron, { call, cancelledBefore }) =>
          globalThis.relationshipAudit.cancelled
            .slice(cancelledBefore)
            .some(
              (cancelled) =>
                cancelled.connection === call.connection &&
                cancelled.requestId === call.requestId,
            ),
        changedHeld,
      ),
    ).toBe(true);
    const changedCompleted = await app.evaluate(
      () => globalThis.relationshipAudit.completed,
    );
    await app.evaluate(() => globalThis.relationshipAudit.release());
    await expect
      .poll(() => app.evaluate(() => globalThis.relationshipAudit.completed))
      .toBeGreaterThan(changedCompleted);
    await expect(tasks).not.toContainText('Background inspection retained');
    await app.evaluate(() => {
      const state = globalThis.relationshipAudit;
      state.mode = 'normal';
      state.pollTargetUnavailable = false;
    });
    // Confirm restored target evidence before testing unrelated refreshes.
    await poll(241_000);
    await page.clock.resume();
    clockPaused = false;
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks).toContainText('Blocked by team/a#11');
    // Deliver a real held tree response after returning to the source, without
    // navigation during its pending relationship inspection. Exercise both
    // another account and an unrelated root in the same account.
    for (const [index, connection] of [
      [1, 'other'],
      [2, 'work'],
    ]) {
      await page.getByRole('tab').nth(index).click();
      const marker = `Confirmed background ${connection}`;
      await app.evaluate(
        (_electron, { connection, marker }) => {
          const state = globalThis.relationshipAudit;
          state.heldTreeConnection = connection;
          state.backgroundMarker = marker;
          state.treeRelease = null;
        },
        { connection, marker },
      );
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(() => typeof globalThis.relationshipAudit.treeRelease),
        )
        .toBe('function');
      await page.getByRole('tab').first().click();
      await expect(tasks).toContainText('Blocked by team/a#11');
      await app.evaluate(() => {
        globalThis.relationshipAudit.mode = 'background-hold';
        globalThis.relationshipAudit.release = null;
      });
      await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
      await expect
        .poll(() =>
          app.evaluate(() => typeof globalThis.relationshipAudit.release),
        )
        .toBe('function');
      const backgroundHeld = await app.evaluate(() => ({
        call: globalThis.relationshipAudit.calls.at(-1),
        cancelledBefore: globalThis.relationshipAudit.cancelled.length,
      }));
      expect(backgroundHeld.call).toMatchObject({
        connection: 'work',
        key: 'team/a#1',
      });
      expect(backgroundHeld.call.requestId).toEqual(expect.any(String));
      await app.evaluate(() => globalThis.relationshipAudit.treeRelease());
      await expect(page.getByRole('tab').nth(index)).toContainText(marker);
      await expect(
        tasks.getByRole('button', { name: 'Loading relationships…' }),
      ).toBeVisible();
      expect(
        await app.evaluate(
          (_electron, { call, cancelledBefore }) =>
            globalThis.relationshipAudit.cancelled
              .slice(cancelledBefore)
              .some(
                (cancelled) =>
                  cancelled.connection === call.connection &&
                  cancelled.requestId === call.requestId,
              ),
          backgroundHeld,
        ),
      ).toBe(false);
      await app.evaluate(() => globalThis.relationshipAudit.release());
      await expect(tasks).toContainText('Background inspection retained');
      await app.evaluate(() => {
        const state = globalThis.relationshipAudit;
        state.mode = 'normal';
        state.release = null;
        state.heldTreeConnection = null;
        state.backgroundMarker = null;
      });
    }
    const beforeRefresh = await app.evaluate(() => ({
      reads: globalThis.relationshipAudit.treeReads,
      relationships: globalThis.relationshipAudit.calls.length,
    }));
    // Add the stale completed target to the current root only after account-scoped
    // owning-tree navigation, so Next tasks actually encounters the old fallback.
    await app.evaluate(() => {
      globalThis.relationshipAudit.includeCompletedBlocker = true;
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.relationshipAudit.treeReads))
      .toBeGreaterThan(beforeRefresh.reads);
    await expect(tasks).toContainText('Blocker state unknown');
    expect(
      await app.evaluate(() => globalThis.relationshipAudit.calls.length),
    ).toBe(beforeRefresh.relationships);
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'missing-status';
    });
    await tasks.getByRole('button', { name: 'Inspect blockers' }).click();
    await expect(tasks.locator('.next-task')).toHaveCount(1);
    await expect(tasks.locator('.next-task-title')).toContainText(
      'team/a#1 Sample team/a#1',
    );
    await expect(tasks.locator('.next-task-relationships')).toContainText(
      'GitHub · work account · team/a#1 blocked by team/a#11 · Sample team/a#11 · Status unknown',
    );
    await expect(tasks).toContainText('Blocker state unknown');
    await expect(tasks).not.toContainText('No active visible blockers found');
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
      globalThis.relationshipAudit.release = null;
    });
    const inspect = tasks.getByRole('button', { name: 'Inspect blockers' });
    await inspect.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        inspect.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const pane = button.closest('.next-tasks').getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const hit = document.elementFromPoint(x, y);
          return (
            x >= pane.left &&
            x <= pane.right &&
            y >= pane.top &&
            y <= pane.bottom &&
            button.contains(hit)
          );
        }),
      )
      .toBe(true);
    await inspect.click();
    await expect(
      tasks.getByRole('button', { name: 'Loading relationships…' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(() => typeof globalThis.relationshipAudit.release),
      )
      .toBe('function');
    const held = await app.evaluate(() => ({
      call: globalThis.relationshipAudit.calls.at(-1),
      cancelledBefore: globalThis.relationshipAudit.cancelled.length,
    }));
    expect(held.call).toMatchObject({ connection: 'work', key: 'team/a#1' });
    expect(held.call.requestId).toEqual(expect.any(String));
    await page.getByRole('tab').nth(1).click();
    await expect
      .poll(() =>
        app.evaluate(
          (_electron, { call, cancelledBefore }) =>
            globalThis.relationshipAudit.cancelled
              .slice(cancelledBefore)
              .some(
                (cancelled) =>
                  cancelled.connection === call.connection &&
                  cancelled.requestId === call.requestId,
              ),
          held,
        ),
      )
      .toBe(true);
    const completedBeforeRelease = await app.evaluate(
      () => globalThis.relationshipAudit.completed,
    );
    await app.evaluate(() => {
      globalThis.relationshipAudit.release();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.relationshipAudit.completed))
      .toBeGreaterThan(completedBeforeRelease);
    await expect(page.getByRole('tab').nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab').first().click();
    // Returning to the originating route must not expose a response that ignored cancellation.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(tasks).not.toContainText('Late ignored result');
    await expect(
      tasks.getByRole('button', { name: 'Inspect blockers' }),
    ).toBeEnabled();

    // Jira reviewed cases: documented Depends, uninterpreted custom link, incomplete parent.
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'normal';
    });
    await page.getByRole('tab').nth(3).click();
    const jiraRow = page.locator('[data-tree-key="A-1"]');
    await expect(jiraRow).toBeVisible();
    await jiraRow.focus();
    if (!(await pane.isVisible())) await page.keyboard.press('Space');
    await expect(pane).toHaveAttribute('aria-label', 'Preview A-1');
    await pane
      .getByRole('button', { name: 'Inspect relationships', exact: true })
      .click();
    await expect(
      pane.getByRole('region', { name: 'Blockers', exact: true }),
    ).toContainText('A-1 depends on B-2');
    await expect(
      pane.getByRole('region', { name: 'Blocked issues', exact: true }),
    ).toContainText('A-1 is depended on by B-3');
    const parent = pane.getByRole('region', {
      name: 'Parent path',
      exact: true,
    });
    await expect(parent).toContainText('unavailable');
    await expect(parent).toContainText('unknown');
    await expect(parent).not.toContainText('No visible parent path returned');
    await page.getByRole('button', { name: 'Next tasks', exact: true }).click();
    await expect(tasks).toContainText('Blocked by B-2');
    await app.evaluate(() => {
      globalThis.relationshipAudit.mode = 'custom';
    });
    await inspect.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        inspect.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const pane = button.closest('.next-tasks').getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return (
            x >= pane.left &&
            x <= pane.right &&
            y >= pane.top &&
            y <= pane.bottom &&
            button.contains(document.elementFromPoint(x, y))
          );
        }),
      )
      .toBe(true);
    await inspect.click();
    await expect(tasks).toContainText('Blocker state unknown');
    await expect(tasks).not.toContainText('No active visible blockers found');
  } finally {
    if (clockPaused) await page.clock.resume();
    await app.evaluate(({ ipcMain }) => {
      for (const [channel, handler] of globalThis.relationshipAuditHandlers) {
        ipcMain.removeHandler(channel);
        if (handler) ipcMain.handle(channel, handler);
      }
    });
    if (originalBounds)
      await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0].setBounds(bounds);
      }, originalBounds);
  }
}
