import { expect } from '@playwright/test';

export async function auditGithub(app, page) {
  await app.evaluate(({ safeStorage }) => {
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
        if (init.method === 'PATCH') {
          const patch = JSON.parse(String(init.body));
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
    await expect(page.getByLabel('Filter priority')).toHaveCount(0);
    const root = tree.locator('[data-tree-key="team/a#1"]');
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
    await root
      .getByRole('button', { name: 'Edit assignee for team/a#1' })
      .click();
    await root.getByRole('button', { name: 'Assign to me' }).click();
    await expect(root).toContainText('tester');
    await root
      .getByRole('button', { name: 'Edit status for team/a#1' })
      .click();
    await root.getByRole('menuitem', { name: 'Closed' }).click();
    await expect(root).toContainText('Closed');
    await tree.getByRole('treeitem', { name: /team\/a#1/ }).press('Space');
    const preview = page.getByRole('complementary', {
      name: 'Preview team/a#1',
    });
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
    await expect(
      repositoryTree.getByRole('treeitem', { name: /team\/a#3/ }),
    ).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Hide closed' }).uncheck();
    await expect(
      repositoryTree.getByRole('treeitem', { name: /team\/a#3/ }),
    ).toBeVisible();
    await page.getByTitle('Disconnect GitHub · tester').click();
    await expect(
      page.getByText('GitHub · tester', { exact: true }),
    ).toHaveCount(0);
    console.log(
      'GitHub integration passed: token connection, cross-repository tree, title, assignee, state, labels, and grouped search.',
    );
  } finally {
    await app.evaluate(() => {
      globalThis.fetch = globalThis.githubSmokeFetch;
    });
  }
}
