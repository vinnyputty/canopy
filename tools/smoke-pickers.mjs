import { expect } from '@playwright/test';

export async function auditPickers(app, page) {
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const count = (operation) =>
    app.evaluate(
      (_electron, operation) =>
        globalThis.canopySmoke.calls.filter(
          (call) => call.operation === operation,
        ).length,
      operation,
    );
  const field = (name) =>
    page.getByRole('button', { name: `Edit ${name} for CAN-100`, exact: true });
  await expect(field('assignee')).toBeVisible();
  const mine = () =>
    page.getByRole('button', { name: 'Assign to me', exact: true });
  const cancel = () => page.getByLabel('Search assignees').press('Escape');
  await field('assignee').click();
  await expect(
    page.getByRole('button', { name: 'Assigned to me', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await expect(field('assignee')).toHaveText('—Unassigned');
  await field('assignee').click();
  await page.clock.install();
  await page.clock.pauseAt(
    new Date(await page.evaluate(() => Date.now() + 1000)),
  );
  await page.getByLabel('Search assignees').fill('Nobody matches');
  await expect(mine()).toBeVisible();
  await app.evaluate(() =>
    globalThis.canopySmoke.unassignableUsers.add('alex'),
  );
  const beforeSelf = await count('update');
  const beforeSearch = await count('assignees');
  await fixture('hold', 'self-validation', 'validateAssignee', 'CAN-100');
  await mine().click();
  await expect.poll(() => fixture('started', 'self-validation')).toBe(true);
  await page.clock.runFor(300);
  expect(await count('assignees')).toBe(beforeSearch);
  await fixture('release', 'self-validation');
  await expect(
    page.getByRole('alert').filter({ hasText: 'could not confirm' }),
  ).toBeVisible();
  expect(await count('update')).toBe(beforeSelf);
  await page.clock.runFor(300);
  await expect(
    page.getByRole('alert').filter({ hasText: 'could not confirm' }),
  ).toBeVisible();
  await page.clock.resume();
  await app.evaluate(() => globalThis.canopySmoke.unassignableUsers.clear());
  await cancel();
  await field('assignee').click();
  await fixture('hold', 'self-write', 'update', 'CAN-100');
  await mine().focus();
  await mine().press('Enter');
  await expect.poll(() => fixture('started', 'self-write')).toBe(true);
  await expect(page.getByLabel('Search assignees')).toBeHidden();
  await expect(field('assignee')).toContainText('Alex Morgan');
  await fixture('release', 'self-write');
  const undoSelf = page.getByRole('button', {
    name: 'Undo edit to CAN-100',
    exact: true,
  });
  await expect(undoSelf).toBeEnabled();
  await undoSelf.click();
  await expect(field('assignee')).toContainText('Unassigned');
  await field('assignee').click();
  await fixture('hold', 'self-reject', 'update', 'CAN-100');
  await mine().click();
  await expect.poll(() => fixture('started', 'self-reject')).toBe(true);
  await fixture('release', 'self-reject', 'Assignment permission denied');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Assignment permission denied' }),
  ).toBeVisible();
  await expect(page.getByLabel('Search assignees')).toBeVisible();
  await cancel();
  await expect(field('assignee')).toContainText('Unassigned');
  await page
    .getByRole('alert')
    .filter({ hasText: 'Assignment permission denied' })
    .getByRole('button')
    .click();
  // Restore the initial owner through the same validated action.
  await field('assignee').click();
  await mine().click();
  await expect(field('assignee')).toContainText('Alex Morgan');
  await expect(undoSelf).toBeEnabled();
  const searches = await count('assignees');
  await field('assignee').click();
  await expect(
    page.getByRole('button', { name: 'Alex Morgan', exact: true }),
  ).toBeVisible();
  expect(await count('assignees')).toBe(searches);
  await expect(
    page.getByText(/Search covers only Jira’s first 1,000 users/),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Load more people', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Load more people', exact: true }),
  ).toBeHidden();
  expect(await count('assignees')).toBe(searches + 1);
  // Returning to the last searched value before debounce completes must settle loading.
  await page.clock.pauseAt(
    new Date(await page.evaluate(() => Date.now() + 1000)),
  );
  const input = page.getByLabel('Search assignees');
  await input.fill('x');
  await input.fill('');
  await page.clock.runFor(300);
  await expect(page.locator('.assignee-popover .choice-loading')).toHaveCount(
    0,
  );
  expect(await count('assignees')).toBe(searches + 2);

  // Blank whitespace queries pass IPC validation and return unfiltered people.
  await input.fill('   ');
  await page.clock.runFor(300);
  await expect(page.locator('.assignee-popover .choice-loading')).toHaveCount(
    0,
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Alex Morgan', exact: true }),
  ).toBeVisible();
  expect(await count('assignees')).toBe(searches + 3);

  // Jira can match email while returning a display name without the query text.
  await app.evaluate(() =>
    globalThis.canopySmoke.assigneeSearchResults.set('alex@example.invalid', [
      { id: 'alex', name: 'Alex Morgan' },
    ]),
  );
  await input.fill('alex@example.invalid');
  await page.clock.runFor(300);
  await expect(
    page.getByRole('button', { name: 'Alex Morgan', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No people found in these results')).toBeHidden();
  await input.fill('alex@example.invalidx');
  await input.fill('alex@example.invalid');
  await page.clock.runFor(300);
  await expect(page.locator('.assignee-popover .choice-loading')).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Alex Morgan', exact: true }),
  ).toBeVisible();
  await input.fill('');
  await page.clock.runFor(300);
  await expect(page.locator('.assignee-popover .choice-loading')).toHaveCount(
    0,
  );
  await page.clock.resume();
  await app.evaluate(() =>
    globalThis.canopySmoke.unassignableUsers.add('alex'),
  );
  const writes = await count('update');
  await page.getByRole('button', { name: 'Alex Morgan', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'could not confirm' }),
  ).toBeVisible();
  await expect(page.getByLabel('Search assignees')).toBeVisible();
  expect(await count('update')).toBe(writes);
  await app.evaluate(() => globalThis.canopySmoke.unassignableUsers.clear());
  const armStatusTiming = () =>
    page.evaluate(() => {
      const field = document.querySelector(
        '[aria-label="Edit status for CAN-100"]',
      );
      const result = { loading: false, latencyMs: null };
      window.statusOpenMeasurement = result;
      field.addEventListener(
        'click',
        () => {
          const started = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector('.status-popover .choice-loading'))
              result.loading = true;
            if (document.querySelector('.status-popover [role="menuitem"]')) {
              result.latencyMs = performance.now() - started;
              observer.disconnect();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        },
        { once: true },
      );
    });
  const statusTiming = () =>
    page.evaluate(() => {
      const result = window.statusOpenMeasurement;
      delete window.statusOpenMeasurement;
      return result;
    });
  const statusCount = await count('transitions');
  await fixture('hold', 'picker-status', 'transitions', 'CAN-100');
  await armStatusTiming();
  await field('status').click();
  await expect.poll(() => fixture('started', 'picker-status')).toBe(true);
  await expect(page.locator('.status-popover .choice-loading')).toBeVisible();
  expect(await count('transitions')).toBe(statusCount + 1);
  await page.waitForTimeout(500);
  await fixture('release', 'picker-status');
  const transition = page.getByRole('menuitem', {
    name: 'To Do',
    exact: true,
  });
  await expect(transition).toBeVisible();
  const firstStatusOpen = await statusTiming();
  expect(firstStatusOpen.loading).toBe(true);
  expect(firstStatusOpen.latencyMs).toBeGreaterThanOrEqual(500);
  const beforeDismiss = await count('update');
  await transition.press('Escape');
  await expect(field('status')).toBeFocused();
  await expect(transition).toHaveCount(0);
  expect(await count('update')).toBe(beforeDismiss);
  await field('assignee').click();
  await expect(page.getByLabel('Search assignees')).toBeFocused();
  await field('priority').click();
  await expect(page.getByLabel('Choose value')).toBeFocused();
  await expect(page.getByLabel('Search assignees')).toHaveCount(0);
  await field('status').click();
  await expect(transition).toBeVisible();
  await page.locator('.view-settings > summary').click();
  await expect(transition).toHaveCount(0);
  expect(await count('update')).toBe(beforeDismiss);
  await page.locator('.view-settings > summary').press('Escape');
  await expect(page.locator('.view-settings > summary')).toBeFocused();
  await page.locator('.view-settings > summary').click();
  await field('status').click();
  await expect(page.locator('.view-settings')).not.toHaveAttribute('open');
  await expect(transition).toBeVisible();
  await transition.press('Escape');
  await fixture('hold', 'picker-priority', 'priorities', 'CAN-100');
  await field('priority').click();
  await expect.poll(() => fixture('started', 'picker-priority')).toBe(true);
  await fixture('release', 'picker-priority', 'Priority metadata unavailable');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Priority metadata unavailable' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Choose value' }),
  ).toBeVisible();
  await field('assignee').click();
  await fixture('hold', 'picker-users', 'assignees', 'CAN-100');
  await page.getByLabel('Search assignees').fill('Alex');
  await expect.poll(() => fixture('started', 'picker-users')).toBe(true);
  await fixture('release', 'picker-users', 'People lookup unavailable');
  await expect(
    page.getByRole('alert').filter({ hasText: 'People lookup unavailable' }),
  ).toBeVisible();
  await field('priority').click();
  await expect(
    page.getByRole('combobox', { name: 'Choose value' }),
  ).toBeVisible();
  await armStatusTiming();
  await field('status').click();
  await expect(
    page.getByRole('menuitem', { name: 'To Do', exact: true }),
  ).toBeVisible();
  const statusReopen = await statusTiming();
  expect(statusReopen.loading).toBe(false);
  expect(statusReopen.latencyMs).toBeLessThan(500);
  expect(await count('transitions')).toBe(statusCount + 1);
  await page.getByRole('menuitem', { name: 'To Do', exact: true }).click();
  await expect(field('status')).toContainText('To Do');
  await expect(page.getByLabel('Saving CAN-100')).toBeHidden();
  await fixture('hold', 'picker-status-after-change', 'transitions', 'CAN-100');
  await armStatusTiming();
  await field('status').click();
  await expect
    .poll(() => fixture('started', 'picker-status-after-change'))
    .toBe(true);
  await expect(page.locator('.status-popover .choice-loading')).toBeVisible();
  expect(await count('transitions')).toBe(statusCount + 2);
  await page.waitForTimeout(500);
  await fixture('release', 'picker-status-after-change');
  await expect(
    page.getByRole('menuitem', { name: 'In Progress', exact: true }),
  ).toBeVisible();
  const afterChangeStatusOpen = await statusTiming();
  expect(afterChangeStatusOpen.loading).toBe(true);
  expect(afterChangeStatusOpen.latencyMs).toBeGreaterThanOrEqual(500);
  console.log('Status picker open measurements:', {
    requestCounts: [1, 1, 2],
    firstMs: firstStatusOpen.latencyMs,
    repeatMs: statusReopen.latencyMs,
    afterChangeMs: afterChangeStatusOpen.latencyMs,
  });
  await page
    .getByRole('menuitem', { name: 'In Progress', exact: true })
    .click();
  await expect(field('status')).toContainText('In Progress');
  await expect(page.getByLabel('Saving CAN-100')).toBeHidden();
}

