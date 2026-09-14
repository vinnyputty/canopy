import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const workspace = process.env.BUILD_WORKSPACE_DIRECTORY || process.cwd();
const suppliedApp = process.env.CANOPY_APP_PATH;
const appPath = suppliedApp
  ? isAbsolute(suppliedApp)
    ? suppliedApp
    : resolve(workspace, suppliedApp)
  : join(workspace, '.cache', 'desktop');
const screenshotPath = join(workspace, '.cache', 'tree.png');
const suppliedRuntime = process.argv[2] || process.env.CANOPY_ELECTRON_PATH;
const executablePath = suppliedRuntime
  ? isAbsolute(suppliedRuntime)
    ? suppliedRuntime
    : resolve(workspace, suppliedRuntime)
  : require('electron');
const userData = await mkdtemp(join(tmpdir(), 'canopy-smoke-'));
const env = { ...process.env, CANOPY_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const paletteShortcut =
  process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K';
const paletteShortcutLabel =
  process.platform === 'darwin' ? '⌘⇧K' : 'Ctrl + Shift + K';

let app;
let page;
const pageErrors = [];

async function launch() {
  app = await electron.launch({
    executablePath,
    args: [appPath],
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error));
  await expect(page.getByText('Opening Canopy…')).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: 'Canopy sidebar' }),
  ).toBeVisible();
}

async function close() {
  if (!app) return;
  await app.close();
  app = undefined;
  page = undefined;
}

async function openIssue(key) {
  await page.getByRole('button', { name: 'Open issue' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Open issue tree' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Issue key, Jira URL, or summary').fill(key);
  await dialog.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    page.getByRole('tree', { name: `${key} issue tree` }),
  ).toBeVisible();
}

function issue(key) {
  return page.locator(`[data-tree-key="${key}"]`);
}

async function expectIssueBefore(firstKey, secondKey) {
  await expect
    .poll(async () => {
      const [first, second] = await Promise.all([
        issue(firstKey).boundingBox(),
        issue(secondKey).boundingBox(),
      ]);
      return Boolean(first && second && first.y < second.y);
    })
    .toBe(true);
}

try {
  await launch();
  await expect(
    page.getByRole('heading', { name: 'See the whole tree.' }),
  ).toBeVisible();

  await openIssue('CAN-100');
  const tree = page.getByRole('tree', { name: 'CAN-100 issue tree' });
  await expect(tree.getByRole('treeitem')).toHaveCount(4);

  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(issue('CAN-108')).toBeVisible();
  await expect(issue('CAN-102')).toHaveCount(0);

  await page.getByRole('checkbox', { name: 'Hide done' }).uncheck();
  await expect(tree.getByRole('treeitem')).toHaveCount(15);
  await expect(issue('CAN-102')).toBeVisible();

  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(15);

  await expectIssueBefore('CAN-111', 'CAN-112');
  await page
    .getByRole('button', { name: /Reorder CAN-112/ })
    .press('Alt+ArrowUp');
  await expectIssueBefore('CAN-112', 'CAN-111');

  const summary = 'Edit an issue from the Canopy tree';
  await issue('CAN-111').getByTitle('Double-click to edit').dblclick();
  const summaryInput = page.getByLabel('Summary for CAN-111');
  await summaryInput.fill(summary);

  // A focus-triggered background poll must not replace an in-progress draft.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(summaryInput).toHaveValue(summary);
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(summaryInput).toHaveValue(summary);
  await summaryInput.press('Enter');
  await expect(issue('CAN-111').getByText(summary)).toBeVisible();

  await issue('CAN-111').getByLabel('Edit priority for CAN-111').click();
  await page.getByLabel('Choose value').selectOption({ label: 'Highest' });
  await expect(issue('CAN-111').getByText('Highest')).toBeVisible();

  await issue('CAN-111').getByLabel('Edit assignee for CAN-111').click();
  await page.getByRole('button', { name: /Sam Rivera/ }).click();
  await expect(issue('CAN-111').getByText('Sam Rivera')).toBeVisible();

  await issue('CAN-111').getByLabel('Edit status for CAN-111').click();
  await page.getByRole('menuitem', { name: 'In Progress' }).click();
  await expect(issue('CAN-111').getByText('In Progress')).toBeVisible();

  await mkdir(join(workspace, '.cache'), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const linkedIssue = tree.getByTitle('1 linked issue');
  await linkedIssue.click();
  const links = linkedIssue.locator(
    'xpath=ancestor::div[contains(@class,"issue-row")]/following-sibling::div[contains(@class,"linked-panel")]',
  );
  await expect(links.getByText('CAN-200')).toBeVisible();
  await links.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /CAN-100/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /CAN-200/ })).toBeVisible();

  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const paletteRow = shortcuts.locator('.shortcut-row').filter({
    hasText: 'Show command palette',
  });
  await paletteRow.getByRole('button').click();
  await page.keyboard.press(paletteShortcut);
  await expect(paletteRow.getByRole('button')).toHaveText(paletteShortcutLabel);
  await shortcuts.getByRole('button', { name: 'Save' }).click();

  await page.keyboard.press(paletteShortcut);
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeHidden();

  // Workspace writes are intentionally debounced.
  await page.waitForTimeout(350);
  await close();
  await launch();

  await expect(page.getByRole('tab', { name: /CAN-100/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /CAN-200/ })).toBeVisible();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await page.keyboard.press(paletteShortcut);
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await expect(issue('CAN-111').getByText(summary)).toBeVisible();
  await expect(issue('CAN-111').getByText('Highest')).toBeVisible();
  await expect(issue('CAN-111').getByText('Sam Rivera')).toBeVisible();
  await expect(issue('CAN-111').getByText('In Progress')).toBeVisible();
  await expectIssueBefore('CAN-112', 'CAN-111');

  expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([]);
  console.log(
    `Canopy Electron smoke test passed. Screenshot: ${screenshotPath}`,
  );
} finally {
  await close();
  await rm(userData, { recursive: true, force: true });
}
