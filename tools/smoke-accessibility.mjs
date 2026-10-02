import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Barrier regressions from the issue #88 baseline. These are Chromium/Electron
// observations; native API and spoken screen-reader qualification is separate.
export async function auditAccessibility(app, page, evidence) {
  await mkdir(evidence, { recursive: true });
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
  await expect(page.getByLabel('Type a command')).toBeFocused();
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
  const priority = page.getByLabel('Edit priority for CAN-100', {
    exact: true,
  });
  await priority.focus();
  await expect(priority).toBeFocused();
  await expect(
    page.getByLabel('Summary for CAN-100', { exact: true }),
  ).toHaveCount(0);
  await summary.press('Enter');
  await page
    .getByLabel('Summary for CAN-100', { exact: true })
    .fill('Sample barrier regression');
  await fixture('hold', 'a11y-edit', 'update', 'CAN-100');
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture('started', 'a11y-edit')).toBe(true);
  await expect(summary).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: /^Saving CAN-100$/ }),
  ).toHaveCount(1);
  await fixture('release', 'a11y-edit', 'Sample edit failure');
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Sample edit failure' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Dismiss error' }).click();

  await fixture('hold', 'a11y-refresh', 'tree', 'CAN-100');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fixture('started', 'a11y-refresh')).toBe(true);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Checking CAN-100 for changes' }),
  ).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.spin')
      .evaluateAll((elements) =>
        elements.every((e) => getComputedStyle(e).animationName === 'none'),
      ),
  ).toBe(true);
  await capture('reduced-motion-loading');
  await fixture('release', 'a11y-refresh', 'Sample refresh failure');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Sample refresh failure' }),
  ).toBeVisible();
  await capture('refresh-error');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /CAN-100: .* issues, last updated at/ }),
  ).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);

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
        const ratios = await page.evaluate(() => {
          const rgb = (color) => color.match(/[\d.]+/g).map(Number);
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
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          return [
            ...document.querySelectorAll(
              '.column-sort, .sidebar-empty, .statusbar > span:not(.sr-only), .dialog .primary',
            ),
          ]
            .filter(
              (e) => e.getBoundingClientRect().width && e.textContent.trim(),
            )
            .map((e) => {
              const chain = [];
              for (let p = e; p; p = p.parentElement) chain.unshift(p);
              let background = [255, 255, 255];
              for (const p of chain)
                background = blend(
                  rgb(getComputedStyle(p).backgroundColor),
                  background,
                );
              const foreground = blend(
                rgb(getComputedStyle(e).color),
                background,
              );
              const values = [
                luminance(foreground),
                luminance(background),
              ].sort((a, b) => a - b);
              return {
                text: e.textContent.trim(),
                ratio: (values[1] + 0.05) / (values[0] + 0.05),
              };
            });
        });
        contrast.push({ palette, theme, colorScheme, ratios });
        for (const result of ratios)
          expect(
            result.ratio,
            `${palette}/${theme}/${colorScheme}: ${result.text}`,
          ).toBeGreaterThanOrEqual(4.5);
        await capture(`${palette}-${theme}-${colorScheme}`);
        await page.keyboard.press('Escape');
        await expect(settings).toBeFocused();
      }
    }
  }
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
