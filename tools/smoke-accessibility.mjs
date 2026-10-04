import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditSavedFeedback } from './smoke-saved-feedback.mjs';

// Barrier regressions from the issue #88 baseline. These are Chromium/Electron
// observations; native API and spoken screen-reader qualification is separate.
export async function auditAccessibility(app, page, evidence) {
  await mkdir(evidence, { recursive: true });
  // Install before constructing renderer controllers: RootRefreshGate captures
  // Date.now at construction. Keep its clock aligned with the actual scheduler.
  await page.clock.install();
  await page.reload();
  const capture = async (name) => {
    await page.screenshot({ path: join(evidence, `${name}.png`) });
    await writeFile(
      join(evidence, `${name}.aria.txt`),
      await page.locator('body').ariaSnapshot(),
    );
  };
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const afterRestoration = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  // Observe actual fixture completions without substituting responses or clocks.
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    const observations = { trees: [], updates: [], failures: [] };
    globalThis.canopyAccessibility = observations;
    const tree = demo.tree.bind(demo);
    demo.tree = async (key) => {
      const result = await tree(key);
      observations.trees.push(structuredClone(result));
      return result;
    };
    const update = demo.update.bind(demo);
    demo.update = async (key, patch) => {
      try {
        const result = await update(key, patch);
        observations.updates.push({
          key,
          patch,
          result: structuredClone(result),
        });
        return result;
      } catch (error) {
        observations.failures.push({ key, patch, error: String(error) });
        throw error;
      }
    };
  });
  const latestTree = (key) =>
    app.evaluate(
      (_electron, key) =>
        globalThis.canopyAccessibility.trees
          .filter((tree) => tree.rootKey === key)
          .at(-1),
      key,
    );
  const open = page
    .getByRole('button', { name: 'Open issue', exact: true })
    .first();
  await open.click();
  const picker = page.getByRole('dialog', { name: 'Open issue tree' });
  await picker.getByRole('combobox').fill('CAN-100');
  await picker.getByRole('button', { name: 'Open tree', exact: true }).click();
  await expect(page.getByRole('tree')).toBeVisible();

  const commands = page.getByRole('button', { name: 'More commands' });
  await commands.focus();
  await page.keyboard.press('Enter');
  await expect(
    page
      .getByRole('dialog', { name: 'Command palette' })
      .getByRole('combobox', { name: 'Search workspace' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(commands).toBeFocused();
  await open.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();

  await fixture('hold', 'a11y-initial', 'tree', 'CAN-200');
  await open.click();
  await picker.getByRole('combobox').fill('CAN-200');
  await picker.getByRole('button', { name: 'Open tree', exact: true }).click();
  await expect.poll(() => fixture('started', 'a11y-initial')).toBe(true);
  await expect(
    page.getByRole('status', { name: 'Loading issue tree' }),
  ).toBeVisible();
  await capture('initial-loading');
  await fixture('release', 'a11y-initial');
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /CAN-100/ }).click();

  const summary = page
    .locator('[data-tree-key="CAN-100"] > .issue-row')
    .getByTitle('Double-click to edit');
  await summary.press('Enter');
  await expect(
    page.getByLabel('Summary for CAN-100', { exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(summary).toBeFocused();
  await summary.press('Enter');
  const searchDestination = page.getByLabel('Find in tree', { exact: true });
  await searchDestination.click();
  await expect(
    page.getByLabel('Summary for CAN-100', { exact: true }),
  ).toHaveCount(0);
  await afterRestoration();
  await expect(searchDestination).toBeFocused();

  // A dialog action focuses the real search field before dismissing the dialog.
  await commands.click();
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByRole('button', { name: /Find in tree/ })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await afterRestoration();
  await expect(page.getByLabel('Find in tree', { exact: true })).toBeFocused();

  const savedSummary = 'Sample completed accessibility edit';
  await summary.press('Enter');
  await page
    .getByLabel('Summary for CAN-100', { exact: true })
    .fill(savedSummary);
  await fixture('hold', 'a11y-edit-success', 'update', 'CAN-100');
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture('started', 'a11y-edit-success')).toBe(true);
  await expect(summary).toHaveText(savedSummary);
  await expect(
    page.getByRole('status').filter({ hasText: /^Saving CAN-100$/ }),
  ).toHaveCount(1);
  expect(await fixture('completed', 'a11y-edit-success')).toBe(false);
  await fixture('release', 'a11y-edit-success');
  await expect.poll(() => fixture('completed', 'a11y-edit-success')).toBe(true);
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.canopyAccessibility.updates.some(
          ({ key, result }) =>
            key === 'CAN-100' &&
            result.summary === 'Sample completed accessibility edit',
        ),
      ),
    )
    .toBe(true);
  await expect(summary).toHaveText(savedSummary);
  await expect(page.locator('.undo-banner')).toContainText('Change saved');
  await expect(
    page
      .locator('.undo-banner')
      .getByRole('button', { name: 'Undo edit to CAN-100', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Saving CAN-100', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('status').filter({ hasText: /^Saving CAN-100$/ }),
  ).toHaveCount(0);
  await afterRestoration();
  await expect(summary).toBeFocused();
  await capture('summary-completed');

  await summary.press('Enter');
  await page
    .getByLabel('Summary for CAN-100', { exact: true })
    .fill('Sample rejected accessibility edit');
  await fixture('hold', 'a11y-edit-failure', 'update', 'CAN-100');
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture('started', 'a11y-edit-failure')).toBe(true);
  await expect(summary).toBeFocused();
  await fixture('release', 'a11y-edit-failure', 'Sample edit failure');
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Sample edit failure' });
  await expect(alert).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.canopyAccessibility.failures.some(
          ({ key, patch }) =>
            key === 'CAN-100' &&
            patch.summary === 'Sample rejected accessibility edit',
        ),
      ),
    )
    .toBe(true);
  await expect(summary).toHaveText(savedSummary);
  await expect(page.getByLabel('Saving CAN-100', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('status').filter({ hasText: /^Saving CAN-100$/ }),
  ).toHaveCount(0);
  await afterRestoration();
  await expect(summary).toBeFocused();
  await capture('summary-rolled-back');
  await alert.getByRole('button', { name: 'Dismiss error' }).click();

  // Focus the same CAN-101 subtree in two distinct tabs so its row/container
  // survives navigation. The real tab shortcut acts while its editor is focused.
  await open.click();
  await picker.getByRole('combobox').fill('CAN-101');
  await picker.getByRole('button', { name: 'Open tree', exact: true }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-101 issue tree' }),
  ).toBeVisible();
  const targetTabId = await page.getByRole('tree').getAttribute('data-tab-id');
  expect(targetTabId).not.toBeNull();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  const sharedSummary = page
    .locator('[data-tree-key="CAN-101"] > .issue-row')
    .getByTitle('Double-click to edit');
  await sharedSummary.click();
  await page.locator('.tree-view-menu > summary').click();
  await page
    .getByRole('button', { name: 'Focus selected subtree', exact: true })
    .click();
  await page.locator('.tree-view-menu > summary').press('Escape');
  await expect(
    page.getByRole('tree').locator(':scope > [data-tree-key="CAN-101"]'),
  ).toHaveCount(1);
  const sourceTabId = await page.getByRole('tree').getAttribute('data-tab-id');
  expect(sourceTabId).not.toBeNull();
  expect(sourceTabId).not.toBe(targetTabId);
  const survivingTitle = await sharedSummary.evaluateHandle(
    (e) => e.parentElement,
  );
  await sharedSummary.press('Enter');
  await expect(
    page.getByLabel('Summary for CAN-101', { exact: true }),
  ).toBeFocused();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+3' : 'Control+3',
  );
  await expect(page.getByRole('tree')).toHaveAttribute(
    'data-tab-id',
    targetTabId,
  );
  await expect(
    page.getByLabel('Summary for CAN-101', { exact: true }),
  ).toHaveCount(0);
  await afterRestoration();
  expect(
    await survivingTitle.evaluate(
      (e) =>
        e.isConnected &&
        e ===
          document.querySelector(
            '[data-tree-key="CAN-101"] > .issue-row .issue-title',
          ),
    ),
  ).toBe(true);
  await expect(sharedSummary).not.toBeFocused();
  await capture('summary-same-key-tab-transition');
  await survivingTitle.dispose();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await page.locator('.tree-view-menu > summary').click();
  await page.getByRole('button', { name: 'Back to root', exact: true }).click();
  await page.locator('.tree-view-menu > summary').press('Escape');

  const statusSelector = '#refresh-status';
  const live = page.locator(statusSelector);
  const liveNode = await live.elementHandle();
  expect(liveNode).not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const refreshEvidence = [];
  const checkLive = async (state, snapshot) => {
    expect(
      await liveNode.evaluate(
        (node) =>
          node.isConnected &&
          node === document.querySelector('#refresh-status'),
      ),
    ).toBe(true);
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: statusSelector,
    });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const ax = nodes.find((node) => node.role?.value === 'status');
    expect(ax).toBeDefined();
    const properties = Object.fromEntries(
      ax.properties.map((property) => [property.name, property.value.value]),
    );
    expect(properties.live).toBe('polite');
    expect(properties.atomic).toBe(true);
    refreshEvidence.push({
      state,
      snapshot,
      text: await live.textContent(),
      connection: (await page
        .getByRole('status', { name: 'Connection status' })
        .count())
        ? await page
            .getByRole('status', { name: 'Connection status' })
            .textContent()
        : null,
      nodeId,
      ax,
    });
    await writeFile(
      join(evidence, 'refresh-transitions.json'),
      JSON.stringify(refreshEvidence, null, 2),
    );
  };
  const completion = (snapshot) =>
    page.evaluate(
      (snapshot) =>
        `${snapshot.rootKey}: ${snapshot.issues.length} issues, last updated at ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`,
      snapshot,
    );
  const timestamp = page.locator('.statusbar').getByText(/Last updated/);
  // Establish user-request completion after the navigation scope changed.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.spin:visible')).toHaveCount(0);
  const before = await latestTree('CAN-100');
  expect(before).toBeDefined();
  const previousStatus = await completion(before);
  await expect(live).toHaveText(previousStatus);
  const previousTitle = await timestamp.getAttribute('title');
  expect(previousTitle).toBe(
    await page.evaluate(
      (time) => new Date(time).toLocaleString(),
      before.fetchedAt,
    ),
  );
  await checkLive('before', before);
  await fixture('hold', 'a11y-refresh', 'tree', 'CAN-100');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fixture('started', 'a11y-refresh')).toBe(true);
  await expect(live).toHaveText('Checking CAN-100 for changes');
  await checkLive('failure-pending', before);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const spinners = page.locator('.spin:visible');
  expect(await spinners.count()).toBeGreaterThan(0);
  expect(
    await spinners.evaluateAll((elements) =>
      elements.every((e) => getComputedStyle(e).animationName === 'none'),
    ),
  ).toBe(true);
  await capture('reduced-motion-loading');
  await fixture('release', 'a11y-refresh', 'Sample refresh failure');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Sample refresh failure' }),
  ).toBeVisible();
  await expect(
    page.getByText('Checking for changes', { exact: true }),
  ).toHaveCount(0);
  await expect(live).toHaveText(
    await page.evaluate(
      (snapshot) =>
        `Couldn’t refresh CAN-100: Sample refresh failure; ${snapshot.issues.length} issues retained, last updated at ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`,
      before,
    ),
  );
  await expect(
    page.getByRole('alert').filter({ hasText: 'Sample refresh failure' }),
  ).not.toContainText("Error invoking remote method 'canopy:tree'");
  await expect(timestamp).toHaveAttribute('title', previousTitle);
  expect((await latestTree('CAN-100')).fetchedAt).toBe(before.fetchedAt);
  await expect(
    page.getByRole('status', { name: 'Connection status' }),
  ).toHaveText('Connection error');
  await checkLive('failure-settled-retained', before);
  await capture('refresh-error');

  // Let real time cross a second boundary so visible timestamps also distinguish
  // retained data from the actual retry delivery. Do not fake the provider clock.
  await expect
    .poll(() => page.evaluate(() => Date.now()))
    .toBeGreaterThan(before.fetchedAt + 1000);
  await fixture('hold', 'a11y-retry', 'tree', 'CAN-100');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => fixture('started', 'a11y-retry')).toBe(true);
  await expect(live).toHaveText('Checking CAN-100 for changes');
  await expect(timestamp).toHaveAttribute('title', previousTitle);
  expect((await latestTree('CAN-100')).fetchedAt).toBe(before.fetchedAt);
  expect(await fixture('completed', 'a11y-retry')).toBe(false);
  await checkLive('retry-pending', before);
  await fixture('release', 'a11y-retry');
  await expect.poll(() => fixture('completed', 'a11y-retry')).toBe(true);
  await expect
    .poll(async () => (await latestTree('CAN-100')).fetchedAt)
    .toBeGreaterThan(before.fetchedAt);
  const delivered = await latestTree('CAN-100');
  await expect(live).toHaveText(await completion(delivered));
  await expect(timestamp).toHaveAttribute(
    'title',
    await page.evaluate(
      (time) => new Date(time).toLocaleString(),
      delivered.fetchedAt,
    ),
  );
  await expect(timestamp).not.toHaveAttribute('title', previousTitle);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('status', { name: 'Connection status' }),
  ).toHaveText('Connected');
  await checkLive('retry-completed-delivery', delivered);
  await capture('refresh-retry-completed');

  // Controlled scheduler time drives the actual App cadence/IPC, not a parallel
  // status implementation. The sample provider's completion clock stays real.
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await live.evaluate((node) => {
    globalThis.canopyLiveChanges = [];
    new MutationObserver(() =>
      globalThis.canopyLiveChanges.push(node.textContent),
    ).observe(node, { childList: true, subtree: true, characterData: true });
  });
  const changes = () => page.evaluate(() => globalThis.canopyLiveChanges);
  const resetChanges = () =>
    page.evaluate(() => {
      globalThis.canopyLiveChanges = [];
    });
  const automatic = async (id) => {
    await fixture('hold', id, 'tree', 'CAN-100');
    await page.clock.runFor(31_000);
    await expect.poll(() => fixture('started', id)).toBe(true);
    expect(await fixture('completed', id)).toBe(false);
    expect(await page.locator('.spin:visible').count()).toBeGreaterThan(0);
  };
  const quietText = await live.textContent();
  await expect
    .poll(() => app.evaluate(() => Date.now()))
    .toBeGreaterThan(delivered.fetchedAt);
  await automatic('a11y-automatic-unchanged');
  await expect(live).toHaveText(quietText);
  await checkLive('automatic-unchanged-held', delivered);
  await fixture('release', 'a11y-automatic-unchanged');
  await expect
    .poll(() => fixture('completed', 'a11y-automatic-unchanged'))
    .toBe(true);
  await expect(page.locator('.spin:visible')).toHaveCount(0);
  await expect(live).toHaveText(quietText);
  expect(await changes()).toEqual([]);
  const automaticDelivery = await latestTree('CAN-100');
  expect(automaticDelivery.fetchedAt).toBeGreaterThan(delivered.fetchedAt);
  const { fetchedAt: _oldTime, ...oldContent } = delivered;
  const { fetchedAt: _newTime, ...newContent } = automaticDelivery;
  expect(newContent).toEqual(oldContent);
  await expect(timestamp).toHaveAttribute(
    'title',
    await page.evaluate(
      (time) => new Date(time).toLocaleString(),
      automaticDelivery.fetchedAt,
    ),
  );
  await checkLive('automatic-unchanged-settled', automaticDelivery);

  // Actual fixture data changes, with unchanged issue count, deserve feedback.
  const originalSummary = automaticDelivery.issues.find(
    (issue) => issue.key === 'CAN-100',
  ).summary;
  await fixture('update', 'CAN-100', {
    summary: 'Sample automatic accessibility change',
  });
  await resetChanges();
  await automatic('a11y-automatic-new-data');
  await expect(live).toHaveText(quietText);
  await fixture('release', 'a11y-automatic-new-data');
  await expect
    .poll(() => fixture('completed', 'a11y-automatic-new-data'))
    .toBe(true);
  await expect(page.locator('.spin:visible')).toHaveCount(0);
  const newData = await latestTree('CAN-100');
  expect(newData.issues.find((issue) => issue.key === 'CAN-100').summary).toBe(
    'Sample automatic accessibility change',
  );
  await expect(live).toHaveText(`Changes found. ${await completion(newData)}`);
  expect((await changes()).length).toBeGreaterThan(0);
  await checkLive('automatic-new-data-settled', newData);

  // A cooldown recovery is forced by the scheduler, not requested by the user.
  await automatic('a11y-automatic-failure');
  const retryAt = await page.evaluate(() => Date.now() + 2000);
  await app.evaluate((_electron, retryAt) => {
    globalThis.canopySmoke.retryAt = retryAt;
  }, retryAt);
  await fixture(
    'release',
    'a11y-automatic-failure',
    'Sample automatic failure',
  );
  await expect(live).toContainText('Sample automatic failure');
  await expect(timestamp).toHaveAttribute(
    'title',
    await page.evaluate(
      (time) => new Date(time).toLocaleString(),
      newData.fetchedAt,
    ),
  );
  await checkLive('automatic-failure-retained', newData);
  const failureText = await live.textContent();
  await fixture('hold', 'a11y-forced-recovery', 'tree', 'CAN-100');
  await app.evaluate(() => {
    globalThis.canopySmoke.retryAt = null;
  });
  await resetChanges();
  await page.clock.runFor(3000);
  await expect
    .poll(() => fixture('started', 'a11y-forced-recovery'))
    .toBe(true);
  await expect(live).toHaveText(failureText);
  expect(await changes()).toEqual([]);
  await fixture('release', 'a11y-forced-recovery');
  await expect
    .poll(() => fixture('completed', 'a11y-forced-recovery'))
    .toBe(true);
  await expect(page.locator('.spin:visible')).toHaveCount(0);
  await expect(live).toHaveText(await completion(await latestTree('CAN-100')));
  await checkLive(
    'automatic-forced-recovery-completed',
    await latestTree('CAN-100'),
  );

  // A command Refresh during a held poll must retain user intent until the
  // deferred read starts; automatic completion cannot steal that feedback.
  await automatic('a11y-overlap-poll');
  await fixture('hold', 'a11y-overlap-manual', 'tree', 'CAN-100');
  await page.getByRole('button', { name: 'More commands' }).click();
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByRole('button', { name: /Refresh current tree/ })
    .click();
  expect(await fixture('started', 'a11y-overlap-manual')).toBe(false);
  await fixture('release', 'a11y-overlap-poll');
  await expect.poll(() => fixture('completed', 'a11y-overlap-poll')).toBe(true);
  await page.clock.runFor(2000);
  await expect.poll(() => fixture('started', 'a11y-overlap-manual')).toBe(true);
  await expect(live).toHaveText('Checking CAN-100 for changes');
  await checkLive('overlap-manual-held', await latestTree('CAN-100'));
  // Navigation removes the outgoing scope's progress; its late completion
  // must not change the current tab's status or reappear when returning.
  await page.getByRole('tab', { name: /CAN-200/ }).click();
  const destinationText = await live.textContent();
  await fixture('release', 'a11y-overlap-manual');
  await expect
    .poll(() => fixture('completed', 'a11y-overlap-manual'))
    .toBe(true);
  await expect(live).toHaveText(destinationText);
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await expect(live).not.toContainText('Checking CAN-100');
  await checkLive('navigation-late-completion', await latestTree('CAN-100'));
  await fixture('update', 'CAN-100', { summary: originalSummary });
  await auditSavedFeedback({
    app,
    page,
    fixture,
    live,
    checkLive,
    capture,
    latestTree,
  });
  await page.clock.resume();
  await cdp.detach();
  await liveNode.dispose();

  // Only the disposable fixture provider supplies this partial-result state.
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    const tree = demo.tree.bind(demo);
    demo.tree = async (key) => ({
      ...(await tree(key)),
      warnings: ['Sample partial result: linked issues unavailable.'],
    });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sample partial result:' }),
  ).toHaveCount(1);
  await capture('partial');

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const contrast = [];
  for (const palette of ['Default', 'Ocean', 'Forest']) {
    for (const theme of ['Light', 'Dark', 'System']) {
      for (const colorScheme of theme === 'System'
        ? ['light', 'dark']
        : ['light']) {
        await page.emulateMedia({ colorScheme });
        await settings.click();
        await page
          .getByLabel('Text size', { exact: true })
          .selectOption('large');
        await page
          .getByLabel('Row spacing', { exact: true })
          .selectOption('comfortable');
        await page
          .getByRole('button', { name: 'Appearance', exact: true })
          .click();
        const appearance = page.getByRole('dialog', { name: 'Appearance' });
        await appearance
          .getByRole('radio', { name: palette, exact: true })
          .check();
        await appearance
          .getByRole('radio', { name: theme, exact: true })
          .check();
        const effectiveMode =
          theme === 'System' ? colorScheme : theme.toLowerCase();
        const expectedBackgrounds = {
          Default: { light: 'rgb(248, 249, 251)', dark: 'rgb(23, 25, 29)' },
          Ocean: { light: 'rgb(242, 248, 249)', dark: 'rgb(16, 37, 46)' },
          Forest: { light: 'rgb(246, 248, 242)', dark: 'rgb(27, 38, 31)' },
        };
        await expect(page.locator('html')).toHaveAttribute(
          'data-palette',
          palette.toLowerCase(),
        );
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          theme.toLowerCase(),
        );
        await expect(page.locator('html')).toHaveCSS(
          'color-scheme',
          effectiveMode,
        );
        await expect(page.locator('.app')).toHaveCSS(
          'background-color',
          expectedBackgrounds[palette][effectiveMode],
        );
        const appliedStyle = await page.evaluate(() => ({
          palette: document.documentElement.dataset.palette,
          theme: document.documentElement.dataset.theme,
          systemScheme: matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light',
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          background: getComputedStyle(document.querySelector('.app'))
            .backgroundColor,
        }));
        expect(appliedStyle.systemScheme).toBe(colorScheme);
        const categories = [
          {
            category: 'selected-root-summary',
            state: 'selected',
            selector:
              '.sidebar-root .side-tab.active > span > small:not(.root-context)',
          },
          {
            category: 'selected-root-context',
            state: 'selected',
            selector: '.sidebar-root .side-tab.active .root-context',
          },
          {
            category: 'unselected-root-summary',
            state: 'unselected',
            selector:
              '.sidebar-root .side-tab:not(.active) > span > small:not(.root-context)',
          },
          {
            category: 'unselected-root-context',
            state: 'unselected',
            selector: '.sidebar-root .side-tab:not(.active) .root-context',
          },
          {
            category: 'connection-secondary',
            state: 'rest',
            selector: '.connection small',
          },
          {
            category: 'inactive-tab-summary',
            state: 'inactive',
            selector: '.top-tab:not(.active) .tab-label small',
          },
          {
            category: 'column-header',
            state: 'rest',
            selector: '.column-sort',
          },
          {
            category: 'sidebar-empty',
            state: 'rest',
            selector: '.sidebar-empty',
          },
          {
            category: 'footer-secondary',
            state: 'rest',
            selector: '.statusbar > span:not(.sr-only)',
          },
        ];
        const measure = (categories) =>
          page.evaluate((categories) => {
            // Inactive-tab color-mix backgrounds can serialize as color(srgb ...).
            // Let Chromium parse CSS colors into sRGB, rather than treating every
            // numeric serialization as 0-255 rgb() channels.
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', {
              colorSpace: 'srgb',
              willReadFrequently: true,
            });
            if (!context)
              throw new Error(
                'sRGB color measurement requires a canvas context',
              );
            const rgb = (color) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
              return [r, g, b, a / 255];
            };
            const blend = (a, b) =>
              a
                .slice(0, 3)
                .map((v, i) => v * (a[3] ?? 1) + b[i] * (1 - (a[3] ?? 1)));
            const luminance = (color) =>
              color
                .map((v) => v / 255)
                .map((v) =>
                  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                )
                .reduce(
                  (sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i],
                  0,
                );
            return categories.map(({ category, state, selector }) => ({
              category,
              state,
              selector,
              normalization: 'sRGB 8-bit browser canvas',
              measurements: [...document.querySelectorAll(selector)]
                .filter((e) => {
                  const b = e.getBoundingClientRect();
                  const style = getComputedStyle(e);
                  return (
                    b.width > 0 &&
                    b.height > 0 &&
                    style.visibility === 'visible' &&
                    style.display !== 'none' &&
                    e.textContent.trim()
                  );
                })
                .map((e) => {
                  const chain = [];
                  for (let p = e; p; p = p.parentElement) chain.unshift(p);
                  let background = [255, 255, 255];
                  for (const p of chain)
                    background = blend(
                      rgb(getComputedStyle(p).backgroundColor),
                      background,
                    );
                  const color = getComputedStyle(e).color;
                  const foreground = blend(rgb(color), background);
                  const values = [
                    luminance(foreground),
                    luminance(background),
                  ].sort((a, b) => a - b);
                  return {
                    text: e.textContent.trim(),
                    className: e.className,
                    color,
                    foreground,
                    compositedBackground: background,
                    elementBackground: getComputedStyle(e).backgroundColor,
                    hovered: e.matches(':hover'),
                    disabled: e.matches(':disabled'),
                    ratio: (values[1] + 0.05) / (values[0] + 0.05),
                  };
                }),
            }));
          }, categories);
        const primary = appearance.getByRole('button', {
          name: 'Save',
          exact: true,
        });
        await expect(primary).toBeEnabled();
        await appearance
          .getByRole('heading', { name: 'Appearance', exact: true })
          .hover();
        const rest = await measure([
          ...categories,
          {
            category: 'primary-button',
            state: 'rest',
            selector: '.dialog .primary',
          },
        ]);
        await primary.hover();
        const hover = await measure([
          {
            category: 'primary-button',
            state: 'hover',
            selector: '.dialog .primary',
          },
        ]);
        contrast.push({
          palette,
          theme,
          colorScheme,
          effectiveMode,
          appliedStyle,
          categories: [...rest, ...hover],
        });
        // Persist observations before assertions, including empty/missing classes.
        await writeFile(
          join(evidence, 'rendered-contrast.json'),
          JSON.stringify(contrast, null, 2),
        );
        for (const group of [...rest, ...hover]) {
          expect(
            group.measurements.length,
            `${palette}/${theme}/${colorScheme}: ${group.category}/${group.state} is required`,
          ).toBeGreaterThan(0);
          for (const result of group.measurements) {
            expect(result.text.length).toBeGreaterThan(0);
            if (group.category === 'primary-button') {
              expect(result.disabled).toBe(false);
              expect(result.hovered).toBe(group.state === 'hover');
            }
            expect(
              result.ratio,
              `${palette}/${theme}/${colorScheme}: ${group.category}/${group.state}: ${result.text}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        await capture(`${palette}-${theme}-${colorScheme}`);
        await page.keyboard.press('Escape');
        await expect(settings).toBeFocused();
      }
    }
  }
  expect(contrast).toHaveLength(12);
  await writeFile(
    join(evidence, 'rendered-contrast.json'),
    JSON.stringify(contrast, null, 2),
  );

  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(920, 600);
      window.webContents.setZoomFactor(2);
    });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    expect(await dialog.evaluate((e) => getComputedStyle(e).overflowY)).toBe(
      'auto',
    );
    const done = dialog.getByRole('button', { name: 'Done', exact: true });
    await done.focus();
    expect(
      await done.evaluate((e) => {
        const b = e.getBoundingClientRect();
        const panel = e.closest('[role="dialog"]').getBoundingClientRect();
        return b.top >= panel.top && b.bottom <= panel.bottom;
      }),
    ).toBe(true);
    await capture('zoom200-settings-done');
    await done.press('Enter');
    await expect(settings).toBeFocused();
    expect(
      await page
        .locator('.toolbar button')
        .evaluateAll((elements) =>
          elements
            .filter((e) => e.getBoundingClientRect().width)
            .every((e) => e.getBoundingClientRect().right <= innerWidth),
        ),
    ).toBe(true);
    await capture('zoom200-toolbar');
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setZoomFactor(1);
      window.setBounds(bounds);
    }, bounds);
    await page.emulateMedia({
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    });
  }
}
