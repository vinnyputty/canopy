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
  let gate = 0;
  const activate = async (key) => {
    await page.clock.runFor(2000);
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
  await expect(page.getByRole('alert')).toHaveCount(0);
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
  await page.clock.runFor(61_000);
  expect(await calls()).toBe(undoCalls);
  await release('undo-write');
  await saved(key);
  await page.clock.runFor(1000);
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
  await hold('coalesced', 'tree', 'CAN-100');
  const coordinated = await counts();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await started('coalesced');
  await expect(checking).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(31_000);
  expect(await counts()).toEqual([coordinated[0] + 1, coordinated[1]]);
  await release('coalesced');
  await idle();
  await page.clock.runFor(31_000);
  await expect.poll(counts).toEqual([coordinated[0] + 2, coordinated[1] + 1]);
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
  console.log(
    'Adaptive refresh integration passed: preserved views, pending edits/undo, offline recovery, background cadence, and coalesced activation.',
  );
}
