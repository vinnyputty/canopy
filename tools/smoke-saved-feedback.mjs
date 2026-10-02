import { expect } from '@playwright/test';

// Prepared sample-provider interactions, run only with fresh review + GUI token.
export async function auditSavedFeedback({
  app,
  page,
  fixture,
  live,
  checkLive,
  capture,
  latestTree,
}) {
  const treeTab = () => page.getByRole('tab', { name: /CAN-100/ }).click();
  const select = (name) =>
    page
      .getByRole('button', { name: `Saved view: ${name}`, exact: true })
      .click();
  const region = (name) =>
    page.getByRole('region', { name: `${name} saved view`, exact: true });
  const refresh = (name) =>
    region(name).getByRole('button', { name: 'Refresh', exact: true }).click();
  const started = (id) => expect.poll(() => fixture('started', id)).toBe(true);
  const completed = (id) =>
    expect.poll(() => fixture('completed', id)).toBe(true);
  const create = async (name, keys) => {
    await page
      .getByRole('button', { name: 'Create saved view', exact: true })
      .click();
    const panel = region('New view');
    await panel.locator('.saved-view-settings > summary').click();
    await panel.getByLabel('View name', { exact: true }).fill(name);
    await panel.getByRole('heading').click(); // Commit the actual blur edit.
    for (const key of keys)
      await region(name)
        .getByRole('checkbox', { name: new RegExp(`^${key}(?:\\s|$)`) })
        .check();
    await region(name).locator('.saved-view-settings > summary').click();
  };
  await create('Accessibility A', ['CAN-100', 'CAN-200']);
  await create('Accessibility B', ['CAN-100']);

  // Actual retained activeTabId transitions: completed, still held and failed.
  for (const phase of ['completed', 'pending', 'failed']) {
    await treeTab();
    const id = `a11y-tree-view-tree-${phase}`;
    await fixture('hold', id, 'tree', 'CAN-100');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await started(id);
    await expect(live).toHaveText('Checking CAN-100 for changes');
    await select('Accessibility A');
    await expect(live).not.toContainText('Checking CAN-100');
    if (phase !== 'pending') {
      await fixture(
        'release',
        id,
        phase === 'failed' ? 'Late outgoing tree failure' : undefined,
      );
      if (phase === 'failed')
        await expect(
          region('Accessibility A').getByRole('alert'),
        ).toContainText('Late outgoing tree failure');
      else await completed(id);
    }
    await treeTab();
    await expect(live).not.toContainText('Checking CAN-100');
    await expect(live).not.toContainText('last updated');
    await expect(live).not.toContainText('Late outgoing tree failure');
    if (phase === 'pending') {
      await fixture('release', id);
      await completed(id);
      await expect(live).toHaveText('');
    }
    await checkLive(`tree-view-tree-${phase}`, await latestTree('CAN-100'));
    await capture(`tree-view-tree-${phase}`);
    // Clear any actual retained provider error via an actual user refresh.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.spin:visible')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }

  // Keep CAN-200 configured while removing its tree tab: a real virtual source.
  await page
    .getByRole('button', { name: 'Close CAN-200', exact: true })
    .click();
  await select('Accessibility A');
  await expect(
    region('Accessibility A')
      .locator('.saved-view-choice')
      .filter({ hasText: 'CAN-200' })
      .first(),
  ).toBeVisible();
  await fixture('hold', 'a11y-view-success-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-success-200', 'tree', 'CAN-200');
  await refresh('Accessibility A');
  await page.clock.runFor(2000);
  await started('a11y-view-success-100');
  await started('a11y-view-success-200');
  await expect(live).toHaveText(
    'Refreshing Accessibility A: 2 of 2 roots pending.',
  );
  await expect(region('Accessibility A')).toHaveAttribute(
    'aria-describedby',
    'refresh-status',
  );
  await checkLive('saved-view-held-shared-and-virtual', null);
  await fixture('release', 'a11y-view-success-100');
  await completed('a11y-view-success-100');
  await expect(live).toHaveText(
    'Refreshing Accessibility A: 1 of 2 roots pending.',
  );
  expect(await fixture('completed', 'a11y-view-success-200')).toBe(false);
  await fixture('release', 'a11y-view-success-200');
  await completed('a11y-view-success-200');
  await expect(live).toHaveText('Accessibility A: refreshed 2 of 2 roots.');
  await checkLive('saved-view-success', [
    await latestTree('CAN-100'),
    await latestTree('CAN-200'),
  ]);
  await capture('saved-view-success');

  // Real partial sample response plus a retained-data failure in another root.
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    const tree = demo.tree.bind(demo);
    globalThis.canopySavedFeedbackTree = tree;
    demo.tree = async (key) => {
      const result = await tree(key);
      const next =
        key === 'CAN-200'
          ? { ...result, warnings: ['Sample saved-view partial result'] }
          : result;
      globalThis.canopyAccessibility.trees.push(structuredClone(next));
      return next;
    };
  });
  const retained100 = await latestTree('CAN-100');
  await fixture('hold', 'a11y-view-partial-200', 'tree', 'CAN-200');
  await fixture('hold', 'a11y-view-failed-100', 'tree', 'CAN-100');
  await refresh('Accessibility A');
  await page.clock.runFor(2000);
  await started('a11y-view-partial-200');
  await started('a11y-view-failed-100');
  await fixture('release', 'a11y-view-partial-200');
  await completed('a11y-view-partial-200');
  await expect(live).toContainText('1 of 2 roots pending');
  await expect(live).toContainText('Sample saved-view partial result');
  await fixture('release', 'a11y-view-failed-100', 'Sample saved-view failure');
  await expect(live).toContainText('refreshed 1 of 2 roots');
  await expect(live).toContainText('1 roots failed');
  await expect(live).toContainText('Sample saved-view failure');
  await expect(live).toContainText('issues retained, last updated at');
  await expect(live).toContainText('1 roots returned partial results');
  expect((await latestTree('CAN-100')).fetchedAt).toBe(retained100.fetchedAt);
  await checkLive('saved-view-partial-and-retained-failure', [
    retained100,
    await latestTree('CAN-200'),
  ]);
  await capture('saved-view-partial-and-retained-failure');
  await app.evaluate(() => {
    globalThis.canopySmoke.tree = globalThis.canopySavedFeedbackTree;
  });

  // A new visible view owns its deferred request behind the old shared read.
  await fixture('hold', 'a11y-view-A-shared', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-A-virtual', 'tree', 'CAN-200');
  await refresh('Accessibility A');
  await page.clock.runFor(2000);
  await started('a11y-view-A-shared');
  await started('a11y-view-A-virtual');
  await select('Accessibility B');
  await fixture('hold', 'a11y-view-B-shared', 'tree', 'CAN-100');
  await refresh('Accessibility B');
  await expect(live).toHaveText(
    'Waiting to refresh Accessibility B: 1 of 1 roots pending; 1 waiting to start.',
  );
  await fixture('release', 'a11y-view-A-virtual', 'Late unrelated A failure');
  await expect(live).not.toContainText('Late unrelated A failure');
  await fixture('release', 'a11y-view-A-shared');
  await completed('a11y-view-A-shared');
  await page.clock.runFor(2000);
  await started('a11y-view-B-shared');
  await expect(live).toHaveText(
    'Refreshing Accessibility B: 1 of 1 roots pending.',
  );
  await fixture('release', 'a11y-view-B-shared');
  await completed('a11y-view-B-shared');
  await expect(live).toHaveText('Accessibility B: refreshed 1 of 1 roots.');
  await select('Accessibility A');
  await expect(live).not.toContainText('Accessibility B');
  await expect(live).not.toContainText('Late unrelated A failure');
  await checkLive('saved-view-A-B-A-shared-request', null);

  // Offline user intent is pending, not falsely reported as provider progress.
  const offline = (value) =>
    page.evaluate((value) => {
      if (value)
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: false,
        });
      else delete navigator.onLine;
      window.dispatchEvent(new Event(value ? 'offline' : 'online'));
    }, value);
  await fixture('hold', 'a11y-view-offline-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-offline-200', 'tree', 'CAN-200');
  await offline(true);
  await refresh('Accessibility A');
  await expect(live).toHaveText(
    'Waiting to refresh Accessibility A: 2 of 2 roots pending; 2 waiting to start.',
  );
  expect(await fixture('started', 'a11y-view-offline-100')).toBe(false);
  expect(await fixture('started', 'a11y-view-offline-200')).toBe(false);
  await offline(false);
  await page.clock.runFor(2000);
  await started('a11y-view-offline-100');
  await started('a11y-view-offline-200');
  await fixture('release', 'a11y-view-offline-100');
  await fixture('release', 'a11y-view-offline-200');
  await completed('a11y-view-offline-100');
  await completed('a11y-view-offline-200');
  await expect(live).toHaveText('Accessibility A: refreshed 2 of 2 roots.');
  await checkLive('saved-view-offline-deferred-completion', null);

  // Refresh's global shortcut is reachable without blurring the actual picker.
  // The editor gate queues tree intent; navigation deliberately cancels the
  // picker and invalidates that outgoing intent before its read resumes.
  await treeTab();
  await page
    .getByRole('button', { name: 'Edit priority for CAN-100', exact: true })
    .click();
  const picker = page.getByLabel('Choose value');
  await expect(picker).toBeFocused();
  await fixture('hold', 'a11y-editor-deferred', 'tree', 'CAN-100');
  const refreshShortcut = await page.evaluate(() =>
    /mac/i.test(navigator.platform) ? 'Meta+r' : 'Control+r',
  );
  await picker.press(refreshShortcut);
  await expect(picker).toBeFocused();
  await page.clock.runFor(2000);
  expect(await fixture('started', 'a11y-editor-deferred')).toBe(false);
  await expect(live).not.toContainText('Checking CAN-100');
  await picker.press('Escape');
  await expect(picker).toHaveCount(0);
  await page.clock.runFor(2000);
  await started('a11y-editor-deferred');
  await expect(live).toHaveText('Checking CAN-100 for changes');
  await fixture('release', 'a11y-editor-deferred');
  await completed('a11y-editor-deferred');
  await expect(live).toContainText('CAN-100:');
  await checkLive(
    'editor-shortcut-deferred-cancel-completion',
    await latestTree('CAN-100'),
  );

  await page
    .getByRole('button', { name: 'Edit priority for CAN-100', exact: true })
    .click();
  await expect(picker).toBeFocused();
  await fixture('hold', 'a11y-editor-navigation', 'tree', 'CAN-100');
  await picker.press(refreshShortcut);
  await expect(picker).toBeFocused();
  expect(await fixture('started', 'a11y-editor-navigation')).toBe(false);
  const viewButton = page.getByRole('button', {
    name: 'Saved view: Accessibility A',
    exact: true,
  });
  await viewButton.focus(); // Actual onBlur cancels the picker.
  await expect(picker).toHaveCount(0);
  await viewButton.press('Enter');
  await page.clock.runFor(2000);
  await started('a11y-editor-navigation');
  await expect(live).not.toContainText('Checking CAN-100');
  await fixture('release', 'a11y-editor-navigation');
  await completed('a11y-editor-navigation');
  await expect(live).not.toContainText('Checking CAN-100');
  await treeTab();
  await expect(live).toHaveText('');
  await checkLive(
    'editor-navigation-cancels-outgoing-intent',
    await latestTree('CAN-100'),
  );

  // A real pending summary write blocks the connection's requested view reads.
  await treeTab();
  const summary = page
    .locator('[data-tree-key="CAN-100"] > .issue-row')
    .getByTitle('Double-click to edit');
  const original = await summary.textContent();
  await summary.press('Enter');
  await page
    .getByLabel('Summary for CAN-100')
    .fill('Sample pending saved-view edit');
  await fixture('hold', 'a11y-view-pending-edit', 'update', 'CAN-100');
  await page.getByLabel('Summary for CAN-100').press('Enter');
  await started('a11y-view-pending-edit');
  await select('Accessibility A');
  await fixture('hold', 'a11y-view-after-edit-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-after-edit-200', 'tree', 'CAN-200');
  await refresh('Accessibility A');
  await expect(live).toContainText('2 waiting to start');
  expect(await fixture('started', 'a11y-view-after-edit-100')).toBe(false);
  await fixture('release', 'a11y-view-pending-edit');
  await completed('a11y-view-pending-edit');
  await page.clock.runFor(2000);
  await started('a11y-view-after-edit-100');
  await started('a11y-view-after-edit-200');
  await fixture('release', 'a11y-view-after-edit-100');
  await fixture('release', 'a11y-view-after-edit-200');
  await completed('a11y-view-after-edit-100');
  await completed('a11y-view-after-edit-200');
  await expect(live).toHaveText('Accessibility A: refreshed 2 of 2 roots.');
  await checkLive('saved-view-pending-edit-deferred-completion', null);
  await fixture('update', 'CAN-100', { summary: original });

  // Timestamp-only view polls stay silent through all visible root deliveries.
  await fixture('hold', 'a11y-view-poll-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-poll-200', 'tree', 'CAN-200');
  // First consume the intentional fixture restoration as a user refresh.
  await refresh('Accessibility A');
  await page.clock.runFor(2000);
  await started('a11y-view-poll-100');
  await started('a11y-view-poll-200');
  await fixture('release', 'a11y-view-poll-100');
  await fixture('release', 'a11y-view-poll-200');
  await completed('a11y-view-poll-100');
  await completed('a11y-view-poll-200');
  await expect(live).toHaveText('Accessibility A: refreshed 2 of 2 roots.');
  const quiet = await live.textContent();
  await live.evaluate((node) => {
    globalThis.canopySavedViewChanges = [];
    new MutationObserver(() =>
      globalThis.canopySavedViewChanges.push(node.textContent),
    ).observe(node, { childList: true, subtree: true, characterData: true });
  });
  await fixture('hold', 'a11y-view-quiet-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-quiet-200', 'tree', 'CAN-200');
  await page.clock.runFor(31_000);
  await started('a11y-view-quiet-100');
  await started('a11y-view-quiet-200');
  await expect(live).toHaveText(quiet);
  await fixture('release', 'a11y-view-quiet-100');
  await fixture('release', 'a11y-view-quiet-200');
  await completed('a11y-view-quiet-100');
  await completed('a11y-view-quiet-200');
  await expect(live).toHaveText(quiet);
  expect(await page.evaluate(() => globalThis.canopySavedViewChanges)).toEqual(
    [],
  );
  await checkLive('saved-view-unchanged-poll', [
    await latestTree('CAN-100'),
    await latestTree('CAN-200'),
  ]);
  // Actual same-count data change + another root's automatic failure must
  // aggregate only after the held visible-root group settles, then recover.
  const automaticSummary = (await latestTree('CAN-100')).issues.find(
    (issue) => issue.key === 'CAN-100',
  ).summary;
  const retained200 = await latestTree('CAN-200');
  await fixture('update', 'CAN-100', {
    summary: 'Sample automatic saved-view change',
  });
  await fixture('hold', 'a11y-view-auto-change-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-auto-fail-200', 'tree', 'CAN-200');
  await page.clock.runFor(31_000);
  await started('a11y-view-auto-change-100');
  await started('a11y-view-auto-fail-200');
  await expect(live).toHaveText(quiet);
  await fixture('release', 'a11y-view-auto-change-100');
  await completed('a11y-view-auto-change-100');
  await expect(live).toHaveText(quiet); // The other selected root is held.
  await fixture(
    'release',
    'a11y-view-auto-fail-200',
    'Sample automatic saved-view failure',
  );
  await expect(live).toContainText(
    'Accessibility A: Changes found across 2 roots.',
  );
  await expect(live).toContainText('Sample automatic saved-view failure');
  expect((await latestTree('CAN-200')).fetchedAt).toBe(retained200.fetchedAt);
  await checkLive('saved-view-automatic-change-and-failure', [
    await latestTree('CAN-100'),
    retained200,
  ]);
  const failed = await live.textContent();
  await fixture('hold', 'a11y-view-auto-recovery-100', 'tree', 'CAN-100');
  await fixture('hold', 'a11y-view-auto-recovery-200', 'tree', 'CAN-200');
  await page.clock.runFor(31_000);
  await started('a11y-view-auto-recovery-100');
  await started('a11y-view-auto-recovery-200');
  await expect(live).toHaveText(failed);
  await fixture('release', 'a11y-view-auto-recovery-100');
  await completed('a11y-view-auto-recovery-100');
  await expect(live).toHaveText(failed);
  await fixture('release', 'a11y-view-auto-recovery-200');
  await completed('a11y-view-auto-recovery-200');
  await expect(live).toContainText(
    /Accessibility A: (Refresh recovered|Changes found) across/,
  );
  await expect(live).not.toContainText('Sample automatic saved-view failure');
  await checkLive('saved-view-automatic-recovery', [
    await latestTree('CAN-100'),
    await latestTree('CAN-200'),
  ]);
  // Two different same-count deliveries must each commit status text, without
  // an intervening manual refresh/failure/navigation resetting the message.
  for (const [index, summary] of [
    'Sample first consecutive automatic change',
    'Sample second consecutive automatic change',
  ].entries()) {
    const beforeText = await live.textContent();
    const beforeMutations = await page.evaluate(
      () => globalThis.canopySavedViewChanges.length,
    );
    await fixture('update', 'CAN-100', { summary });
    const id = `a11y-view-consecutive-${index}`;
    await fixture('hold', id, 'tree', 'CAN-100');
    await page.clock.runFor(31_000);
    await started(id);
    await fixture('release', id);
    await completed(id);
    await expect(
      region('Accessibility A').getByText(summary, { exact: true }),
    ).toBeVisible();
    await expect(live).toContainText(
      'Changes found across 1 roots. Last updated at',
    );
    await expect(live).not.toHaveText(beforeText);
    await expect
      .poll(() => page.evaluate(() => globalThis.canopySavedViewChanges.length))
      .toBeGreaterThan(beforeMutations);
    await checkLive(
      `saved-view-consecutive-automatic-${index}`,
      await latestTree('CAN-100'),
    );
  }
  await fixture('update', 'CAN-100', { summary: automaticSummary });
  await refresh('Accessibility A');
  await expect(live).toHaveText('Accessibility A: refreshed 2 of 2 roots.');
  await treeTab();
}
