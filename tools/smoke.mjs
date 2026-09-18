import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const paletteShortcut =
  process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K';
const paletteShortcutLabel =
  process.platform === 'darwin' ? '⌘⇧K' : 'Ctrl + Shift + K';

let app;
let page;
const pageErrors = [];

async function launch(production = false) {
  app = await electron.launch({
    executablePath,
    args: [production ? join(appPath, 'dist/main.cjs') : appPath],
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

  await page.keyboard.press(`${modifier}+1`);
  await expect(tree).toBeVisible();
  await page.keyboard.press(`${modifier}+9`);
  await expect(tree).toBeVisible();
  await page.keyboard.press(`${modifier}+2`);
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await page.keyboard.press(`${modifier}+b`);
  await expect(page.locator('.app')).toHaveClass(/sidebar-is-collapsed/);
  await page.keyboard.press(`${modifier}+b`);
  await expect(page.locator('.app')).not.toHaveClass(/sidebar-is-collapsed/);

  await page
    .getByRole('button', { name: 'Copy link to CAN-200' })
    .first()
    .click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'https://example.invalid/browse/CAN-200',
  );

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

  // Favorites are independent from open tabs; reopening retains complete state.
  const firstTab = page.getByRole('tab', { name: /CAN-100/ });
  const secondTab = page.getByRole('tab', { name: /CAN-200/ });
  await firstTab.click();
  await issue('CAN-111').focus();
  await firstTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin root', exact: true }).click();
  const pinnedRoots = page.getByRole('navigation', { name: 'Pinned roots' });
  await expect(
    pinnedRoots.getByRole('button', { name: /CAN-100 A calmer/ }),
  ).toBeVisible();
  await firstTab.click({ button: 'middle' });
  await expect(firstTab).toHaveCount(0);
  await expect(pinnedRoots).toBeVisible();
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(issue('CAN-111')).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.locator('.linked-panel').getByText('CAN-200'),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Hide done' }),
  ).not.toBeChecked();

  // Drag order is durable; keyboard reordering is also available.
  await firstTab.dragTo(secondTab);
  await expect(page.getByRole('tab').first()).toContainText('CAN-100');
  await firstTab.focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.getByRole('tab').last()).toContainText('CAN-100');
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect(page.getByRole('tab').first()).toContainText('CAN-100');

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({
      x: 40,
      y: 50,
      width: 1100,
      height: 600,
    }),
  );
  // History restores selection and scroll rather than the destination's latest state.
  await issue('CAN-111').focus();
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = 100;
  });
  const savedScroll = await page
    .locator('.tree-scroll')
    .evaluate((element) => element.scrollTop);
  expect(savedScroll).toBeGreaterThan(0);
  await secondTab.click();
  await issue('CAN-200').focus();
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(issue('CAN-111')).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBe(savedScroll);
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');

  const divider = page.getByRole('separator', { name: 'Sidebar width' });
  await divider.focus();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '400');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({
      x: 40,
      y: 50,
      width: 1100,
      height: 700,
    }),
  );
  const savedWindowBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds(),
  );
  await page
    .getByRole('button', { name: 'Open issue', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('dialog').getByText('Recent roots'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Workspace writes are intentionally debounced.
  await page.waitForTimeout(350);
  await close();
  await launch();

  await expect(page.getByRole('tab').first()).toContainText('CAN-100');
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toBeVisible();
  await expect(
    page.getByRole('separator', { name: 'Sidebar width' }),
  ).toHaveAttribute('aria-valuenow', '400');
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
  ).toEqual(savedWindowBounds);
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

  await page.getByTitle('Open in Jira', { exact: true }).first().click();
  const errorText = page.locator('.error-banner span').first();
  await expect(errorText).toContainText('Demo issues exist only in Canopy.');
  await expect(errorText).toHaveCSS('user-select', 'text');
  await errorText.selectText();
  await page.keyboard.press(`${modifier}+c`);
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    'Demo issues exist only in Canopy.',
  );

  // Context actions operate on the clicked tab, including inactive tabs.
  await openIssue('CAN-101');
  await page.getByRole('tab', { name: /CAN-200/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close to the right' }).click();
  await expect(page.getByRole('tab', { name: /CAN-101/ })).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(page.getByRole('tab', { name: /CAN-101/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy root link' }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'https://example.invalid/browse/CAN-100',
  );
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close others' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await issue('CAN-111').focus();
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await close();
  await launch();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(page.getByRole('tab', { name: /CAN-100/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(issue('CAN-111')).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.locator('.linked-panel').getByText('CAN-200'),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Hide done' }),
  ).not.toBeChecked();

  await page.getByTitle('Disconnect Canopy demo').click();
  await expect(page.getByText('Canopy demo', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.waitForTimeout(350);
  await close();
  await launch();
  await expect(page.getByText('Canopy demo', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  const quittingProcess = app.process();
  // Native menu shortcuts need Electron input; CDP keyboard events bypass it.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Q',
      modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
    });
  });
  await expect.poll(() => quittingProcess.exitCode).toBe(0);
  app = undefined;
  page = undefined;

  // An upgrade must discard persisted demo tabs while retaining preferences.
  await writeFile(
    join(userData, 'workspace.json'),
    JSON.stringify({
      tabs: [
        {
          id: 'legacy-demo',
          connectionId: 'demo',
          rootKey: 'CAN-100',
          expanded: [],
          hideDone: true,
          scrollTop: 0,
        },
      ],
      pinnedRoots: [{ connectionId: 'demo', rootKey: 'CAN-100' }],
      recentRoots: [{ connectionId: 'demo', rootKey: 'CAN-100' }],
      closedTabs: [
        {
          id: 'legacy-closed',
          connectionId: 'demo',
          rootKey: 'CAN-200',
          expanded: [],
          hideDone: true,
          scrollTop: 0,
        },
      ],
      activeTabId: 'legacy-demo',
      shortcuts: {},
      theme: 'dark',
      sidebarCollapsed: false,
    }),
  );
  await launch(true);
  expect(await page.evaluate(() => window.canopy.connections())).toEqual([]);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(page.getByRole('tab')).toHaveCount(0);

  expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([]);
  console.log(
    `Canopy Electron smoke test passed. Screenshot: ${screenshotPath}`,
  );
} finally {
  await close();
  await rm(userData, { recursive: true, force: true });
}
