import { expect } from '@playwright/test';

export async function auditGithub(app, page) {
  await app.evaluate(({ safeStorage, ipcMain }) => {
    // Synthetic credentials remain in the isolated smoke profile.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    safeStorage.encryptString = (value) => Buffer.from(value);
    safeStorage.decryptString = (value) => value.toString();
    globalThis.githubSmokeFetch = globalThis.fetch;
    const issue = (repo, number, extra = {}) => ({
      id: number + (repo === 'team/b' ? 100 : 0),
      node_id: `${repo}-${number}`,
      number,
      html_url: `https://github.com/${repo}/issues/${number}`,
      title: `${repo} issue ${number}`,
      state: 'open',
      labels: [],
      comments: 0,
      ...extra,
    });
    globalThis.githubSmokeIssues = {
      'team/a#1': issue('team/a', 1),
      'team/a#3': issue('team/a', 3, { state: 'closed' }),
      'team/a#4': issue('team/a', 4),
      'team/b#2': issue('team/b', 2),
    };
    globalThis.githubSmokePatches = [];
    const channel = 'canopy:transitions';
    globalThis.githubSmokeTransitionHandler =
      ipcMain._invokeHandlers.get(channel);
    globalThis.githubSmokeTransitionCalls = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, connection, key, refresh) => {
      globalThis.githubSmokeTransitionCalls.push({ connection, key });
      return globalThis.githubSmokeTransitionHandler(
        event,
        connection,
        key,
        refresh,
      );
    });
    globalThis.githubSmokeReads = 0;
    globalThis.githubSmokeLimitNext = false;
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== 'api.github.com')
        return globalThis.githubSmokeFetch(url, init);
      const path = parsed.pathname;
      if (path === '/user') return Response.json({ login: 'tester' });
      if (path === '/graphql') {
        const ids = JSON.parse(String(init.body)).variables.ids;
        return Response.json({
          data: {
            nodes: ids.map(() => ({
              parent: null,
              subIssuesSummary: { total: 0 },
            })),
          },
        });
      }
      if (/^\/repos\/team\/[ab]\/issues$/.test(path))
        return Response.json(
          parsed.searchParams.has('state')
            ? [
                globalThis.githubSmokeIssues['team/a#1'],
                globalThis.githubSmokeIssues['team/a#3'],
                globalThis.githubSmokeIssues['team/a#4'],
              ]
            : [],
        );
      if (path === '/repos/team/a/issues/1/sub_issues')
        return Response.json([globalThis.githubSmokeIssues['team/b#2']]);
      if (path === '/repos/team/b/issues/2/sub_issues')
        return Response.json([]);
      if (path === '/repos/team/a/issues/1') {
        if (init.method !== 'PATCH') {
          globalThis.githubSmokeReads++;
          if (globalThis.githubSmokeLimitNext) {
            globalThis.githubSmokeLimitNext = false;
            return new Response('{"message":"secondary rate limit"}', {
              status: 429,
              headers: { 'retry-after': '1' },
            });
          }
        }
        if (init.method === 'PATCH') {
          const patch = JSON.parse(String(init.body));
          globalThis.githubSmokePatches.push(patch);
          const current = globalThis.githubSmokeIssues['team/a#1'];
          globalThis.githubSmokeIssues['team/a#1'] = {
            ...current,
            title: patch.title ?? current.title,
            state: patch.state ?? current.state,
            labels: patch.labels?.map((name) => ({ name })) ?? current.labels,
            assignee: patch.assignees
              ? patch.assignees[0]
                ? { login: patch.assignees[0] }
                : null
              : current.assignee,
          };
        }
        return Response.json(globalThis.githubSmokeIssues['team/a#1']);
      }
      if (path === '/repos/team/a/issues/1/comments') return Response.json([]);
      if (path.endsWith('/dependencies/blocked_by'))
        return Response.json([globalThis.githubSmokeIssues['team/b#2']]);
      if (path.endsWith('/dependencies/blocking')) return Response.json([]);
      if (path === '/repos/team/a/labels')
        return Response.json([{ name: 'ready' }]);
      if (path === '/repos/team/a/assignees')
        return Response.json([{ login: 'tester' }]);
      if (path === '/search/issues') {
        if (
          parsed.searchParams.get('q')?.includes('only-b') &&
          parsed.searchParams.get('q')?.includes('repo:team/a')
        )
          return Response.json({ total_count: 0, items: [] });
        const repo = parsed.searchParams.get('q')?.includes('repo:team/b')
          ? 'team/b'
          : 'team/a';
        return Response.json({
          total_count: 1,
          items: [
            globalThis.githubSmokeIssues[
              repo === 'team/a' ? 'team/a#1' : 'team/b#2'
            ],
          ],
        });
      }
      throw new Error(`Unexpected GitHub smoke request: ${path}`);
    };
  });
  try {
    await page
      .getByRole('complementary', { name: 'Canopy sidebar' })
      .getByRole('button', { name: 'Connect Jira or GitHub', exact: true })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: 'Connect Jira' })
      .getByRole('button', { name: 'GitHub' })
      .click();
    await page
      .getByPlaceholder('owner/repo-one, owner/repo-two')
      .fill('team/a, team/b');
    await page
      .getByRole('dialog', { name: 'Connect GitHub' })
      .getByPlaceholder('Paste your token')
      .fill('fixture-secret');
    await page
      .getByRole('button', { name: 'Connect GitHub', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Connect GitHub' }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Open issue', exact: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Open issue tree' });
    await dialog
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .fill('https://github.com/team/a/issues/1');
    await dialog.getByRole('button', { name: 'Open tree' }).click();
    const tree = page.getByRole('tree', { name: 'team/a#1 issue tree' });
    await expect(
      tree.getByRole('treeitem', { name: /team\/a#1/ }),
    ).toBeVisible();
    await expect(
      tree.getByRole('treeitem', { name: /team\/b#2/ }),
    ).toBeVisible();
    const child = tree.locator('[data-tree-key="team/b#2"]');
    await child.getByRole('button', { name: 'Actions for team/b#2' }).click();
    await page
      .getByRole('menu', { name: 'Actions for team/b#2' })
      .getByRole('menuitem', { name: 'Copy key and summary' })
      .click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'team/b#2 team/b issue 2',
    );
    await expect(page.getByLabel('Filter priority')).toHaveCount(0);
    const statusResize = page.getByRole('separator', {
      name: 'Resize Status column',
    });
    const statusesFit = (issueTree) =>
      issueTree
        .locator('.status')
        .evaluateAll((badges) =>
          badges.every((badge) => badge.scrollWidth <= badge.clientWidth),
        );
    await expect(tree.locator('.status')).toHaveCount(2);
    await expect(statusResize).toHaveAttribute('aria-valuenow', '128');
    expect(await statusesFit(tree)).toBe(true);
    const originalWindowSize = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getSize();
      window.setSize(920, size[1]);
      return size;
    });
    await expect
      .poll(() =>
        page
          .locator('.tree-scroll')
          .evaluate((scroll) => scroll.scrollWidth > scroll.clientWidth),
      )
      .toBe(true);
    expect(await statusesFit(tree)).toBe(true);
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(...size);
    }, originalWindowSize);
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('large');
    await expect(tree).toHaveCSS('font-size', '15px');
    expect(await statusesFit(tree)).toBe(true);
    await page.getByLabel('Text size', { exact: true }).selectOption('medium');
    await page.locator('.view-settings > summary').click();
    await statusResize.press('ArrowRight');
    await expect(statusResize).toHaveAttribute('aria-valuenow', '138');
    const root = tree.locator('[data-tree-key="team/a#1"]');
    const assignee = root.getByRole('button', {
      name: 'Edit assignee for team/a#1',
    });
    const status = root.getByRole('button', {
      name: 'Edit status for team/a#1',
    });
    const action = root.getByRole('button', { name: 'Actions for team/a#1' });
    const patchCount = () =>
      app.evaluate(() => globalThis.githubSmokePatches.length);
    const beforeDismiss = await patchCount();
    await assignee.click();
    await page.getByLabel('Search assignees').fill('tester');
    await page.getByLabel('Search assignees').press('Escape');
    await expect(assignee).toBeFocused();
    await expect(page.getByLabel('Search assignees')).toHaveCount(0);
    await assignee.click();
    await status.click();
    await expect(page.getByLabel('Search assignees')).toHaveCount(0);
    const closed = root.getByRole('menuitem', { name: 'Closed' });
    await expect(closed).toBeVisible();
    await closed.press('Escape');
    await expect(status).toBeFocused();
    await expect(closed).toHaveCount(0);
    await action.click();
    const rowMenu = page.getByRole('menu', { name: 'Actions for team/a#1' });
    await rowMenu
      .getByRole('menuitem', { name: 'Copy key', exact: true })
      .press('Escape');
    await expect(rowMenu).toHaveCount(0);
    await expect(action).toBeFocused();
    await action.click();
    await assignee.click();
    await expect(rowMenu).toHaveCount(0);
    await expect(page.getByLabel('Search assignees')).toBeFocused();
    await page.locator('.view-settings > summary').click();
    await expect(page.getByLabel('Search assignees')).toHaveCount(0);
    expect(await patchCount()).toBe(beforeDismiss);
    await page.locator('.view-settings > summary').press('Escape');
    await root
      .getByRole('button', { name: 'team/a issue 1', exact: true })
      .dblclick();
    await root
      .getByRole('textbox', { name: 'Title for team/a#1' })
      .fill('Updated GitHub title');
    await root
      .getByRole('textbox', { name: 'Title for team/a#1' })
      .press('Enter');
    await expect(root).toContainText('Updated GitHub title');
    await assignee.click();
    await root.getByRole('button', { name: 'Assign to me' }).click();
    await expect(root).toContainText('tester');
    await status.click();
    await expect(root.getByRole('menuitem', { name: 'Open' })).toBeVisible();
    await expect(root.getByRole('menuitem', { name: 'Closed' })).toBeVisible();
    await expect(root.getByRole('menuitem', { name: 'Done' })).toHaveCount(0);
    const firstStatusCalls = await app.evaluate(
      () => globalThis.githubSmokeTransitionCalls.length,
    );
    expect(firstStatusCalls).toBe(1);
    await root.getByRole('menuitem', { name: 'Closed' }).press('Escape');
    await page.evaluate(() => {
      const field = document.querySelector(
        '[aria-label="Edit status for team/a#1"]',
      );
      window.githubStatusLoading = false;
      const observer = new MutationObserver(() => {
        if (document.querySelector('.status-popover .choice-loading'))
          window.githubStatusLoading = true;
        if (document.querySelector('.status-popover [role="menuitem"]'))
          observer.disconnect();
      });
      field.addEventListener(
        'click',
        () =>
          observer.observe(document.body, {
            childList: true,
            subtree: true,
          }),
        { once: true },
      );
    });
    await status.click();
    await expect(root.getByRole('menuitem', { name: 'Closed' })).toBeVisible();
    expect(await page.evaluate(() => window.githubStatusLoading)).toBe(false);
    expect(
      await app.evaluate(() => globalThis.githubSmokeTransitionCalls.length),
    ).toBe(firstStatusCalls);
    await root.getByRole('menuitem', { name: 'Closed' }).click();
    await expect(root).toContainText('Closed');
    await root
      .getByRole('button', { name: 'Edit status for team/a#1' })
      .click();
    await expect(root.getByRole('menuitem', { name: 'Open' })).toBeVisible();
    expect(
      await app.evaluate(() => globalThis.githubSmokeTransitionCalls.length),
    ).toBe(firstStatusCalls + 1);
    await root.getByRole('menuitem', { name: 'Open' }).press('Escape');
    await tree.getByRole('treeitem', { name: /team\/a#1/ }).press('Space');
    const preview = page.getByRole('complementary', {
      name: 'Preview team/a#1',
    });
    await preview.getByRole('button', { name: 'Copy key and summary' }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'team/a#1 Updated GitHub title',
    );
    await expect(preview.getByText('No labels.')).toBeVisible();
    await expect(preview.getByText('team/b#2')).toBeVisible();
    await preview.getByRole('button', { name: 'Edit labels' }).click();
    await preview.getByRole('checkbox', { name: 'ready' }).click();
    await expect(
      preview.getByRole('checkbox', { name: 'ready' }),
    ).toBeChecked();
    await expect(preview.getByText('team/b#2')).toBeVisible();
    await preview.getByRole('button', { name: 'Close issue preview' }).click();
    await page
      .getByRole('button', { name: 'Open issue', exact: true })
      .first()
      .click();
    const search = page.getByRole('dialog', { name: 'Open issue tree' });
    await search
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .fill('feature');
    await search.getByRole('checkbox', { name: 'Group by repository' }).check();
    await expect(search.getByText('team/a', { exact: true })).toBeVisible();
    await expect(search.getByText('team/b', { exact: true })).toBeVisible();
    await expect(search.getByRole('button', { name: 'Load more' })).toHaveCount(
      0,
    );
    await search
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .fill('b');
    await expect(
      search.getByRole('option', { name: /team\/b.*Repository/ }),
    ).toBeVisible();
    await search
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .fill('team');
    await expect(
      search.getByRole('option', { name: /team\/a#1/ }),
    ).toBeVisible();
    await search
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .press('ArrowDown');
    await expect(
      search.getByRole('option', { name: /team\/a#1/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await search
      .getByRole('combobox', {
        name: 'GitHub URL, owner/repo, issue number, or title',
      })
      .fill('only-b');
    await expect(
      search.getByRole('option', { name: /team\/b#2/ }),
    ).toBeVisible();
    await expect(search.getByRole('button', { name: 'Load more' })).toHaveCount(
      0,
    );
    await search.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('button', { name: 'Open issue', exact: true })
      .first()
      .click();
    const repositoryDialog = page.getByRole('dialog', {
      name: 'Open issue tree',
    });
    await repositoryDialog
      .getByRole('option', { name: /team\/a.*Repository/ })
      .click();
    const repositoryTree = page.getByRole('tree', {
      name: 'team/a issue tree',
    });
    await expect(
      repositoryTree.getByRole('treeitem', { name: /team\/a#4/ }),
    ).toBeVisible();
    const repositoryRoot = repositoryTree.locator(
      '[data-tree-key="team/a"] > .issue-row',
    );
    await expect(
      repositoryRoot.getByRole('button', { name: /Edit (assignee|status)/ }),
    ).toHaveCount(0);
    const repositoryAction = repositoryRoot.getByRole('button', {
      name: 'Actions for team/a',
    });
    await repositoryAction.click();
    await page
      .getByRole('menu', { name: 'Actions for team/a' })
      .getByRole('menuitem', { name: 'Copy key', exact: true })
      .press('Escape');
    await expect(repositoryAction).toBeFocused();
    await repositoryAction.click();
    await page.locator('.view-settings > summary').click();
    await expect(
      page.getByRole('menu', { name: 'Actions for team/a' }),
    ).toHaveCount(0);
    await page.locator('.view-settings > summary').press('Escape');
    await expect(
      repositoryTree.getByRole('treeitem', { name: /team\/a#3/ }),
    ).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Hide closed' }).uncheck();
    await expect(
      repositoryTree.getByRole('treeitem', { name: /team\/a#3/ }),
    ).toBeVisible();
    await expect(statusResize).toHaveAttribute('aria-valuenow', '128');
    await expect(repositoryTree.locator('.status')).toHaveCount(3);
    expect(await statusesFit(repositoryTree)).toBe(true);
    await page.getByRole('tab', { name: /team\/a#1/ }).click();
    await expect(statusResize).toHaveAttribute('aria-valuenow', '138');

    const reads = () => app.evaluate(() => globalThis.githubSmokeReads);
    const beforeDuplicate = await reads();
    await page.evaluate(async () => {
      const workspace = await window.canopy.loadWorkspace();
      const issueTab = workspace.tabs.find((tab) => tab.rootKey === 'team/a#1');
      await window.canopy.saveWorkspace({
        ...workspace,
        tabs: [
          issueTab,
          { ...issueTab, id: 'github-duplicate', rootKey: 'TEAM/A#1' },
        ],
        activeTabId: issueTab.id,
      });
    });
    await page.reload();
    await expect(
      page.getByRole('tree', { name: 'team/a#1 issue tree' }),
    ).toBeVisible();
    await expect.poll(reads).toBe(beforeDuplicate + 1);
    await page.getByRole('tab').nth(1).click();
    await expect(page.locator('.statusbar')).toContainText('Last updated');
    expect(await reads()).toBe(beforeDuplicate + 1);
    const timestamp = page.locator('.statusbar [title]').first();
    const beforeManual = await timestamp.getAttribute('title');
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(reads).toBe(beforeDuplicate + 2);
    await expect(timestamp).not.toHaveAttribute('title', beforeManual);
    const updated = await timestamp.getAttribute('title');
    await page.getByRole('tab').nth(0).click();
    await expect(timestamp).toHaveAttribute('title', updated);
    expect(await reads()).toBe(beforeDuplicate + 2);

    await app.evaluate(() => {
      globalThis.githubSmokeLimitNext = true;
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(reads).toBe(beforeDuplicate + 3);
    const connectionStatus = page.getByRole('status', {
      name: 'Connection status',
    });
    await expect(connectionStatus).toHaveText('Rate limited');
    await expect(
      page.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await reads()).toBe(beforeDuplicate + 3);
    await expect.poll(reads, { timeout: 10_000 }).toBe(beforeDuplicate + 4);
    await expect(connectionStatus).toHaveText('Connected');

    await page
      .getByRole('button', { name: 'Open issue', exact: true })
      .first()
      .click();
    const crossProviderDialog = page.getByRole('dialog', {
      name: 'Open issue tree',
    });
    const crossProviderInput = crossProviderDialog.getByRole('combobox', {
      name: 'GitHub URL, owner/repo, issue number, or title',
    });
    await crossProviderInput.fill('CAN-123');
    await expect(
      crossProviderDialog.getByRole('option', { name: /team\/a#1/ }),
    ).toBeVisible();
    await crossProviderInput.fill('team/a#1');
    await crossProviderInput.press('Enter');
    await expect(crossProviderDialog).toHaveCount(0);
    await expect(
      page.getByRole('tree', { name: 'team/a#1 issue tree' }),
    ).toBeVisible();
    await page.getByTitle('Disconnect GitHub · tester').click();
    await expect(
      page.getByText('GitHub · tester', { exact: true }),
    ).toHaveCount(0);
    console.log(
      'GitHub integration passed: connection, tree, edits, search, duplicate-root refresh, and rate-limit recovery.',
    );
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('canopy:transitions');
      ipcMain.handle(
        'canopy:transitions',
        globalThis.githubSmokeTransitionHandler,
      );
      delete globalThis.githubSmokeTransitionHandler;
      delete globalThis.githubSmokeTransitionCalls;
      globalThis.fetch = globalThis.githubSmokeFetch;
    });
  }
}
