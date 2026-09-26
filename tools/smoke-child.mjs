import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function auditChildCreation(appPath, executablePath, baseEnv) {
  const userData = await mkdtemp(join(tmpdir(), 'canopy-child-smoke-'));
  const env = { ...baseEnv, CANOPY_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath, args: [appPath], env });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await expect(
      page.getByRole('heading', { name: 'See the whole tree.' }),
    ).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const state = {
        options: 0,
        fields: 0,
        creates: 0,
        assigneeKeys: [],
        input: null,
      };
      globalThis.canopyChildSmoke = state;
      const replace = (name, handler) => {
        ipcMain.removeHandler(`canopy:${name}`);
        ipcMain.handle(`canopy:${name}`, handler);
      };
      replace('connections', () => [
        {
          id: 'demo',
          name: 'Canopy Jira fixture',
          url: 'https://example.invalid',
          provider: 'jira',
        },
      ]);
      replace('childCreateOptions', () => {
        state.options++;
        return {
          project: { id: '100', name: 'Canopy project' },
          parent: { id: 'CAN-100', name: 'A calmer place to get things done' },
          types: [
            { id: '11', name: 'Story' },
            { id: '12', name: 'Restricted story' },
          ],
        };
      });
      replace('childCreateFields', (_event, _connection, _parent, typeId) => {
        state.fields++;
        return typeId === '12'
          ? {
              description: false,
              descriptionRequired: false,
              assignee: false,
              assigneeRequired: false,
              priority: false,
              priorityRequired: false,
              priorities: [],
              unsupported:
                'Jira requires fields Canopy cannot fill: Release gate. Create this child in Jira.',
            }
          : {
              description: true,
              descriptionRequired: false,
              assignee: true,
              assigneeRequired: false,
              priority: true,
              priorityRequired: false,
              priorities: [{ id: '2', name: 'High' }],
            };
      });
      replace('assignees', (_event, _connection, parentKey) => {
        state.assigneeKeys.push(parentKey);
        return { users: [{ id: 'alex', name: 'Alex Morgan' }] };
      });
      replace('createChild', async (_event, _connection, parentKey, input) => {
        state.creates++;
        state.input = { parentKey, ...input };
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          id: '300',
          key: 'CAN-300',
          parentKey,
          summary: input.summary,
          type: 'Story',
          priority: { id: '2', name: 'High' },
          assignee: null,
          status: { id: 'todo', name: 'To Do', category: 'new' },
          links: [],
        };
      });
    });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open issue' }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open issue' }).first().click();
    const open = page.getByRole('dialog', { name: 'Open issue tree' });
    await open
      .getByLabel('Issue key, uppercase project prefix, Jira URL, or summary')
      .fill('CAN-100');
    await open.getByRole('button', { name: 'Open tree' }).click();
    const tree = page.getByRole('tree', { name: 'CAN-100 issue tree' });
    await expect(tree).toBeVisible();
    await tree
      .locator('[data-tree-key="CAN-100"]')
      .getByRole('button', { name: 'Actions for CAN-100' })
      .click();
    await page
      .getByRole('menu', { name: 'Actions for CAN-100' })
      .getByRole('menuitem', { name: 'Create child issue' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Create child issue of CAN-100',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Canopy project')).toBeVisible();
    await expect(dialog.getByLabel('Issue type')).toHaveValue('11');
    await dialog.getByLabel('Issue type').selectOption('12');
    await expect(dialog.getByText(/Release gate/)).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create child', exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Open parent in Jira' }),
    ).toBeVisible();
    await dialog.getByLabel('Issue type').selectOption('11');
    await dialog.getByLabel('Title').fill('Created from the tree');
    await dialog.getByLabel('Description').fill('Details for the child');
    await dialog.getByPlaceholder('Search people').fill('Alex');
    await dialog.getByRole('button', { name: 'Alex Morgan' }).click();
    await dialog.getByLabel('Priority').selectOption('2');
    const scroll = await page
      .locator('.tree-scroll')
      .evaluate((element) => element.scrollTop);
    await expect(
      dialog.getByRole('button', { name: 'Create child', exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      const button = [
        ...document.querySelectorAll('[role="dialog"] button'),
      ].find((element) => element.textContent === 'Create child');
      button.click();
      button.click();
    });
    const child = tree.locator('[data-tree-key="CAN-300"]');
    await expect(child).toBeVisible();
    await expect(child).toHaveAttribute('aria-selected', 'true');
    await expect(tree.locator('[data-tree-key="CAN-101"]')).toBeVisible();
    await expect(tree.locator('[data-tree-key="CAN-100"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      await page
        .locator('.tree-scroll')
        .evaluate((element) => element.scrollTop),
    ).toBe(scroll);
    const state = await app.evaluate(() => globalThis.canopyChildSmoke);
    expect(state.creates).toBe(1);
    expect(state.options).toBeGreaterThan(0);
    expect(state.fields).toBeGreaterThanOrEqual(2);
    expect(state.assigneeKeys.length).toBeGreaterThan(0);
    expect(state.assigneeKeys.every((key) => key === 'CAN-100')).toBe(true);
    expect(state.input).toEqual({
      parentKey: 'CAN-100',
      typeId: '11',
      summary: 'Created from the tree',
      description: 'Details for the child',
      assigneeId: 'alex',
      priorityId: '2',
    });
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([]);
    console.log(
      'Jira child creation integration passed: metadata, unsupported fields, one submit, selection, and scroll.',
    );
  } finally {
    await app?.close();
    await rm(userData, { recursive: true, force: true });
  }
}