export async function auditSelfConnections(app, page) {
  const workspace = await page.evaluate(() => window.canopy.loadWorkspace());
  await app.evaluate(async ({ ipcMain }, workspace) => {
    const demo = globalThis.canopySmoke;
    const handlers = new Map();
    const replace = (name, handler) => {
      const channel = `canopy:${name}`;
      handlers.set(channel, ipcMain._invokeHandlers.get(channel));
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    globalThis.selfConnectionAudit = { handlers, writes: [], validations: [] };
    const tab = workspace.tabs[0];
    const otherTree = await demo.tree(tab.rootKey);
    replace('connections', () =>
      ['demo', 'other'].map((id) => ({
        id,
        name: id,
        url: 'https://example.invalid',
        provider: 'demo',
      })),
    );
    replace('loadWorkspace', () => ({
      ...workspace,
      activeTabId: 'first',
      tabs: [
        { ...tab, id: 'first', connectionId: 'demo' },
        { ...tab, id: 'second', connectionId: 'other' },
      ],
    }));
    replace('saveWorkspace', () => {});
    let replacements = 0;
    globalThis.selfConnectionAudit.identityResolvers = [];
    replace('connect', () => {
      replacements += 1;
      return ['demo', 'other'].map((id) => ({
        id,
        name: id,
        url: 'https://example.invalid',
        provider: 'demo',
      }));
    });
    replace('currentUser', (_event, connection) => {
      if (replacements && connection === 'demo')
        return new Promise((resolve) => {
          const account =
            replacements === 1
              ? { id: 'sam', name: 'Sam Rivera' }
              : { id: 'jordan', name: 'Jordan Lee' };
          globalThis.selfConnectionAudit.identityResolvers.push(() =>
            resolve(account),
          );
        });
      return connection === 'demo'
        ? { id: 'alex', name: 'Alex Morgan' }
        : { id: 'sam', name: 'Sam Rivera' };
    });
    replace('tree', (_event, connection, key) =>
      connection === 'other' ? otherTree : demo.tree(key),
    );
    replace('cachedUsers', () => []);
    replace('assignees', () => ({ users: [] }));
    replace('validateAssignee', (_event, connection, key, account, fresh) => {
      globalThis.selfConnectionAudit.validations.push({
        connection,
        account,
        fresh,
      });
      return demo.validateAssignee(key, account, fresh);
    });
    replace('update', (_event, connection, key, patch) => {
      globalThis.selfConnectionAudit.writes.push({ connection, patch });
      if (connection === 'demo') return demo.update(key, patch);
      const issue = otherTree.issues.find((issue) => issue.key === key);
      issue.assignee = { id: 'sam', name: 'Sam Rivera' };
      return issue;
    });
  }, workspace);
  try {
    await page.reload();
    const field = () =>
      page.getByRole('button', {
        name: 'Edit assignee for CAN-100',
        exact: true,
      });
    await field().click();
    await expect(
      page.getByRole('button', { name: 'Assigned to me', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Search assignees').press('Escape');
    await page.getByRole('tab').nth(1).click();
    await field().click();
    await expect(
      page.getByRole('button', { name: 'Assign to me', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Assign to me', exact: true })
      .click();
    await expect(field()).toContainText('Sam Rivera');
    await expect(
      page.getByLabel('Saving CAN-100', { exact: true }),
    ).toBeHidden();
    const recorded = await app.evaluate(() => ({
      writes: globalThis.selfConnectionAudit.writes,
      validations: globalThis.selfConnectionAudit.validations,
    }));
    expect(recorded.validations).toEqual([
      { connection: 'other', account: 'sam', fresh: true },
    ]);
    expect(recorded.writes).toEqual([
      { connection: 'other', patch: { assigneeId: 'sam' } },
    ]);
    await field().click();
    await expect(
      page.getByRole('button', { name: 'Assigned to me', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Search assignees').press('Escape');
    await page.getByRole('tab').nth(0).click();
    await field().click();
    await expect(
      page.getByRole('button', { name: 'Assigned to me', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Search assignees').press('Escape');
    const replaceAccount = async () => {
      await page
        .getByRole('button', { name: 'Connect Jira or GitHub', exact: true })
        .click();
      await page
        .getByPlaceholder('https://your-team.atlassian.net')
        .fill('https://example.invalid');
      await page
        .getByPlaceholder('you@company.com')
        .fill('test@example.invalid');
      await page.getByPlaceholder('Paste your token').fill('fixture-token');
      await page
        .getByRole('button', { name: 'Connect with token', exact: true })
        .click();
    };
    await replaceAccount();
    await expect
      .poll(() =>
        app.evaluate(
          () => globalThis.selfConnectionAudit.identityResolvers.length,
        ),
      )
      .toBe(1);
    await replaceAccount();
    await expect
      .poll(() =>
        app.evaluate(
          () => globalThis.selfConnectionAudit.identityResolvers.length,
        ),
      )
      .toBe(2);
    await field().click();
    await expect(
      page.getByRole('button', { name: 'Assign to me', exact: true }),
    ).toBeDisabled();
    await app.evaluate(() =>
      globalThis.selfConnectionAudit.identityResolvers[1](),
    );
    await expect(
      page.getByRole('button', { name: 'Assign to me', exact: true }),
    ).toBeEnabled();
    await app.evaluate(() =>
      globalThis.selfConnectionAudit.identityResolvers[0](),
    );
    await page
      .getByRole('button', { name: 'Assign to me', exact: true })
      .click();
    await expect(field()).toContainText('Jordan Lee');
    await expect(
      page.getByLabel('Saving CAN-100', { exact: true }),
    ).toBeHidden();
    expect(
      await app.evaluate(() => globalThis.selfConnectionAudit.writes.at(-1)),
    ).toEqual({ connection: 'demo', patch: { assigneeId: 'jordan' } });
  } finally {
    await app.evaluate(async ({ ipcMain }) => {
      await globalThis.canopySmoke.remoteUpdate('CAN-100', {
        assigneeId: 'alex',
      });
      for (const [channel, handler] of globalThis.selfConnectionAudit
        .handlers) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      }
      delete globalThis.selfConnectionAudit;
    });
    await page.evaluate(
      (saved) => window.canopy.saveWorkspace(saved),
      workspace,
    );
    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(workspace.tabs.length);
    await expect(
      page.getByRole('tree', { name: 'CAN-100 issue tree' }),
    ).toBeVisible();
  }
}
