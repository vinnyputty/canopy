import { expect } from '@playwright/test';

/** Sample-only real UI audit; runs inside the existing disposable smoke profile. */
export async function auditPalette(app, page) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const origin = page.getByRole('treeitem').first();
  await expect(origin).toBeVisible();
  await origin.focus();
  const originalScroll = await page
    .locator('.tree-scroll')
    .evaluate((element) => {
      element.scrollTop = Math.min(
        120,
        element.scrollHeight - element.clientHeight,
      );
      return { top: element.scrollTop, left: element.scrollLeft };
    });
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    demo.paletteSavedSearch = demo.search;
    demo.paletteSearchCalls = [];
    demo.search = async (query, token, signal) => {
      demo.paletteSearchCalls.push(query);
      if (query !== 'paletteaudit')
        return demo.paletteSavedSearch(query, token, signal);
      const snapshot = await demo.tree('CAN-100');
      return {
        issues: snapshot.issues.slice(0, 2),
        nextPageToken: 'palette-more',
        boundaries: [{ repository: 'sample/repo', reason: 'incomplete' }],
      };
    };
  });
  try {
    await page.keyboard.press(`${modifier}+K`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    const input = palette.getByRole('combobox', { name: 'Search workspace' });
    await expect(input).toBeFocused();
    await input.fill('CAN-100');
    await expect(palette.getByRole('option').first()).toContainText(
      'Open root',
    );
    await input.press('ArrowDown');
    const selected = await input.getAttribute('aria-activedescendant');
    await input.fill('CAN-10');
    await expect(input).toHaveAttribute('aria-activedescendant', selected);
    // Allow the existing provider debounce to elapse: local typing must stay local.
    await page.waitForTimeout(350);
    expect(
      await app.evaluate(() => globalThis.canopySmoke.paletteSearchCalls),
    ).toEqual([]);
    await input.press('Escape');
    await expect(palette).toBeHidden();
    await expect(origin).toBeFocused();
    expect(
      await page.locator('.tree-scroll').evaluate((element) => ({
        top: element.scrollTop,
        left: element.scrollLeft,
      })),
    ).toEqual(originalScroll);

    await page.keyboard.press(`${modifier}+K`);
    await input.fill('paletteaudit');
    await expect(palette.getByText('No local matches')).toBeVisible();
    await palette
      .getByRole('button', { name: 'Search remote issues…' })
      .click();
    const remote = page.getByRole('dialog', { name: 'Open issue tree' });
    await expect(remote).toBeVisible();
    await page.waitForTimeout(350);
    expect(
      await app.evaluate(() => globalThis.canopySmoke.paletteSearchCalls),
    ).toEqual([]);
    await remote
      .getByRole('button', { name: 'Search issues', exact: true })
      .click();
    await expect(remote.getByRole('option')).toHaveCount(2);
    await expect(
      remote.getByText(/GitHub returned incomplete results/),
    ).toBeVisible();
    await expect(
      remote.getByText(/Later pages may contain better matches/),
    ).toBeVisible();
    expect(
      await app.evaluate(() => globalThis.canopySmoke.paletteSearchCalls),
    ).toEqual(['paletteaudit']);
    await page.keyboard.press('Escape');
    await expect(palette).toBeVisible();
    await expect(input).toHaveValue('paletteaudit');
    await page.keyboard.press('Escape');
    await expect(origin).toBeFocused();

    await page.keyboard.press(`${modifier}+K`);
    await input.fill('CAN-101');
    const loaded = palette
      .getByRole('option')
      .filter({ hasText: 'Loaded issue' })
      .first();
    await expect(loaded).toBeVisible();
    await expect(loaded).toContainText('loaded snapshot, may be stale');
    await loaded.click();
    await expect(palette).toBeHidden();
    const selectedIssue = page.locator('[data-tree-key="CAN-101"]');
    await expect(selectedIssue).toBeFocused();
    console.log(
      'Palette UI audit passed: typed context, keyboard identity, focus/scroll return, deliberate remote search, incomplete/paginated disclosures, and loaded issue navigation.',
    );
  } finally {
    await app.evaluate(() => {
      const demo = globalThis.canopySmoke;
      demo.search = demo.paletteSavedSearch;
      delete demo.paletteSavedSearch;
      delete demo.paletteSearchCalls;
    });
  }
}
