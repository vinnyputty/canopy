import { expect } from '@playwright/test';

export async function auditSearch(app, page) {
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    demo.savedSearch = demo.search;
    demo.searchCalls = [];
    demo.search = async (query, token, signal) => {
      demo.searchCalls.push({ query, token });
      const snapshot = await demo.tree('CAN-100');
      const first = {
        ...snapshot.issues[0],
        key: 'CAN-100',
        summary: 'Search prefix',
      };
      const second = {
        ...first,
        key: 'CAN-200',
        summary: 'Other search match',
      };
      if (query === 'CAN-100') return { issues: [second] };
      if (query === 'CAN-10')
        return {
          issues: [first, { ...first, key: 'CAN-101', summary: 'Next key' }],
        };
      if (query === 'CAN-') return { issues: [] };
      if (query === 'empty') return { issues: [] };
      if (query === 'empty-page') return { issues: [], nextPageToken: 'more' };
      if (query === 'error' && !demo.searchRetried) {
        demo.searchRetried = true;
        throw new Error('Recoverable search failure');
      }
      if (query === 'slow')
        return new Promise((resolve) => {
          demo.releaseSearch = () =>
            resolve({ issues: [{ ...first, summary: 'Obsolete response' }] });
          signal.addEventListener('abort', () => {
            demo.searchAborted = true;
          });
        });
      if (token && !demo.moreRetried) {
        demo.moreRetried = true;
        throw new Error('Recoverable page failure');
      }
      if (token)
        return { issues: [{ ...first, key: 'CAN-101', summary: 'Search' }] };
      return { issues: [first, second], nextPageToken: 'x'.repeat(600) };
    };
  });
  const open = async () => {
    await page
      .getByRole('button', { name: 'Open issue', exact: true })
      .first()
      .click();
    return page.getByRole('dialog', { name: 'Open issue tree' });
  };
  let dialog = await open();
  let input = dialog.getByRole('combobox');
  await input.fill('CAN-100');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').first()).toContainText('CAN-200');
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await input.fill('CAN-10');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(dialog.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('ArrowDown');
  await expect(dialog.getByRole('option').last()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('tree', { name: 'CAN-101 issue tree' }),
  ).toBeVisible();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await input.fill('CAN-');
  await expect(dialog.getByRole('option')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Open tree' }),
  ).toBeDisabled();
  await input.fill('CAN');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await input.fill('search');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('ArrowUp');
  await expect(input).toBeFocused();
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(dialog.getByRole('option').last()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Recoverable page failure',
  );
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(input).toBeFocused();
  await dialog.getByRole('button', { name: 'Retry search' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await expect(dialog.getByRole('option', { selected: true })).toContainText(
    'CAN-200',
  );
  await expect(input).toBeFocused();
  await input.fill('search again');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: 'Load more' })).toHaveCount(
    0,
  );
  await expect(input).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('option', { selected: true })).toContainText(
    'CAN-200',
  );
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await expect(dialog.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await input.fill('empty');
  await expect(
    dialog.getByText(
      'No matching issues. Try another summary or enter an issue key.',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Open tree' }),
  ).toBeDisabled();
  await input.fill('empty-page');
  await expect(
    dialog.getByText(
      'No matches on this page. Load more to continue searching.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Load more' })).toBeEnabled();
  await input.fill('error');
  await expect(dialog.getByRole('alert')).toContainText(
    'Recoverable search failure',
  );
  await dialog.getByRole('button', { name: 'Retry search' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await input.fill('slow');
  await expect(dialog.getByText('Searching Jira…')).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(() => Boolean(globalThis.canopySmoke.releaseSearch)),
    )
    .toBe(true);
  await input.fill('empty');
  await expect
    .poll(() =>
      app.evaluate(() => Boolean(globalThis.canopySmoke.searchAborted)),
    )
    .toBe(true);
  await expect(
    dialog.getByText(
      'No matching issues. Try another summary or enter an issue key.',
    ),
  ).toBeVisible();
  await app.evaluate(() => globalThis.canopySmoke.releaseSearch());
  await expect(dialog.getByRole('option')).toHaveCount(0);
  await input.fill('https://example.atlassian.net/browse/CAN-200');
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await app.evaluate(() => {
    const demo = globalThis.canopySmoke;
    demo.search = demo.savedSearch;
  });
  const savedWorkspace = await page.evaluate(() =>
    window.canopy.loadWorkspace(),
  );
  await page.evaluate(async (workspace) => {
    const tab = {
      ...workspace.tabs[0],
      id: 'unavailable-search-tab',
      connectionId: 'unavailable-site',
      rootKey: 'MISSING-1',
    };
    await window.canopy.saveWorkspace({
      ...workspace,
      tabs: [tab],
      activeTabId: tab.id,
      recentRoots: Array.from({ length: 25 }, (_, index) => ({
        connectionId: 'demo',
        rootKey: `CAN-${100 + index}`,
        summary: `Recent ${index}`,
      })),
    });
  }, savedWorkspace);
  await page.reload();
  await expect(page.getByText('Opening Canopy…')).toBeHidden();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await expect(dialog.getByRole('option')).toHaveCount(20);
  await expect(dialog.getByRole('option').first()).toContainText('CAN-100');
  await expect(dialog.getByRole('option').last()).toContainText('CAN-119');
  await input.fill('calmer');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').first()).toContainText('CAN-100');
  await input.press('Escape');
  await page.evaluate(
    (workspace) => window.canopy.saveWorkspace(workspace),
    savedWorkspace,
  );
  await page.reload();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await input.fill('https://example.atlassian.net/browse/CAN-100');
  await dialog.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  dialog = await open();
  input = dialog.getByRole('combobox');
  await input.fill('CAN-999');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Issue not found. Try CAN-100 or CAN-200',
  );
  console.log(
    'Search integration passed: key prefixes, exact keys, URLs, missing keys, keyboard, recent roots, empty/error/retry, pagination, opaque cursors, cancellation, and stale results.',
  );
}
