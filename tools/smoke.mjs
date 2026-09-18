import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function resizeWindow(height) {
  await app.evaluate(({ BrowserWindow, screen }, requestedHeight) => {
    const window = BrowserWindow.getAllWindows()[0];
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const width = Math.min(1100, area.width);
    const height = Math.min(Math.max(600, requestedHeight), area.height);
    window.setMinimumSize(
      Math.min(920, area.width),
      Math.min(600, area.height),
    );
    // CI desktops can be narrower than the preferred test window. Keep the
    // saved bounds on screen so restart tests exact restoration, not clamping.
    window.setBounds({
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    });
  }, height);
  await expect
    .poll(() => page.evaluate(() => window.innerHeight))
    .toBeLessThanOrEqual(height);
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

  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('canopy:currentUser');
    let calls = 0;
    ipcMain.handle('canopy:currentUser', () => {
      if (++calls === 1) throw new Error('Temporary identity failure');
      return { id: 'alex', name: 'Alex Morgan' };
    });
  });
  await openIssue('CAN-100');
  await expect(page.getByRole('status')).toContainText(
    'Temporary identity failure',
  );
  await page.getByRole('button', { name: 'Retry account lookup' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry account lookup' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Filter assignee').locator('option[value="me"]'),
  ).toBeEnabled();
  const tree = page.getByRole('tree', { name: 'CAN-100 issue tree' });
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  const rootSummary = 'A calmer place to get things done';
  const rootTab = page.getByRole('tab', { name: /CAN-100/ });
  const rootSidebar = page.locator('.side-tab').filter({ hasText: 'CAN-100' });
  for (const label of [rootTab, rootSidebar]) {
    await expect(label).toHaveAttribute(
      'title',
      `CAN-100: ${rootSummary} · Canopy demo`,
    );
    const subtitle = label.locator('small');
    await expect(subtitle).toHaveText(rootSummary);
    await expect(subtitle).toHaveCSS('text-overflow', 'ellipsis');
    await expect(subtitle).toHaveCSS('overflow-x', 'hidden');
    await expect(subtitle).toHaveCSS('white-space', 'nowrap');
    expect(
      await subtitle.evaluate((element) => {
        const previous = element.style.maxWidth;
        element.style.maxWidth = '80px';
        try {
          return element.scrollWidth > element.clientWidth;
        } finally {
          element.style.maxWidth = previous;
        }
      }),
    ).toBe(true);
  }

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

  // Search preserves the saved hierarchy expansion and reveals ancestor context.
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await page.keyboard.press(`${modifier}+f`);
  await expect(
    page.getByRole('textbox', { name: 'Find in tree' }),
  ).toBeFocused();
  await page.getByRole('textbox', { name: 'Find in tree' }).fill('CAN-108');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  await expect(issue('CAN-108')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Collapse CAN-100', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Collapse', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Clear tree search' }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(
    issue('CAN-100').getByText('3/4 children', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Expand', exact: true }).dblclick();
  await expect(page.locator('.linked-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.locator('.linked-panel')).toHaveCount(0);
  await expect(tree.getByRole('treeitem')).toHaveCount(15);
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await page.locator('.tree-view-menu summary').click();
  await page
    .getByRole('button', { name: 'Expand two levels', exact: true })
    .click();
  await expect(issue('CAN-107')).toBeVisible();
  await expect(issue('CAN-108')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Expand all descendants', exact: true })
    .click();
  await issue('CAN-108').getByTitle('Double-click to edit').click();
  await page.getByRole('button', { name: 'Focus selected subtree' }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(
    page.getByRole('navigation', { name: 'Issue ancestry' }),
  ).toContainText('CAN-100');
  await page.getByRole('button', { name: 'Back to root', exact: true }).click();
  await issue('CAN-108').getByTitle('Double-click to edit').click();
  await page
    .getByRole('textbox', { name: 'Find in tree' })
    .fill('no such issue');
  await expect(
    page.getByRole('heading', { name: 'No matching issues' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reveal selection', exact: true })
    .click();
  await expect(issue('CAN-108')).toBeVisible();
  await expect(issue('CAN-108').locator(':scope > .issue-row')).toHaveClass(
    /revealed/,
  );
  await page.getByRole('button', { name: 'Clear tree search' }).click();
  await page.getByLabel('Filter assignee').selectOption('me');
  await expect(issue('CAN-109')).toBeVisible();
  await expect(issue('CAN-108')).toHaveCount(0);
  await page.getByLabel('Filter assignee').selectOption('');
  await page.locator('.tree-view-menu summary').click();

  // Exercise every tree-control path, including partial expansion and saved view restoration.
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true });
  const actions = page.locator('.tree-view-menu summary');
  const searchTree = page.getByRole('textbox', { name: 'Find in tree' });
  await collapse.click();
  await searchTree.fill('unfinished descendants');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  for (const key of ['CAN-100', 'CAN-106', 'CAN-107', 'CAN-108'])
    await expect(issue(key)).toBeVisible();
  await searchTree.press('Escape');
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(
    issue('CAN-100').getByText('3/4 children', { exact: true }),
  ).toHaveAttribute(
    'title',
    '3 open / 4 total direct children; 14 total descendants',
  );

  await expand.click({ modifiers: ['Alt'] });
  await expect(page.locator('.linked-panel')).toBeVisible();
  await collapse.click({ modifiers: ['Alt'] });
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(page.locator('.linked-panel')).toHaveCount(0);
  await expand.dblclick();
  await collapse.dblclick();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(page.locator('.linked-panel')).toHaveCount(0);
  await actions.click();
  await page
    .getByRole('button', {
      name: 'Expand hierarchy and linked issues',
      exact: true,
    })
    .click();
  await expect(page.locator('.linked-panel')).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Collapse hierarchy and linked issues',
      exact: true,
    })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Expand immediate children', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(5);
  await actions.click();
  await collapse.click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expand.click();
  await expect(page.locator('.linked-panel')).toHaveCount(0);
  await issue('CAN-106')
    .getByRole('button', { name: 'Collapse CAN-106', exact: true })
    .click();
  await collapse.click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expand.click();
  await issue('CAN-106').getByTitle('Double-click to edit').first().click();
  await actions.click();
  await page
    .getByRole('button', { name: 'Collapse selected branch', exact: true })
    .click();
  await expect(issue('CAN-107')).toHaveCount(0);
  await expect(issue('CAN-105')).toBeVisible();
  await page
    .getByRole('button', { name: 'Expand selected branch', exact: true })
    .click();
  await expect(issue('CAN-108')).toBeVisible();
  await page
    .getByRole('button', { name: 'Focus selected subtree', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  await page
    .getByRole('navigation', { name: 'Issue ancestry' })
    .getByRole('button', { name: 'CAN-100', exact: true })
    .click();
  await expect(tree.getByRole('treeitem')).toHaveCount(15);
  await actions.click();

  await issue('CAN-109').getByLabel('Edit assignee for CAN-109').click();
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await expect(
    issue('CAN-109').getByText('Unassigned', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter assignee').selectOption('unassigned');
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(issue('CAN-109')).toBeVisible();
  await expect(issue('CAN-108')).toHaveCount(0);
  await page.getByLabel('Filter status').selectOption('todo');
  await page.getByLabel('Filter priority').selectOption('4');
  await expect(issue('CAN-109')).toBeVisible();
  await page.getByLabel('Filter priority').selectOption('1');
  await expect(
    page.getByRole('heading', { name: 'No matching issues' }),
  ).toBeVisible();
  await page.getByLabel('Filter priority').selectOption('4');
  await openIssue('CAN-200');
  await expect(page.getByLabel('Filter assignee')).toHaveValue('');
  await expect(page.getByLabel('Filter status')).toHaveValue('');
  await expect(page.getByLabel('Filter priority')).toHaveValue('');
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await expect(page.getByLabel('Filter assignee')).toHaveValue('unassigned');
  await expect(page.getByLabel('Filter status')).toHaveValue('todo');
  await expect(page.getByLabel('Filter priority')).toHaveValue('4');
  await expect(issue('CAN-109')).toBeVisible();
  await page.getByLabel('Filter assignee').selectOption('');
  await page.getByLabel('Filter status').selectOption('');
  await page.getByLabel('Filter priority').selectOption('');
  await issue('CAN-109').getByLabel('Edit assignee for CAN-109').click();
  await page.getByRole('button', { name: /Alex Morgan/ }).click();

  // Reveal must scroll an off-screen selection into view after both collapse and refresh.
  const originalBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    window.setMinimumSize(800, 480);
    window.setSize(1100, 560);
    return bounds;
  });
  await issue('CAN-114').getByTitle('Double-click to edit').click();
  await expect(
    page.getByRole('navigation', { name: 'Issue ancestry' }),
  ).toContainText('CAN-113');
  expect(
    await page
      .locator('.tree-branch')
      .first()
      .evaluate(
        (element) => getComputedStyle(element, '::before').borderLeftWidth,
      ),
  ).toBe('1px');
  await collapse.click();
  await actions.click();
  await page
    .getByRole('button', { name: 'Reveal selection', exact: true })
    .click();
  await expect(issue('CAN-114').locator(':scope > .issue-row')).toHaveClass(
    /revealed/,
  );
  const selectionInViewport = () =>
    page.evaluate(() => {
      const row = document
        .querySelector('[data-tree-key="CAN-114"] > .issue-row')
        .getBoundingClientRect();
      const viewport = document
        .querySelector('.tree-scroll')
        .getBoundingClientRect();
      return row.top >= viewport.top && row.bottom <= viewport.bottom;
    });
  await expect.poll(selectionInViewport).toBe(true);
  await expand.click();
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(selectionInViewport).toBe(false);
  await page
    .getByRole('button', { name: 'Reveal selection', exact: true })
    .click();
  await expect.poll(selectionInViewport).toBe(true);
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await expect.poll(selectionInViewport).toBe(true);
  await page.getByLabel('Filter priority').focus();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(page.getByLabel('Filter priority')).toBeFocused();
  await issue('CAN-114').getByTitle('Double-click to edit').dblclick();
  const revealedDraft = page.getByLabel('Summary for CAN-114');
  await revealedDraft.fill('Unsaved revealed issue draft');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(revealedDraft).toBeFocused();
  await expect(revealedDraft).toHaveValue('Unsaved revealed issue draft');
  await revealedDraft.press('Escape');
  await page.getByRole('button', { name: 'Back to root', exact: true }).click();
  await expect(issue('CAN-114').locator(':scope > .issue-row')).not.toHaveClass(
    /revealed/,
  );
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBe(0);
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page
    .getByRole('button', { name: 'Reveal selection', exact: true })
    .click();
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBe(0);
  await actions.click();
  await app.evaluate(
    ({ BrowserWindow }, bounds) =>
      BrowserWindow.getAllWindows()[0].setBounds(bounds),
    originalBounds,
  );
  await expand.click();
  await page
    .getByRole('tab', { name: /CAN-200/ })
    .getByRole('button', { name: 'Close CAN-200' })
    .click();

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
  await resizeWindow(600);
  await links.getByRole('button', { name: 'Open tree' }).focus();
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = 100;
  });
  const linkedSourceScroll = await page
    .locator('.tree-scroll')
    .evaluate((element) => element.scrollTop);
  expect(linkedSourceScroll).toBeGreaterThan(0);
  await links.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-200 issue tree' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /CAN-100/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /CAN-200/ })).toBeVisible();

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(issue('CAN-108')).toHaveAttribute('aria-selected', 'true');
  await expect(links.getByText('CAN-200')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBe(linkedSourceScroll);
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('tab', { name: /CAN-200/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );

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

  await resizeWindow(600);
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
  const dividerBounds = await divider.boundingBox();
  await page.mouse.move(
    dividerBounds.x + dividerBounds.width / 2,
    dividerBounds.y + 40,
  );
  await page.mouse.down();
  await page.mouse.move(300, dividerBounds.y + 40);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '300');
  expect((await page.locator('.sidebar').boundingBox()).width).toBe(300);
  await divider.focus();
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '180');
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '190');
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '400');
  // Save a genuinely changed drag order, rather than the original open order.
  await firstTab.dragTo(secondTab);
  await expect(page.getByRole('tab').first()).toContainText('CAN-200');
  await resizeWindow(700);
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
  const pickerInput = page
    .getByRole('dialog')
    .getByLabel('Issue key, Jira URL, or summary');
  await pickerInput.fill('CAN-100');
  await pickerInput.press('Alt+ArrowLeft');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(pickerInput).toHaveValue('CAN-100');
  await pickerInput.fill('');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /CAN-100 A calmer/ })
    .click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await secondTab.click();

  await page.getByLabel('Filter status').selectOption('todo');
  await expect(issue('CAN-202')).toBeVisible();
  await issue('CAN-202').getByTitle('Double-click to edit').click();
  await page.locator('.tree-view-menu summary').click();
  await page.getByRole('button', { name: 'Focus selected subtree' }).click();
  await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(1);

  // Workspace writes are intentionally debounced.
  await page.waitForTimeout(350);
  await close();
  // The preview UI belongs to the preview feature; exercise its saved-width
  // contract through the same workspace file that a resized preview updates.
  const savedWorkspace = JSON.parse(
    await readFile(join(userData, 'workspace.json'), 'utf8'),
  );
  expect(savedWorkspace.previewWidth).toBe(420);
  savedWorkspace.previewWidth = 560;
  await writeFile(
    join(userData, 'workspace.json'),
    JSON.stringify(savedWorkspace),
  );
  await launch();

  await expect(page.getByRole('tab').first()).toContainText('CAN-200');
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
  await expect(page.getByLabel('Filter status')).toHaveValue('todo');
  await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(1);
  await expect(issue('CAN-202')).toBeVisible();
  await page.keyboard.press(paletteShortcut);
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const reloadedWorkspace = await page.evaluate(() =>
    window.canopy.loadWorkspace(),
  );
  expect(reloadedWorkspace.previewWidth).toBe(560);
  for (const [field, value] of [
    ['sidebarWidth', 179],
    ['sidebarWidth', 401],
    ['previewWidth', 299],
    ['previewWidth', 721],
  ]) {
    const error = await page.evaluate(
      async ({ field, value }) => {
        const workspace = await window.canopy.loadWorkspace();
        try {
          await window.canopy.saveWorkspace({ ...workspace, [field]: value });
          return '';
        } catch (error) {
          return error.message;
        }
      },
      { field, value },
    );
    expect(error).toContain('Invalid pane width');
  }
  // Closed destinations can be revisited; forward then returns to the source.
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await page.getByRole('tab', { name: /CAN-200/ }).click();
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'middle' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('tab', { name: /CAN-100/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('tab', { name: /CAN-200/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: /CAN-100/ }).focus();
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect(page.getByRole('tab').first()).toContainText('CAN-100');
  await page.getByRole('tab', { name: /CAN-100/ }).click();
  await expect(page.locator('.linked-panel')).toBeVisible();
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
  await page
    .getByRole('menuitem', { name: 'Open in Jira', exact: true })
    .click();
  await expect(page.locator('.error-banner')).toContainText(
    'Couldn’t open CAN-100:',
  );
  await expect(page.locator('.error-banner')).toContainText(
    'Demo issues exist only in Canopy.',
  );
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy root link' }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'https://example.invalid/browse/CAN-100',
  );
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close others' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await resizeWindow(600);
  await issue('CAN-111').focus();
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = 120;
  });
  const closedScroll = await page
    .locator('.tree-scroll')
    .evaluate((element) => element.scrollTop);
  expect(closedScroll).toBeGreaterThan(0);
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await close();
  await launch();
  await expect(page.getByRole('tab')).toHaveCount(0);
  // A favorite opens a closed root; reopen restores into that existing tab.
  await page
    .getByRole('navigation', { name: 'Pinned roots' })
    .getByRole('button', { name: /CAN-100 A calmer/ })
    .click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
    )
    .toBe(closedScroll);
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

  expect(
    (await page.evaluate(() => window.canopy.loadWorkspace())).previewWidth,
  ).toBe(560);
  await page
    .getByRole('button', { name: 'Unpin CAN-100', exact: true })
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin root', exact: true }).click();
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unpin root', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toHaveCount(0);

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
