import { expect } from '@playwright/test';

// Called only by the token-controlled Electron smoke harness, with disposable
// fixture data. Never reads real provider connections or uses the clipboard.
export async function auditSidebar(app, page, waitForSavedWorkspace) {
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const sidebar = page.getByRole('complementary', { name: 'Canopy sidebar' });
  const active = sidebar.getByRole('navigation', {
    name: 'Active tabs',
    exact: true,
  });
  const pinned = sidebar.getByRole('navigation', {
    name: 'Pinned roots',
    exact: true,
  });
  const parked = sidebar.getByRole('navigation', {
    name: 'Parked roots',
    exact: true,
  });
  const saved = sidebar.getByRole('navigation', {
    name: 'Saved views',
    exact: true,
  });
  await expect(active.locator('li')).toHaveCount(2);
  await expect(pinned.locator('li')).toHaveCount(2);
  await expect(
    saved.getByRole('button', { name: 'Saved view: Sidebar sample' }),
  ).toBeVisible();
  await waitForSavedWorkspace((workspace) =>
    workspace.tabs.every((tab) => Boolean(tab.summary)),
  );
  let baseline = await page.evaluate(() => window.canopy.loadWorkspace());
  expect(baseline.rootViews['["demo","CAN-100"]']).toMatchObject({
    columns: ['issue', 'status'],
    hideDone: false,
    sort: { column: 'key', direction: 'asc' },
  });
  const controls = sidebar.locator('.sidebar-work button:not(:disabled)');
  await controls.first().focus();
  for (let index = 0; index < (await controls.count()); index++) {
    await expect(controls.nth(index)).toBeFocused();
    if (index + 1 < (await controls.count())) await page.keyboard.press('Tab');
  }
  const retained = (workspace) => ({
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
    rootViews: workspace.rootViews,
    savedViews: workspace.savedViews,
  });
  // Force overflow in this fixture on every screen size; preserve actual scroll
  // and focused action while React moves keyed rows.
  await page.locator('.sidebar-body').evaluate((body) => {
    body.style.maxHeight = '180px';
  });
  const down = pinned.getByRole('button', {
    name: /^Move favorite down CAN-100/,
  });
  await down.focus();
  await page.locator('.sidebar-body').evaluate((body) => {
    body.scrollTop = 80;
  });
  const offset = await page
    .locator('.sidebar-body')
    .evaluate((body) => body.scrollTop);
  await page.keyboard.press('Enter');
  await expect(pinned.locator('li').first()).toContainText('CAN-200');
  await expect(
    pinned.getByRole('button', { name: /^Open CAN-100/ }),
  ).toBeFocused();
  expect(
    await page.locator('.sidebar-body').evaluate((body) => body.scrollTop),
  ).toBe(offset);
  await waitForSavedWorkspace(
    (workspace) => workspace.pinnedRoots?.[0].rootKey === 'CAN-200',
  );
  expect(
    retained(await page.evaluate(() => window.canopy.loadWorkspace())),
  ).toEqual(retained(baseline));
  // Change real live tree state after organizing, before Undo. The override is
  // intentionally customized, so retaining undefined/default state cannot pass.
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  const newerSelection = page.locator('[data-tree-key="CAN-111"]');
  await newerSelection
    .locator(':scope > .issue-row')
    .getByTitle('Double-click to edit')
    .click();
  const treeScroll = page.locator('.tree-scroll');
  await treeScroll.evaluate((element) => {
    element.style.maxHeight = '160px';
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  const newerScroll = await treeScroll.evaluate((element) => element.scrollTop);
  expect(newerScroll).toBeGreaterThan(0);
  await waitForSavedWorkspace(
    (workspace) =>
      workspace.tabs.find((tab) => tab.rootKey === 'CAN-100').selectedKey ===
        'CAN-111' &&
      workspace.tabs.find((tab) => tab.rootKey === 'CAN-100').scrollTop ===
        newerScroll,
  );
  const newer = await page.evaluate(() => window.canopy.loadWorkspace());
  expect(newer.rootViews).toEqual(baseline.rootViews);
  expect(
    newer.tabs.find((tab) => tab.rootKey === 'CAN-100').selectedKey,
  ).not.toBe(
    baseline.tabs.find((tab) => tab.rootKey === 'CAN-100').selectedKey,
  );
  baseline = newer;
  await sidebar.getByRole('button', { name: /^Undo move/ }).focus();
  await page.keyboard.press('Space');
  await expect(pinned.locator('li').first()).toContainText('CAN-100');
  await waitForSavedWorkspace(
    (workspace) => workspace.pinnedRoots?.[0].rootKey === 'CAN-100',
  );
  expect(
    retained(await page.evaluate(() => window.canopy.loadWorkspace())),
  ).toEqual(retained(baseline));
  await expect(newerSelection).toHaveAttribute('aria-selected', 'true');
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(
    newerScroll,
  );
  const unpin = pinned.getByRole('button', { name: /^Unpin CAN-100/ });
  await unpin.focus();
  await page.keyboard.press('Enter');
  await expect(pinned.locator('li')).toHaveCount(1);
  await expect(
    active.getByRole('button', { name: /^Open CAN-100/ }),
  ).toBeFocused();
  await sidebar.getByRole('button', { name: /^Undo unpin/ }).click();
  await expect(pinned.locator('li')).toHaveCount(2);
  const park = active.getByRole('button', {
    name: /^Park for this session CAN-100/,
  });
  await park.focus();
  await page.keyboard.press('Enter');
  await expect(active.locator('li')).toHaveCount(1);
  await expect(pinned.locator('li')).toHaveCount(1);
  await expect(
    parked.getByRole('button', { name: /^Open CAN-100/ }),
  ).toBeFocused();
  await expect(page.getByRole('tab', { name: /CAN-100/ })).toBeVisible();
  await expect(
    saved.getByRole('button', { name: 'Saved view: Sidebar sample' }),
  ).toBeVisible();
  const semantics = await sidebar.ariaSnapshot();
  expect(semantics).toContain('navigation "Parked roots"');
  expect(semantics).toContain('Restore to sidebar CAN-100');
  expect(semantics).toContain('Parking lasts until restart');
  await parked
    .getByRole('button', { name: /^Restore to sidebar CAN-100/ })
    .focus();
  await page.keyboard.press('Space');
  await expect(parked.locator('li')).toHaveCount(0);
  await expect(
    active.getByRole('button', { name: /^Open CAN-100/ }),
  ).toBeFocused();
  await sidebar.getByRole('button', { name: /^Undo restore/ }).click();
  await expect(parked.locator('li')).toHaveCount(1);
  await sidebar.getByRole('button', { name: /^Undo park/ }).click();
  await expect(parked.locator('li')).toHaveCount(0);
  const selectedRoot = active.getByRole('button', { name: /^Open CAN-100/ });
  const changedSummary = 'Sidebar completed refresh sample';
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await fixture('remoteUpdate', 'CAN-100', { summary: changedSummary });
  await fixture('hold', 'sidebar-refresh', 'tree', 'CAN-100');
  await selectedRoot.focus();
  const refreshOffset = await page
    .locator('.sidebar-body')
    .evaluate((body) => body.scrollTop);
  await page
    .getByRole('button', { name: 'Refresh', exact: true })
    .evaluate((button) => button.click());
  await expect.poll(() => fixture('started', 'sidebar-refresh')).toBe(true);
  await expect(page.getByText('Checking for changes')).toBeVisible();
  expect(await fixture('completed', 'sidebar-refresh')).toBe(false);
  await expect(selectedRoot.locator('small:not(.root-context)')).not.toHaveText(
    changedSummary,
  );
  await fixture('release', 'sidebar-refresh');
  await expect.poll(() => fixture('completed', 'sidebar-refresh')).toBe(true);
  await expect(selectedRoot.locator('small:not(.root-context)')).toHaveText(
    changedSummary,
  );
  await expect(
    page
      .locator('[data-tree-key="CAN-100"] > .issue-row')
      .getByTitle('Double-click to edit'),
  ).toHaveText(changedSummary);
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(selectedRoot).toBeFocused();
  expect(
    await page.locator('.sidebar-body').evaluate((body) => body.scrollTop),
  ).toBe(refreshOffset);
  await expect(newerSelection).toHaveAttribute('aria-selected', 'true');
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(
    newerScroll,
  );
  await expect(active.locator('li')).toHaveCount(2);
  await waitForSavedWorkspace(
    (workspace) =>
      workspace.tabs.find((tab) => tab.rootKey === 'CAN-100').summary ===
      changedSummary,
  );
  const refreshed = await page.evaluate(() => window.canopy.loadWorkspace());
  expect(
    retained({
      ...refreshed,
      tabs: refreshed.tabs.map((tab) =>
        tab.rootKey === 'CAN-100'
          ? {
              ...tab,
              summary: baseline.tabs.find((item) => item.rootKey === 'CAN-100')
                .summary,
            }
          : tab,
      ),
    }),
  ).toEqual(retained(baseline));
  // A renderer restart clears session parking while durable favorites survive.
  await active
    .getByRole('button', { name: /^Park for this session CAN-100/ })
    .click();
  await page.reload();
  await expect(parked.locator('li')).toHaveCount(0);
  await expect(pinned.locator('li').first()).toContainText('CAN-100');
}
