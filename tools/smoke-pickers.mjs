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
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
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
  await field('status').click();
  await expect(
    page.getByRole('menuitem', { name: 'To Do', exact: true }),
  ).toBeVisible();
  await page
    .locator('.status-popover')
    .getByRole('button', { name: 'Cancel' })
    .click();
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
  await field('status').click();
  await expect(
    page.getByRole('menuitem', { name: 'To Do', exact: true }),
  ).toBeVisible();
  await page
    .locator('.status-popover')
    .getByRole('button', { name: 'Cancel' })
    .click();
}
