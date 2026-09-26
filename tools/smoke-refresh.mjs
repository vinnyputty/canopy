import { expect } from '@playwright/test';

/** Uses the real optimistic mutation controller and demo IPC, with gated responses. */
export async function auditRefresh(app, page, resizeWindow) {
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const hold = (id, operation, key) => fixture('hold', id, operation, key);
  const started = (id) => expect.poll(() => fixture('started', id)).toBe(true);
  const release = (id, error) => fixture('release', id, error);
  const calls = (key) =>
    app.evaluate(
      (_electron, key) =>
        globalThis.canopySmoke.calls.filter(
          (call) => call.operation === 'tree' && (!key || call.key === key),
        ).length,
      key,
    );
  const status = page.getByRole('status', { name: 'Connection status' });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const checking = page.getByText('Checking for changes');
  const row = (key) => page.locator(`[data-tree-key="${key}"]`);
  const summary = (key) =>
    row(key).locator(':scope > .issue-row').getByTitle('Double-click to edit');
  const input = (key) => page.getByLabel(`Summary for ${key}`);
  const edit = async (key, value) => {
    await summary(key).press('Enter');
    await input(key).fill(value);
    await input(key).press('Enter');
  };
  const saved = (key) =>
    expect(page.getByLabel(`Saving ${key}`, { exact: true })).toHaveCount(0);
  const idle = async () => {
    await expect(checking).toBeHidden();
    await expect(page.locator('[role=tab] .spin')).toHaveCount(0);
  };
  const offline = (value) =>
    page.evaluate((offline) => {
      if (offline)
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: false,
        });
      else delete navigator.onLine;
      window.dispatchEvent(new Event(offline ? 'offline' : 'online'));
    }, value);

  await page.clock.install();
  await page.reload();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await idle();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const initial100 = await calls('CAN-100');
  const initial200 = await calls('CAN-200');
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  expect(await calls('CAN-100')).toBe(initial100);
  await expect(page.locator('.statusbar')).toContainText('Last updated');
  await page.getByRole('tab', { name: /CAN-200/ }).click();
  expect(await calls('CAN-200')).toBe(initial200);
  let gate = 0;
  const activate = async (key) => {
    await page.clock.runFor(31_000);
    const id = `activation-${++gate}`;
    await hold(id, 'tree', key);
    await page.getByRole('tab', { name: new RegExp(key) }).click();
    await started(id);
    await expect(checking).toBeVisible();
    await release(id);
    await idle();
  };

  // A cached tab switch must let subsequent user scrolling update its saved view.
  await resizeWindow(600);
  await activate('CAN-100');
  await page.getByRole('button', { name: 'Expand', exact: true }).dblclick();
  await page
    .getByRole('checkbox', { name: 'Hide done', exact: true })
    .uncheck();
  const linked = page.getByRole('tree').getByTitle('1 linked issue');
  if ((await linked.getAttribute('aria-expanded')) !== 'true')
    await linked.click();
  await summary('CAN-111').click();
  const scroll = page.locator('.tree-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.clock.runFor(500);
  const offset = await scroll.evaluate((element) => element.scrollTop);
  expect(offset).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      await page.clock.runFor(250);
      return page.evaluate(
        async () =>
          (await window.canopy.loadWorkspace()).tabs.find(
            (tab) => tab.rootKey === 'CAN-100',
          ).scrollTop,
      );
    })
    .toBe(offset);
  await hold('preserve-view', 'tree', 'CAN-100');
  await refresh.click();
  await started('preserve-view');
  await expect(checking).toBeVisible();
  await release('preserve-view');
  await idle();
  await expect(row('CAN-111')).toHaveAttribute('aria-selected', 'true');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(offset);
  await expect(linked).toHaveAttribute('aria-expanded', 'true');
  await expect(row('CAN-110')).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('checkbox', { name: 'Hide done', exact: true }),
  ).not.toBeChecked();

  await activate('CAN-200');
  const key = 'CAN-200';
  const baseline = await summary(key).innerText();
  const timestamp = page.locator('.statusbar').getByText(/Last updated/);
  const updatedBefore = await timestamp.getAttribute('title');
  await hold('refresh-error', 'tree', key);
  await refresh.click();
  await started('refresh-error');
  await expect(checking).toBeVisible();
  await release('refresh-error', 'Refresh audit connection failure');
  await expect(page.getByRole('alert')).toContainText(
    'Refresh audit connection failure',
  );
  await expect(summary(key)).toHaveText(baseline);
  await expect(timestamp).toHaveAttribute('title', updatedBefore);
  await expect(status).toHaveText('Connection error');
  await hold('refresh-retry', 'tree', key);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await started('refresh-retry');
  await expect(checking).toBeVisible();
  await release('refresh-retry');
  await idle();
  await expect
    .poll(() => page.getByRole('alert').allTextContents())
    .toEqual([]);
  await expect(status).toHaveText('Connected');

  // Connection cooldown retains the last tree and blocks manual/focus requests.
  const retryAt = await page.evaluate(() => Date.now() + 10_000);
  await app.evaluate((_electron, value) => {
    globalThis.canopySmoke.retryAt = value;
  }, retryAt);
  await hold('rate-limited-refresh', 'tree', key);
  await refresh.click();
  await started('rate-limited-refresh');
  await release('rate-limited-refresh', 'Jira rate limit reached.');
  await expect(status).toHaveText('Rate limited');
  await expect(page.getByRole('alert')).toContainText('Refresh resumes after');
  await expect(summary(key)).toHaveText(baseline);
  await expect(refresh).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeDisabled();
  const limitedCalls = await calls(key);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(5000);
  expect(await calls(key)).toBe(limitedCalls);
  await hold('rate-limit-recovery', 'tree', key);
  await app.evaluate(() => {
    globalThis.canopySmoke.retryAt = null;
  });
  await page.clock.runFor(6000);
  await started('rate-limit-recovery');
  await release('rate-limit-recovery');
  await idle();
  await expect(status).toHaveText('Connected');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Replacing credentials under the same ID clears the renderer's old deadline.
  const replacementDeadline = await page.evaluate(() => Date.now() + 60_000);
  await app.evaluate((_electron, value) => {
    globalThis.canopySmoke.retryAt = value;
  }, replacementDeadline);
  await hold('replacement-limit', 'tree', key);
  await refresh.click();
  await started('replacement-limit');
  await release('replacement-limit', 'Jira rate limit reached.');
  await expect(status).toHaveText('Rate limited');
  const connections = await page.evaluate(() => window.canopy.connections());
  await app.evaluate(({ ipcMain }, connections) => {
    ipcMain.removeHandler('canopy:connect');
    ipcMain.handle('canopy:connect', () => {
      globalThis.canopySmoke.retryAt = null;
      return connections;
    });
  }, connections);
  await page
    .getByRole('button', { name: 'Connect Jira or GitHub', exact: true })
    .click();
  await page.getByLabel('Jira site URL').fill('https://fixture.atlassian.net');
  await page.getByLabel('Atlassian email').fill('fixture@example.com');
  await page.getByPlaceholder('Paste your token').fill('fixture-only');
  await hold('replacement-recovery', 'tree', key);
  await page
    .getByRole('button', { name: 'Connect with token', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Connect Jira', exact: true }),
  ).toBeHidden();
  // Allow the scheduler's one-second request spacing and its next timer tick.
  await page.clock.runFor(2000);
  await started('replacement-recovery');
  await release('replacement-recovery');
  await idle();
  await expect(refresh).toBeEnabled();
  await expect(status).toHaveText('Connected');

  // Editing blocks focus, background, and reconnect refreshes on this connection.
  await summary(key).press('Enter');
  await input(key).fill('Draft across background and offline');
  const editingCalls = await calls();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.runFor(121_000);
  await offline(true);
  await page.clock.runFor(121_000);
  await expect(status).toHaveText('Offline');
  await offline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(1000);
  expect(await calls()).toBe(editingCalls);
  await expect(input(key)).toHaveValue('Draft across background and offline');
  await input(key).press('Escape');
  await page.clock.runFor(1000);
  await expect.poll(calls).toBeGreaterThan(editingCalls);
  await idle();

  // A response started before a draft must not unmount or replace that draft.
  await hold('inflight-draft', 'tree', key);
  await refresh.click();
  await started('inflight-draft');
  await expect(checking).toBeVisible();
  await summary(key).press('Enter');
  await input(key).fill('Draft above response');
  await release('inflight-draft');
  await idle();
  await expect(input(key)).toHaveValue('Draft above response');
  await input(key).press('Escape');
  await page.clock.runFor(1000);
  await idle();

  // The optimistic edit closes its editor immediately, but the whole connection stays deferred.
  await hold('optimistic-write', 'update', key);
  await edit(key, 'Optimistic refresh integration');
  await started('optimistic-write');
  await expect(input(key)).toHaveCount(0);
  await expect(summary(key)).toHaveText('Optimistic refresh integration');
  await expect(page.getByLabel(`Saving ${key}`, { exact: true })).toBeVisible();
  const writingCalls = await calls();
  await refresh.click();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.runFor(121_000);
  await offline(true);
  await page.clock.runFor(121_000);
  await offline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(1000);
  expect(await calls()).toBe(writingCalls);
  await page.getByRole('tab', { name: /CAN-200/ }).click();
  await release('optimistic-write');
  await saved(key);
  await page.clock.runFor(1000);
  await expect.poll(calls).toBeGreaterThan(writingCalls);
  await idle();
  await expect(summary(key)).toHaveText('Optimistic refresh integration');

  // Undo validation is a read; its inverse write must use the same pending guard and drain.
  await hold('undo-write', 'update', key);
  await page
    .getByRole('button', { name: `Undo edit to ${key}`, exact: true })
    .click();
  await started('undo-write');
  await expect(summary(key)).toHaveText(baseline);
  const undoCalls = await calls();
  await refresh.click();
  await page.clock.runFor(1000);
  expect(await calls()).toBe(undoCalls);
  await hold('undo-forced-tree', 'tree', key);
  await release('undo-write');
  await saved(key);
  await page.clock.runFor(1000);
  await started('undo-forced-tree');
  await release('undo-forced-tree');
  await expect.poll(calls).toBeGreaterThan(undoCalls);
  await idle();
  await expect(summary(key)).toHaveText(baseline);
  await expect(
    page.getByRole('button', { name: `Undo edit to ${key}`, exact: true }),
  ).toHaveCount(0);

  // Explicit gates settle activation before virtual time advances across network requests.
  await activate('CAN-100');
  await activate('CAN-200');
  const counts = async () => [await calls('CAN-100'), await calls('CAN-200')];
  const cadence = await counts();
  for (let step = 1; step <= 6; step += 1) {
    const id = `cadence-${step}`;
    await hold(id, 'tree', 'CAN-200');
    await page.clock.runFor(31_000);
    await started(id);
    await expect(checking).toBeVisible();
    await release(id);
    await idle();
    await expect
      .poll(counts)
      .toEqual([
        cadence[0] + (step === 1 ? 0 : step === 6 ? 2 : 1),
        cadence[1] + step,
      ]);
  }

  await page.clock.runFor(2000);
  const coordinated = await counts();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  expect(await counts()).toEqual(coordinated);
  await hold('coalesced', 'tree', 'CAN-100');
  await page.clock.runFor(31_000);
  await started('coalesced');
  await expect(checking).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(31_000);
  expect(await calls('CAN-100')).toBe(coordinated[0] + 1);
  await release('coalesced');
  await idle();
  await page.clock.runFor(31_000);
  await expect.poll(() => calls('CAN-100')).toBe(coordinated[0] + 2);
  await idle();

  await offline(true);
  const disconnected = await counts();
  await page.clock.runFor(241_000);
  expect(await counts()).toEqual(disconnected);
  await expect(status).toHaveText('Offline');
  await offline(false);
  await page.clock.runFor(1000);
  await expect.poll(() => calls('CAN-100')).toBeGreaterThan(disconnected[0]);
  await idle();
  await expect(status).toHaveText('Connected');
  await page.clock.resume();

  // Restored duplicate tabs share their first request and receive manual updates.
  const beforeDuplicate = await calls('CAN-100');
  await hold('duplicate-initial', 'tree', 'CAN-100');
  await page.evaluate(async () => {
    const workspace = await window.canopy.loadWorkspace();
    const first = workspace.tabs.find((tab) => tab.rootKey === 'CAN-100');
    await window.canopy.saveWorkspace({
      ...workspace,
      tabs: [first, { ...first, id: 'refresh-duplicate-CAN-100' }],
      activeTabId: first.id,
    });
  });
  await page.reload();
  await started('duplicate-initial');
  expect(await calls('CAN-100')).toBe(beforeDuplicate + 1);
  await release('duplicate-initial');
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  await idle();
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('.statusbar')).toContainText('Last updated');
  expect(await calls('CAN-100')).toBe(beforeDuplicate + 1);
  await hold('duplicate-error', 'tree', 'CAN-100');
  await refresh.click();
  await started('duplicate-error');
  await release('duplicate-error', 'Duplicate refresh failure');
  await expect(page.getByRole('alert')).toContainText(
    'Duplicate refresh failure',
  );
  await expect(status).toHaveText('Connection error');
  await page.getByRole('tab').nth(0).click();
  await page.waitForTimeout(1100);
  await hold('duplicate-manual', 'tree', 'CAN-100');
  await refresh.click();
  await started('duplicate-manual');
  await release('duplicate-manual');
  await idle();
  const updated = await page
    .locator('.statusbar [title]')
    .first()
    .getAttribute('title');
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('.statusbar [title]').first()).toHaveAttribute(
    'title',
    updated,
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(status).toHaveText('Connected');
  expect(await calls('CAN-100')).toBe(beforeDuplicate + 3);

  console.log(
    'Adaptive refresh integration passed: preserved views, pending edits/undo, offline recovery, background cadence, and coalesced activation.',
  );
}
