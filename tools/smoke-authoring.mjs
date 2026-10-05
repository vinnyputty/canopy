import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authoringAuditLifecycle } from './authoring-audit.mjs';

/** Real renderer/preload interactions with disposable, credential-free provider outcomes. */
export async function auditAuthoring(
  appPath,
  executablePath,
  baseEnv,
  lifecycle,
) {
  // Integration must supply the reviewed, platform-qualified shared primitives.
  // No native launch or profile creation is allowed through the legacy cleanup.
  const createAudit = authoringAuditLifecycle(lifecycle);
  const userData = await mkdtemp(join(tmpdir(), 'canopy-authoring-smoke-'));
  const env = { ...baseEnv, CANOPY_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let page;
  const errors = [];
  const audit = createAudit({ profile: userData, executable: executablePath });
  let primary;
  let primaryFailed = false;
  const launch = async (phase) => {
    app = await audit.launch(phase, () =>
      electron.launch({
        executablePath,
        args: [appPath],
        env,
        timeout: 30_000,
      }),
    );
    page = await audit.run(`${phase}:first-window`, () =>
      app.firstWindow({ timeout: 30_000 }),
    );
    audit.observePage(page);
  };
  const evaluate = (callback, arg) =>
    audit.run('main:evaluate', () => app.evaluate(callback, arg));
  try {
    await launch('initial');
    page.on('pageerror', (error) => errors.push(error));
    await page.getByRole('heading', { name: 'See the whole tree.' }).waitFor();
    const installGithubHandlers = async () => {
      await evaluate(({ ipcMain }) => {
        const state = {
          mode: 'saved',
          release: null,
          requests: [],
          browser: [],
          attachments: [],
          parent: 'team/a#9',
          description: 'Original **Markdown**',
          comments: [],
          creates: 0,
          plans: 0,
        };
        globalThis.authoringSmoke = state;
        const issue = (key = 'team/a#1') => ({
          id: key,
          key,
          summary: key,
          type: 'Issue',
          priority: null,
          assignee: null,
          status: { id: 'open', name: 'Open', category: 'new' },
          links: [],
        });
        const connections = ['first', 'second'].map((id) => ({
          id,
          name: `Authoring ${id}`,
          accountName: id,
          url: 'https://github.com',
          provider: 'github',
          repositories: ['team/a'],
        }));
        const handlers = {
          connections: () => connections,
          currentUser: (_event, id) => ({ id, name: id }),
          loadWorkspace: () => ({
            tabs: [
              {
                id: 'first',
                connectionId: 'first',
                rootKey: 'team/a#1',
                selectedKey: 'team/a#1',
                expanded: ['team/a#1'],
                hideDone: false,
                scrollTop: 0,
              },
              {
                id: 'second',
                connectionId: 'second',
                rootKey: 'team/a#1',
                selectedKey: 'team/a#1',
                expanded: ['team/a#1'],
                hideDone: false,
                scrollTop: 0,
              },
              {
                id: 'other',
                connectionId: 'first',
                rootKey: 'team/a#2',
                selectedKey: 'team/a#2',
                expanded: ['team/a#2'],
                hideDone: false,
                scrollTop: 0,
              },
            ],
            activeTabId: 'first',
            shortcuts: {},
            theme: 'system',
            sidebarCollapsed: false,
          }),
          saveWorkspace: () => {},
          tree: (_event, _id, key) => ({
            rootKey: key,
            issues: [issue(key)],
            fetchedAt: Date.now(),
            warnings: [],
          }),
          preview: (_event, _id, key) => ({
            issue: issue(key),
            description: state.description,
            comments: state.comments,
            totalComments: state.comments.length,
          }),
          authoringOptions: () => ({
            description: {
              editable: true,
              value: state.description,
              revision: JSON.stringify(state.description),
            },
            comment: { allowed: true },
            parent: { allowed: true },
            createChild: true,
            fields: [
              {
                id: 'milestone',
                name: 'Milestone',
                kind: 'choice',
                value: '',
                choices: [{ id: '7', name: 'Release' }],
              },
            ],
            attachments: [
              {
                id: 'file',
                name: 'spec.pdf',
                url: 'https://github.com/user-attachments/assets/sample',
              },
            ],
            handoffs: [
              'Attachment uploads and repository transfers open in GitHub.',
            ],
          }),
          previewParent: (_event, _id, key, parent) => {
            state.plans++;
            return {
              key,
              parentKey: parent,
              previousParent: state.parent,
              revision: 'hierarchy',
              effects: [
                `${key}: parent ${state.parent} → ${parent ?? 'none'}.`,
                `${key} leaves the child list of ${state.parent}.`,
                `${key} enters the child list of ${parent}.`,
                'Existing descendants remain attached to this issue and follow its subtree.',
              ],
            };
          },
          author: async (_event, id, key, action) => {
            state.requests.push({ id, key, action });
            if (state.mode === 'deferred')
              await new Promise((resolve) => {
                state.release = resolve;
              });
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (state.mode === 'rejected')
              return {
                state: 'rejected',
                message:
                  'Permission denied; draft retained. Correct access and retry.',
              };
            if (state.mode === 'unknown')
              return {
                state: 'unknown',
                message:
                  'Lost comment response. Check provider before retrying.',
              };
            if (action.kind === 'child') {
              state.creates++;
              if (state.mode === 'partial')
                return {
                  state: 'partial',
                  key: 'team/a#4',
                  message:
                    'Created team/a#4; parent linking failed. Do not create another issue.',
                };
            }
            if (state.mode === 'partial')
              return {
                state: 'partial',
                message:
                  'Write accepted; refresh verification failed. Refresh before retrying.',
              };
            if (action.kind === 'description') state.description = action.value;
            if (action.kind === 'comment')
              state.comments.push({
                id: '100',
                author: id,
                created: '2026-10-02T00:00:00Z',
                body: action.value,
              });
            if (action.kind === 'parent') state.parent = action.plan.parentKey;
            return { state: 'saved', message: 'Saved and verified.' };
          },
          openIssue: (_event, id, key) => {
            state.browser.push([id, key]);
          },
          openAttachment: (_event, id, key, attachment) => {
            state.attachments.push([id, key, attachment]);
          },
          syncStatus: () => ({ retryAt: null }),
        };
        for (const [name, handler] of Object.entries(handlers)) {
          ipcMain.removeHandler(`canopy:${name}`);
          ipcMain.handle(`canopy:${name}`, handler);
        }
      });
    };
    await installGithubHandlers();
    await audit.run('initial:fixture-reload', () =>
      page.reload({ timeout: 30_000 }),
    );
    const open = async (key = 'team/a#1') => {
      const pane = page.locator('.issue-preview');
      if (!(await pane.isVisible())) {
        await page.locator(`[data-tree-key="${key}"]`).focus();
        await page.keyboard.press('Space');
      }
      const button = pane.getByRole('button', {
        name: 'Edit and discuss',
        exact: true,
      });
      await pane
        .getByRole('button', { name: /^(Edit and discuss|Hide authoring)$/ })
        .waitFor();
      if (await button.isVisible()) await button.click();
      await pane
        .getByRole('heading', { name: 'Add comment', exact: true })
        .waitFor();
      return pane.getByRole('region', { name: `Author ${key}`, exact: true });
    };
    // <section aria-label> has the implicit region role.
    let editor = await open();
    await editor
      .getByLabel('Draft description', { exact: true })
      .fill('<script>window.authoringExecuted=true</script>\n**Draft**');
    await editor
      .getByLabel('Comment draft', { exact: true })
      .fill('Recovered comment');
    await page
      .locator('.issue-preview')
      .getByRole('button', { name: 'Close issue preview', exact: true })
      .click();
    editor = await open();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('Recovered comment');
    await audit.run('fixture:reload', () => page.reload({ timeout: 30_000 }));
    editor = await open();
    await expect(
      editor.getByLabel('Draft description', { exact: true }),
    ).toHaveValue('<script>window.authoringExecuted=true</script>\n**Draft**');
    // A different account with the same key and a different key on the same account get separate drafts.
    await page.getByRole('tab').nth(1).click();
    editor = await open();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('tab').nth(2).click();
    editor = await open('team/a#2');
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('tab').nth(0).click();
    editor = await open();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('Recovered comment');
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'deferred';
    });
    const deferredCount = await evaluate(
      () => globalThis.authoringSmoke.requests.length,
    );
    // Two native click attempts in one renderer turn dispatch only one write.
    await editor
      .getByRole('button', { name: 'Post comment', exact: true })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    await expect
      .poll(() => evaluate(() => Boolean(globalThis.authoringSmoke.release)))
      .toBe(true);
    await page
      .locator('.issue-preview')
      .getByRole('button', { name: 'Close issue preview', exact: true })
      .click();
    editor = await open();
    await editor
      .getByLabel('I checked the provider’s current content and hierarchy')
      .check();
    await expect(
      editor.getByRole('button', { name: 'Allow a new write after review' }),
    ).toBeDisabled();
    await editor
      .getByLabel('Comment draft', { exact: true })
      .fill('New unsent draft while old request settles');
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toBeDisabled();
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'saved';
      globalThis.authoringSmoke.release();
    });
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toBeEnabled();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('New unsent draft while old request settles');
    expect(
      await evaluate(() => globalThis.authoringSmoke.requests.length),
    ).toBe(deferredCount + 1);
    await page
      .locator('.issue-preview')
      .getByRole('button', { name: 'Close issue preview', exact: true })
      .click();
    editor = await open();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('New unsent draft while old request settles');
    await editor
      .getByLabel('Comment draft', { exact: true })
      .fill('Recovered comment');
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'rejected';
    });
    await editor
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(editor.getByRole('alert')).toContainText('Permission denied');
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('Recovered comment');
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toBeEnabled();
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'unknown';
    });
    await editor
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toBeDisabled();
    await audit.closeForRestart(app);
    app = undefined;
    await launch('restart');
    page.on('pageerror', (error) => errors.push(error));
    // Match the initial launch: browser load can precede renderer startup IPC.
    await audit.run('restart:initial-load', async () => {
      await page.waitForLoadState('load', { timeout: 30_000 });
      await page
        .getByRole('heading', { name: 'See the whole tree.' })
        .waitFor({ timeout: 30_000 });
    });
    await audit.run('restart:install-fixtures', installGithubHandlers);
    await audit.run('restart:fixture-reload', () =>
      page.reload({ timeout: 30_000 }),
    );
    editor = await audit.run('restart:open-recovered-draft', open);
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toBeDisabled();
    expect(
      await evaluate(() => globalThis.authoringSmoke.requests.length),
    ).toBe(0);
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('Recovered comment');
    await editor
      .getByRole('button', { name: 'Continue in GitHub', exact: true })
      .click();
    await editor
      .getByLabel('I checked the provider’s current content and hierarchy')
      .check();
    await editor
      .getByRole('button', { name: 'Allow a new write after review' })
      .click();
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'saved';
    });
    await editor
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(
      editor.getByLabel('Comment draft', { exact: true }),
    ).toHaveValue('');
    await expect(page.locator('.issue-preview')).toContainText(
      'Recovered comment',
    );
    await editor
      .getByRole('button', { name: 'Save description', exact: true })
      .click();
    await expect(page.locator('.preview-text').first()).toContainText(
      '<script>window.authoringExecuted=true</script>',
    );
    expect(await page.evaluate(() => window.authoringExecuted)).toBeUndefined();
    await editor
      .getByLabel('Destination parent', { exact: true })
      .fill('team/a#3');
    await expect(
      editor.getByRole('button', { name: 'Apply hierarchy change' }),
    ).toHaveCount(0);
    await editor
      .getByRole('button', { name: 'Preview hierarchy change' })
      .click();
    await expect(editor.getByLabel('Hierarchy effects')).toContainText(
      'team/a#9 → team/a#3',
    );
    await editor
      .getByRole('button', { name: 'Apply hierarchy change' })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.authoringSmoke.parent))
      .toBe('team/a#3');
    await editor.getByRole('button', { name: 'spec.pdf', exact: true }).click();
    await editor.getByLabel('Milestone', { exact: true }).selectOption('7');
    await editor
      .getByRole('button', { name: 'Save Milestone', exact: true })
      .click();
    await expect(
      editor.getByRole('status').filter({ hasText: 'Saved and verified' }),
    ).toContainText('Saved and verified');
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'partial';
    });
    await editor
      .getByLabel('Sub-issue title', { exact: true })
      .fill('Created exactly once');
    await editor
      .getByRole('button', { name: 'Create sub-issue', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: 'Preview team/a#4', exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByRole('button', { name: 'Create sub-issue', exact: true }),
    ).toBeDisabled();
    await editor
      .getByRole('button', { name: 'Refresh authoring options', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: 'Create sub-issue', exact: true }),
    ).toBeDisabled();
    const state = await evaluate(() => globalThis.authoringSmoke);
    expect(state.creates).toBe(1);
    expect(state.browser).toEqual([['first', 'team/a#1']]);
    expect(state.attachments).toEqual([['first', 'team/a#1', 'file']]);
    expect(
      state.requests.every(
        (request) => request.id === 'first' && request.key === 'team/a#1',
      ),
    ).toBe(true);
    await editor
      .getByRole('button', { name: 'Preview team/a#4', exact: true })
      .click();
    editor = await open('team/a#4');
    await evaluate(() => {
      globalThis.authoringSmoke.mode = 'saved';
      globalThis.authoringSmoke.parent = null;
    });
    await editor
      .getByLabel('Destination parent', { exact: true })
      .fill('team/a#1');
    await editor
      .getByRole('button', { name: 'Preview hierarchy change', exact: true })
      .click();
    await editor
      .getByRole('button', { name: 'Apply hierarchy change', exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.authoringSmoke.parent))
      .toBe('team/a#1');
    expect(await evaluate(() => globalThis.authoringSmoke.creates)).toBe(1);
    expect(
      await evaluate(() => globalThis.authoringSmoke.requests.at(-1).key),
    ).toBe('team/a#4');
    // Jira's rich text runs preserve document structure and capability-denied actions hand off.
    await evaluate(({ ipcMain }) => {
      const doc = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [
              {
                type: 'text',
                text: 'Rich heading',
                marks: [{ type: 'strong' }],
              },
            ],
          },
        ],
      };
      const state = { denied: false, document: doc, writes: [], opened: false };
      globalThis.jiraAuthoringSmoke = state;
      const issue = {
        id: '1',
        key: 'ABC-1',
        summary: 'Jira rich fixture',
        type: 'Task',
        priority: null,
        assignee: null,
        status: { id: 'open', name: 'Open', category: 'new' },
        links: [],
      };
      const handlers = {
        connections: () => [
          {
            id: 'jira-fixture',
            name: 'Jira authoring',
            provider: 'jira',
            url: 'https://example.invalid',
          },
        ],
        loadWorkspace: () => ({
          tabs: [
            {
              id: 'jira',
              connectionId: 'jira-fixture',
              rootKey: 'ABC-1',
              selectedKey: 'ABC-1',
              expanded: ['ABC-1'],
              hideDone: false,
              scrollTop: 0,
            },
          ],
          activeTabId: 'jira',
          shortcuts: {},
          theme: 'system',
          sidebarCollapsed: false,
        }),
        tree: () => ({
          rootKey: 'ABC-1',
          issues: [issue],
          fetchedAt: Date.now(),
          warnings: [],
        }),
        preview: () => ({
          issue,
          description: state.document.content[0].content[0].text,
          descriptionDocument: state.document,
          comments: [],
          totalComments: 0,
        }),
        authoringOptions: () => ({
          description: {
            editable: !state.denied,
            value: state.document.content[0].content[0].text,
            revision: JSON.stringify(state.document),
            fragments: [
              { id: '0.0', value: state.document.content[0].content[0].text },
            ],
            reason: state.denied
              ? 'Description unavailable on this account’s edit screen. Open in Jira.'
              : 'Text edits preserve formatting.',
          },
          comment: {
            allowed: false,
            reason: 'Add comments permission unavailable. Open in Jira.',
          },
          parent: {
            allowed: false,
            reason: 'Parent unavailable on this edit screen. Open in Jira.',
          },
          createChild: false,
          fields: state.denied
            ? []
            : [{ id: 'labels', name: 'Labels', kind: 'text', value: 'canopy' }],
          attachments: [
            {
              id: '10',
              name: 'Jira spec.pdf',
              size: 100,
              url: 'https://example.invalid/file',
            },
          ],
          handoffs: [
            'Project moves, structural edits, and attachment uploads open in Jira.',
          ],
        }),
        author: (_event, _id, _key, action) => {
          state.writes.push(action);
          if (action.kind === 'description')
            state.document.content[0].content[0].text =
              action.fragments[0].value;
          return { state: 'saved', message: 'Saved and verified.' };
        },
        openIssue: () => {
          state.opened = true;
        },
      };
      for (const [name, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(`canopy:${name}`);
        ipcMain.handle(`canopy:${name}`, handler);
      }
    });
    await audit.run('fixture:reload', () => page.reload({ timeout: 30_000 }));
    editor = await open('ABC-1');
    await expect(
      editor.getByRole('button', { name: 'Post comment', exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByRole('button', { name: 'Preview hierarchy change' }),
    ).toHaveCount(0);
    await editor
      .getByLabel('Description text run 1', { exact: true })
      .fill('Edited rich heading');
    await editor
      .getByRole('button', { name: 'Save description', exact: true })
      .click();
    await expect(page.locator('.preview-text h2')).toHaveText(
      'Edited rich heading',
    );
    expect(
      await evaluate(
        () =>
          globalThis.jiraAuthoringSmoke.document.content[0].content[0].marks,
      ),
    ).toEqual([{ type: 'strong' }]);
    await evaluate(() => {
      globalThis.jiraAuthoringSmoke.denied = true;
    });
    await editor
      .getByRole('button', { name: 'Refresh authoring options', exact: true })
      .click();
    await expect(
      editor.getByLabel('Description text run 1', { exact: true }),
    ).toHaveCount(0);
    await expect(editor).toContainText(
      'Description unavailable on this account',
    );
    await editor
      .getByRole('button', { name: 'Continue in Jira', exact: true })
      .click();
    expect(await evaluate(() => globalThis.jiraAuthoringSmoke.opened)).toBe(
      true,
    );
    expect(errors, errors.map(String).join('\n')).toEqual([]);
  } catch (error) {
    primaryFailed = true;
    primary = error;
    // Surface the assertion before cleanup, including a blocked close.
    audit.failure(error);
  } finally {
    await audit.finish({
      app,
      primary,
      primaryFailed,
      removeProfile: () => rm(userData, { recursive: true, force: true }),
    });
  }
  console.log(
    'Rich authoring acceptance passed: drafts, boundaries, rejection/retry, uncertain writes, hierarchy preview, partial creation, and handoffs.',
  );
}
