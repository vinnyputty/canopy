import { expect } from '@playwright/test';

export async function auditBulk(app, page, modifier) {
  const row = (key) => page.locator(`[data-tree-key="${key}"]`);
  const bulk = page.getByRole('region', { name: 'Bulk triage' });
  await row('CAN-101').focus();
  await row('CAN-101').press('Shift+ArrowDown');
  await expect(bulk).toBeVisible();
  await expect(bulk).toContainText('2 issues selected');
  await bulk.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bulk).toBeHidden();

  await row('CAN-101').getByRole('button', { name: 'Expand CAN-101' }).click();
  await row('CAN-100')
    .getByRole('button', { name: 'A calmer place to get things done' })
    .click();
  await row('CAN-101')
    .getByRole('button', { name: 'Build the workspace foundation' })
    .click({ modifiers: [modifier] });
  await row('CAN-103')
    .getByRole('button', { name: 'Create the tab experience' })
    .click({ modifiers: [modifier] });
  await expect(bulk).toContainText('3 issues selected');
  await row('CAN-101')
    .getByRole('button', { name: 'Collapse CAN-101' })
    .click();
  await expect(bulk).toContainText('2 issues selected');
  await bulk.getByRole('button', { name: 'Copy keys and summaries' }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'CAN-100 A calmer place to get things done\nCAN-101 Build the workspace foundation',
  );
  await bulk.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bulk).toBeHidden();

  await row('CAN-101')
    .getByRole('button', { name: 'Build the workspace foundation' })
    .click();
  await row('CAN-106')
    .getByRole('button', { name: 'Make room for every issue' })
    .click({ modifiers: [modifier] });
  await expect(bulk).toBeVisible();
  await row('CAN-101')
    .getByRole('button', { name: 'Copy link to CAN-101' })
    .click();
  await expect(bulk).toContainText('2 issues selected');
  await row('CAN-106')
    .getByRole('button', { name: 'Copy link to CAN-106' })
    .focus();
  await expect(bulk).toContainText('2 issues selected');
  await bulk.getByRole('button', { name: 'Copy keys and summaries' }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'CAN-101 Build the workspace foundation\nCAN-106 Make room for every issue',
  );
  await expect(bulk.getByText('Copied 2 issues.')).toBeVisible();
  await bulk.getByLabel('Action').selectOption('priority');
  await bulk.getByLabel('Bulk value').selectOption({ label: 'Low' });
  await bulk.getByRole('button', { name: 'Preview changes' }).click();
  await expect(bulk.getByText('Review before applying')).toBeVisible();
  await expect(bulk.getByRole('listitem')).toHaveCount(2);
  await app.evaluate(() =>
    globalThis.canopySmoke.hold('bulk-failure', 'update', 'CAN-106'),
  );
  await bulk.getByRole('button', { name: 'Apply to 2 issues' }).click();
  await expect(bulk.getByText('Results', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.canopySmoke.started('bulk-failure')),
    )
    .toBe(true);
  await app.evaluate(() =>
    globalThis.canopySmoke.release('bulk-failure', 'Temporary bulk failure'),
  );
  const results = bulk.locator('.bulk-results');
  await expect(
    results.locator('li').filter({ hasText: 'CAN-106' }),
  ).toContainText('rejected');
  await expect(
    results.locator('li').filter({ hasText: 'CAN-101' }),
  ).toContainText('Saved');
  await row('CAN-110')
    .getByRole('button', { name: 'Keep the details in sync' })
    .click();
  await expect(bulk).toContainText('Bulk triage results');
  await expect(results.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Open issue' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Open issue tree' });
  await dialog.getByRole('combobox').fill('CAN-106');
  await dialog.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-106 issue tree' }),
  ).toBeVisible();
  await expect(bulk).toBeHidden();
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await expect(
    results.locator('li').filter({ hasText: 'CAN-106' }),
  ).toContainText('rejected');
  await page.getByRole('button', { name: 'Close CAN-106' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await results
    .locator('li')
    .filter({ hasText: 'CAN-106' })
    .getByRole('button', { name: 'Retry' })
    .click();
  await expect(
    bulk.locator('.bulk-results li').filter({ hasText: 'Saved' }),
  ).toHaveCount(2);
  await expect(
    row('CAN-101').getByRole('button', { name: 'Edit priority for CAN-101' }),
  ).toContainText('Low');
  await expect(
    row('CAN-106').getByRole('button', { name: 'Edit priority for CAN-106' }),
  ).toContainText('Low');
  await app.evaluate(() =>
    globalThis.canopySmoke.hold('bulk-undo-failure', 'tree', 'CAN-101'),
  );
  await results
    .locator('li')
    .filter({ hasText: 'CAN-101' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.canopySmoke.started('bulk-undo-failure')),
    )
    .toBe(true);
  await app.evaluate(() =>
    globalThis.canopySmoke.release(
      'bulk-undo-failure',
      'Temporary undo failure',
    ),
  );
  await expect(
    results.locator('li').filter({ hasText: 'CAN-101' }),
  ).toContainText('Undo failed');
  await expect(
    results
      .locator('li')
      .filter({ hasText: 'CAN-101' })
      .getByRole('button', { name: 'Retry' }),
  ).toHaveCount(0);
  await expect(
    results
      .locator('li')
      .filter({ hasText: 'CAN-101' })
      .getByRole('button', { name: 'Undo' }),
  ).toBeEnabled();
  await results
    .locator('li')
    .filter({ hasText: 'CAN-101' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await results
    .locator('li')
    .filter({ hasText: 'CAN-106' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(
    row('CAN-101').getByRole('button', { name: 'Edit priority for CAN-101' }),
  ).toContainText('High');
  await expect(
    row('CAN-106').getByRole('button', { name: 'Edit priority for CAN-106' }),
  ).toContainText('Highest');
  await row('CAN-101')
    .getByRole('button', { name: 'Build the workspace foundation' })
    .click();
  await row('CAN-110')
    .getByRole('button', { name: 'Keep the details in sync' })
    .click({ modifiers: [modifier] });
  await expect(bulk).toContainText('2 issues selected');
  await expect(
    bulk.getByRole('button', { name: 'Preview changes' }),
  ).toBeDisabled();
  await expect(results.locator('li')).toHaveCount(2);
  await expect(
    results.locator('li').filter({ hasText: 'CAN-106' }),
  ).toContainText('Undone');
  await bulk.getByRole('button', { name: 'Dismiss results' }).click();
  await expect(
    bulk.getByRole('button', { name: 'Preview changes' }),
  ).toBeEnabled();
  await bulk.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bulk).toBeHidden();
  const error = page
    .getByRole('alert')
    .filter({ hasText: 'Temporary bulk failure' });
  if (await error.isVisible()) await error.getByRole('button').click();
}
