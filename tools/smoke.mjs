import { _electron as electron, expect } from '@playwright/test';
import { auditRefresh } from './smoke-refresh.mjs';
import { auditSearch } from './smoke-search.mjs';
import { auditPickers, auditSelfConnections } from './smoke-pickers.mjs';
import { auditWorkflow } from './smoke-workflow.mjs';
import { auditPreview } from './smoke-preview.mjs';
import { auditGithub } from './smoke-github.mjs';
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
const env = {
  ...process.env,
  CANOPY_USER_DATA: userData,
  CANOPY_SMOKE_PREVIEW_FAILURE: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const paletteShortcut =
  process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K';
const paletteShortcutLabel =
  process.platform === 'darwin' ? '⌘⇧K' : 'Ctrl + Shift + K';

let app;
let page;
const pageErrors = [];
const recentOutput = [];
let smokeFailure;
let cleanupFailure;
function recordOutput(source, message) {
  recentOutput.push({
    time: new Date().toISOString(),
    source,
    message: String(message).slice(-2000),
  });
  if (recentOutput.length > 80) recentOutput.shift();
}
async function captureFailure(error) {
  const directory = join(workspace, '.cache', 'smoke-failure');
  await mkdir(directory, { recursive: true });
  const diagnostics = {
    error: error?.stack ?? String(error),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    commit: process.env.GITHUB_SHA,
    pageErrors: pageErrors.map((error) => error.stack ?? String(error)),
    recentOutput,
  };
  if (page && !page.isClosed()) {
    let timeout;
    try {
      diagnostics.window = await Promise.race([
        page.evaluate(() => ({
          url: location.href,
          title: document.title,
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (element) => element.innerText,
          ),
          selectedTabs: [
            ...document.querySelectorAll('[role="tab"][aria-selected="true"]'),
          ].map((element) => element.innerText),
          focusedElement: document.activeElement?.outerHTML.slice(0, 1000),
          visibleText: document.body.innerText.slice(0, 16000),
        })),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Window diagnostics timed out')),
            3000,
          );
        }),
      ]);
    } catch (error) {
      diagnostics.windowError = String(error);
    } finally {
      clearTimeout(timeout);
    }
    try {
      await page.screenshot({
        path: join(directory, 'window.png'),
        timeout: 3000,
      });
    } catch (error) {
      diagnostics.screenshotError = String(error);
    }
  }
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify(diagnostics, null, 2),
  );
  console.error(
    'Smoke failure diagnostics:',
    JSON.stringify(diagnostics, null, 2),
  );
  console.error(`Smoke failure artifacts: ${directory}`);
}

async function launch(production = false, fixtureEnv = {}) {
  app = await electron.launch({
    executablePath,
    args: [production ? join(appPath, 'dist/main.cjs') : appPath],
    env: { ...env, ...fixtureEnv },
  });
  recordOutput('launch', production ? 'production' : 'demo');
  app
    .process()
    .stderr?.on('data', (chunk) => recordOutput('main stderr', chunk));
  app
    .process()
    .stdout?.on('data', (chunk) => recordOutput('main stdout', chunk));
  page = await app.firstWindow();
  page.on('console', (message) =>
    recordOutput(`renderer ${message.type()}`, message.text()),
  );
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

async function setScrollbars(mode) {
  await page.evaluate((mode) => {
    let style = document.getElementById('smoke-scrollbars');
    if (!style) {
      style = document.createElement('style');
      style.id = 'smoke-scrollbars';
      document.head.append(style);
    }
    style.textContent = `.tree-scroll { scrollbar-width: ${mode}; }`;
  }, mode);
}

async function scrollGeometry() {
  return page.locator('.tree-scroll').evaluate((element) => {
    const offset = element.scrollTop;
    // Read Chromium's actual limit; scrollHeight/clientHeight round CSS pixels.
    element.scrollTop = 1e9;
    const maximum = element.scrollTop;
    element.scrollTop = offset;
    return {
      offset,
      maximum,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      viewportHeight: element.getBoundingClientRect().height,
      windowHeight: innerHeight,
      scale: devicePixelRatio,
      errorHeight:
        document.querySelector('.error-banner')?.getBoundingClientRect()
          .height ?? 0,
    };
  });
}

async function openIssue(key, expectTree = true) {
  await page.getByRole('button', { name: 'Open issue' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Open issue tree' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Issue key, Jira URL, or summary').fill(key);
  await dialog.getByRole('button', { name: 'Open tree' }).click();
  await expect(
    expectTree
      ? page.getByRole('tree', { name: `${key} issue tree` })
      : page.getByRole('heading', { name: 'No matching issues' }),
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

async function auditMutations() {
  const key = 'CAN-111';
  const input = () => page.getByLabel(`Summary for ${key}`);
  const summaryCell = () => issue(key).getByTitle(/Double-click to edit/);
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const hold = (id, operation = 'update', issueKey = key) =>
    fixture('hold', id, operation, issueKey);
  const started = (id) => expect.poll(() => fixture('started', id)).toBe(true);
  const release = (id, error) => fixture('release', id, error);
  const saved = (issueKey = key) =>
    expect(page.getByLabel(`Saving ${issueKey}`, { exact: true })).toHaveCount(
      0,
    );
  const edit = async (value) => {
    await summaryCell().press('Enter');
    await input().fill(value);
    await input().press('Enter');
  };
  const switchTab = (root) =>
    page.getByRole('tab', { name: new RegExp(root) }).click();
  const dismissError = async (text) => {
    await expect(page.getByRole('alert')).toContainText(text);
    await page.getByRole('alert').getByRole('button').click();
  };
  const undo = async (name) => {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeEnabled();
    await button.click();
  };
  const baseline = await summaryCell().innerText();
  await app.evaluate(() =>
    globalThis.canopySmoke.blockedTransitions.add('todo'),
  );
  await openIssue('CAN-110');
  await page.getByRole('checkbox', { name: 'Hide done' }).uncheck();

  // Pending and confirmed values propagate to another open tree immediately.
  await hold('summary');
  await edit('Optimistic across tabs');
  await started('summary');
  await expect(summaryCell()).toHaveText('Optimistic across tabs');
  await expect(page.getByLabel(`Saving ${key}`, { exact: true })).toBeVisible();
  await switchTab('CAN-100');
  await expect(summaryCell()).toHaveText('Optimistic across tabs');
  await expect(page.getByLabel(`Saving ${key}`, { exact: true })).toBeVisible();
  await release('summary');
  await saved();
  await undo(`Undo edit to ${key}`);
  await expect(summaryCell()).toHaveText(baseline);
  await switchTab('CAN-110');
  await expect(summaryCell()).toHaveText(baseline);

  // Every picker applies before the request resolves and rolls back on failure.
  await hold('priority');
  await issue(key).getByLabel(`Edit priority for ${key}`).press('Enter');
  await page.getByLabel('Choose value').selectOption({ label: 'Low' });
  await started('priority');
  await expect(issue(key).getByText('Low', { exact: true })).toBeVisible();
  await release('priority', 'Priority permission denied');
  await saved();
  await expect(issue(key).getByRole('alert')).toContainText(
    'Jira rejected this selection',
  );
  await issue(key).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(issue(key).getByText('Highest', { exact: true })).toBeVisible();
  await dismissError('Priority permission denied');

  await hold('assignee');
  await issue(key).getByLabel(`Edit assignee for ${key}`).press('Enter');
  await page.getByLabel('Search assignees').press('ArrowDown');
  await expect(
    page.getByRole('button', { name: 'Assign to me', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('button', { name: 'Unassigned', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await started('assignee');
  await expect(
    issue(key).getByText('Unassigned', { exact: true }),
  ).toBeVisible();
  await release('assignee', 'Assignee permission denied');
  await saved();
  await expect(issue(key).getByRole('alert')).toContainText(
    'Jira rejected this selection',
  );
  await issue(key).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    issue(key).getByText('Sam Rivera', { exact: true }),
  ).toBeVisible();
  await dismissError('Assignee permission denied');

  await hold('status');
  await issue(key).getByLabel(`Edit status for ${key}`).press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'To Do Requires fields', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('menuitem', { name: 'In Progress', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    page.getByRole('menuitem', {
      name: `Open ${key} in Jira for To Do`,
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    page.getByRole('menuitem', { name: 'Done', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await started('status');
  await expect(issue(key).getByText('Done', { exact: true })).toBeVisible();
  await release('status', 'Workflow changed');
  await saved();
  await expect(issue(key).getByRole('alert')).toContainText(
    'Jira rejected this selection',
  );
  await issue(key).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    issue(key).getByText('In Progress', { exact: true }),
  ).toBeVisible();
  await dismissError('Workflow changed');

  // Status undo revalidates the current reverse transition.
  await issue(key).getByLabel(`Edit status for ${key}`).press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'In Progress', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await saved();
  await expect(issue(key).getByText('Done', { exact: true })).toBeVisible();
  await undo(`Undo edit to ${key}`);
  await expect(
    issue(key).getByText('In Progress', { exact: true }),
  ).toBeVisible();

  // A rejection after navigating away must not install an invisible editor that blocks refresh.
  await hold('navigated-priority');
  await issue(key).getByLabel(`Edit priority for ${key}`).press('Enter');
  await page.getByLabel('Choose value').selectOption({ label: 'Low' });
  await started('navigated-priority');
  await switchTab('CAN-200');
  await release('navigated-priority', 'Navigated picker rejection');
  await saved();
  await dismissError('Navigated picker rejection');
  await hold('navigated-refresh', 'tree', 'CAN-200');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started('navigated-refresh');
  await release('navigated-refresh');
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await switchTab('CAN-110');

  // A failed earlier write cannot erase a queued newer edit or its pending UI.
  await hold('first');
  await hold('second');
  await edit('First pending');
  await started('first');
  await edit('Newest pending');
  await expect(summaryCell()).toHaveText('Newest pending');
  await switchTab('CAN-100');
  await expect(summaryCell()).toHaveText('Newest pending');
  await release('first', 'First edit rejected');
  await started('second');
  await expect(summaryCell()).toHaveText('Newest pending');
  await expect(page.getByLabel(`Saving ${key}`, { exact: true })).toBeVisible();
  await dismissError('First edit rejected');
  await release('second');
  await saved();
  await expect(summaryCell()).toHaveText('Newest pending');

  // A response must not close a later active draft; focus refresh preserves it.
  await hold('under-draft');
  await edit('Confirmed under draft');
  await started('under-draft');
  await summaryCell().press('Enter');
  await input().fill('Unsaved active draft');
  await release('under-draft');
  await saved();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(input()).toHaveValue('Unsaved active draft');
  await expect(input()).toBeFocused();
  await input().press('Escape');
  await expect(summaryCell()).toHaveText('Confirmed under draft');

  await hold('failed-under-draft');
  await edit('Will fail below draft');
  await started('failed-under-draft');
  await summaryCell().press('Enter');
  await input().fill('Draft survives failure');
  await release('failed-under-draft', 'Draft predecessor rejected');
  await saved();
  await expect(input()).toHaveValue('Draft survives failure');
  await expect(input()).toBeFocused();
  await input().press('Escape');
  await expect(summaryCell()).toHaveText('Confirmed under draft');
  await dismissError('Draft predecessor rejected');

  // An older refresh response cannot overwrite a mutation completed after it began.
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await hold('stale-tree', 'tree', 'CAN-100');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started('stale-tree');
  await edit('Saved after refresh began');
  await saved();
  await release('stale-tree');
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(summaryCell()).toHaveText('Saved after refresh began');
  await switchTab('CAN-110');
  await expect(summaryCell()).toHaveText('Saved after refresh began');

  // An already-running refresh is also deferred when a draft opens afterward.
  await hold('draft-tree', 'tree', 'CAN-110');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started('draft-tree');
  await summaryCell().press('Enter');
  await input().fill('Draft above old refresh');
  await release('draft-tree');
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await expect(input()).toHaveValue('Draft above old refresh');
  await expect(input()).toBeFocused();
  await input().press('Escape');

  // Row Enter, cell traversal in both directions, cancel, and native text undo.
  await issue(key).focus();
  await page.keyboard.press('Enter');
  await expect(input()).toBeFocused();
  await expect(issue(key)).toHaveAttribute('aria-selected', 'true');
  await input().press('Tab');
  await expect(page.getByLabel('Choose value')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Search assignees')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('menuitem', { name: 'In Progress', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Search assignees')).toBeFocused();
  await page.keyboard.press('Escape');
  await summaryCell().press('Enter');
  await input().press('End');
  await input().pressSequentially('x');
  await input().press(`${modifier}+z`);
  await expect(input()).toHaveValue('Saved after refresh began');
  await input().press('Escape');
  await expect(summaryCell()).toHaveText('Saved after refresh began');

  // Tab crosses row boundaries and keeps the newly edited row in view.
  await issue('CAN-112').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(input()).toBeFocused();
  await expect(input()).toBeInViewport();
  await page.keyboard.press('Shift+Tab');
  await expect(
    issue('CAN-112').getByRole('menuitem', {
      name: 'In Progress',
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Escape');

  // Optimistic ranks roll back across tabs, and a successful rank has an inverse.
  await hold('rank-fail', 'rank');
  await page
    .getByRole('button', { name: /Reorder CAN-111/ })
    .press('Alt+ArrowUp');
  await started('rank-fail');
  await expectIssueBefore('CAN-111', 'CAN-112');
  await switchTab('CAN-100');
  await expectIssueBefore('CAN-111', 'CAN-112');
  await release('rank-fail', 'Rank permission denied');
  await saved();
  await expectIssueBefore('CAN-112', 'CAN-111');
  await dismissError('Rank permission denied');
  await page
    .getByRole('button', { name: /Reorder CAN-111/ })
    .press('Alt+ArrowUp');
  await saved();
  await expectIssueBefore('CAN-111', 'CAN-112');
  await undo(`Undo reorder of ${key}`);
  await expectIssueBefore('CAN-112', 'CAN-111');

  // Remote changes prevent undo from overwriting someone else's work.
  await edit('Local before remote');
  await saved();
  await fixture('remoteUpdate', key, { summary: 'Remote writer wins' });
  await undo(`Undo edit to ${key}`);
  await dismissError('The field changed in Jira');
  expect((await fixture('tree', key)).issues[0].summary).toBe(
    'Remote writer wins',
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(summaryCell()).toHaveText('Remote writer wins');
  await fixture('remoteUpdate', key, { summary: baseline });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(summaryCell()).toHaveText(baseline);
  console.log(
    'Optimistic mutation audit passed: pending, failures, rapid edits, overlapping trees/refreshes, keyboard pickers, and validated undo.',
  );
}

async function auditMutationViews() {
  const key = 'CAN-111';
  const fixture = (method, ...args) =>
    app.evaluate(
      (_electron, { method, args }) => globalThis.canopySmoke[method](...args),
      { method, args },
    );
  const hold = (id, operation = 'update', target = key) =>
    fixture('hold', id, operation, target);
  const started = (id) => expect.poll(() => fixture('started', id)).toBe(true);
  const release = (id, error) => fixture('release', id, error);
  const saved = () =>
    expect(page.getByLabel(`Saving ${key}`, { exact: true })).toHaveCount(0);
  const summary = () => issue(key).getByTitle(/Double-click to edit/);
  const input = () => page.getByLabel(`Summary for ${key}`);
  const view = async (fn) => {
    if (!(await page.getByRole('group', { name: 'Table view' }).isVisible()))
      await page.locator('.view-settings > summary').click();
    await fn();
    await page.locator('.view-settings > summary').click();
  };
  await openIssue('CAN-110');
  await page.getByLabel('Filter status').selectOption('');
  await page.getByLabel('Filter priority').selectOption('');
  await page.getByLabel('Filter assignee').selectOption('');
  await page
    .getByRole('checkbox', { name: 'Hide done', exact: true })
    .uncheck();
  await view(async () => {
    await page.getByLabel('Show Status column').check();
    await page.getByLabel('Show Assignee column').check();
    await page.getByLabel('Show Priority column').uncheck();
    while (await page.getByLabel('Move Status column left').isEnabled())
      await page.getByLabel('Move Status column left').click();
    await page.getByLabel('Sort by', { exact: true }).selectOption('issue');
  });
  await expectIssueBefore('CAN-111', 'CAN-112');
  await summary().press('Enter');
  await input().press('Tab');
  await expect(issue(key).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Search assignees')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Summary for CAN-112')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Search assignees')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Choose value')).toHaveCount(0);

  // A sorted row stays put while saving, and its newer draft survives settlement.
  const original = await summary().innerText();
  await hold('sorted-edit');
  await summary().press('Enter');
  await input().fill('ZZZ moves after its sibling');
  await input().press('Enter');
  await started('sorted-edit');
  await expectIssueBefore('CAN-111', 'CAN-112');
  await summary().press('Enter');
  await input().fill('Keep this draft');
  await release('sorted-edit');
  await saved();
  await expect(input()).toHaveValue('Keep this draft');
  await expect(input()).toBeFocused();
  await expectIssueBefore('CAN-111', 'CAN-112');
  await input().press('Escape');
  await expectIssueBefore('CAN-112', 'CAN-111');
  await fixture('remoteUpdate', key, { summary: original });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(summary()).toHaveText(original);

  // Matching filters and Hide done retain a pending issue and a later draft only.
  await page.getByLabel('Filter status').selectOption('progress');
  await page.getByRole('checkbox', { name: 'Hide done', exact: true }).check();
  await expect(issue('CAN-112')).toHaveCount(0);
  await hold('filtered-edit');
  await issue(key).getByLabel(`Edit status for ${key}`).click();
  await page.getByRole('menuitem', { name: 'Done', exact: true }).click();
  await started('filtered-edit');
  await expect(issue(key).getByText('Done', { exact: true })).toBeVisible();
  await summary().press('Enter');
  await input().fill('Draft in filtered row');
  await release('filtered-edit');
  await saved();
  await expect(input()).toHaveValue('Draft in filtered row');
  await expect(input()).toBeFocused();
  await expect(issue('CAN-112')).toHaveCount(0);
  await input().press('Escape');
  await expect(issue(key)).toHaveCount(0);
  await page.getByLabel('Filter status').selectOption('');
  await page
    .getByRole('checkbox', { name: 'Hide done', exact: true })
    .uncheck();
  await fixture('remoteUpdate', key, { transitionId: 'progress' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    issue(key).getByText('In Progress', { exact: true }),
  ).toBeVisible();

  // Undo rank remains available while another display sort disables direct ranking.
  await view(async () =>
    page.getByLabel('Sort by', { exact: true }).selectOption('rank'),
  );
  await expectIssueBefore('CAN-112', 'CAN-111');
  await page
    .getByRole('button', { name: /Reorder CAN-111/ })
    .press('Alt+ArrowUp');
  await saved();
  await expectIssueBefore('CAN-111', 'CAN-112');
  await view(async () =>
    page.getByLabel('Sort by', { exact: true }).selectOption('issue'),
  );
  await expect(
    page.getByRole('button', { name: /Reorder CAN-111/ }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: `Undo reorder of ${key}`, exact: true })
    .click();
  await saved();
  await expect
    .poll(async () =>
      (await fixture('tree', 'CAN-110')).issues
        .filter((value) => value.parentKey === 'CAN-110')
        .map((value) => value.key),
    )
    .toEqual(['CAN-112', 'CAN-111']);
  await view(async () =>
    page.getByLabel('Sort by', { exact: true }).selectOption('rank'),
  );
  await page
    .getByRole('button', { name: /Reorder CAN-111/ })
    .press('Alt+ArrowUp');
  await saved();
  const rankCalls = await app.evaluate(
    () =>
      globalThis.canopySmoke.calls.filter((call) => call.operation === 'rank')
        .length,
  );
  await app.evaluate(() => {
    globalThis.canopySmoke.rankingState = 'unknown';
  });
  await page
    .getByRole('button', { name: `Undo reorder of ${key}`, exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Ranking is no longer available',
  );
  expect(
    await app.evaluate(
      () =>
        globalThis.canopySmoke.calls.filter((call) => call.operation === 'rank')
          .length,
    ),
  ).toBe(rankCalls);
  await page.getByRole('alert').getByRole('button').click();
  await app.evaluate(() => {
    globalThis.canopySmoke.rankingState = undefined;
  });

  // Closing and reopening a tab while both a write and older refresh are pending
  // must restore its view and ignore the old request's completion.
  await expect(page.getByText('Checking for changes')).toBeHidden();
  await hold('closed-tree', 'tree', 'CAN-110');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started('closed-tree');
  await hold('closed-write');
  await summary().press('Enter');
  await input().fill('Saved after reopening');
  await input().press('Enter');
  await started('closed-write');
  await page
    .getByRole('button', { name: 'Close CAN-110', exact: true })
    .click();
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(
    page.getByRole('tree', { name: 'CAN-110 issue tree' }),
  ).toHaveCount(0);
  await hold('reopened-tree', 'tree', 'CAN-110');
  await release('closed-write');
  await started('reopened-tree');
  await expect(page.getByText('Checking for changes')).toBeVisible();
  await release('closed-tree');
  // The older generation cannot resurrect its snapshot or clear the new load.
  await expect(
    page.getByRole('tree', { name: 'CAN-110 issue tree' }),
  ).toHaveCount(0);
  await expect(page.getByText('Checking for changes')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeDisabled();
  await release('reopened-tree');
  await expect(
    page.getByRole('tree', { name: 'CAN-110 issue tree' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sort by Priority', exact: true }),
  ).toHaveCount(0);
  await expect(summary()).toHaveText('Saved after reopening');
  await saved();
  await expect(page.getByText('Checking for changes')).toBeHidden();
  console.log(
    'Mutation/table/workspace integration passed: visible columns, sorted and filtered drafts, rank capability, and pending close/reopen.',
  );
}

try {
  await rm(join(workspace, '.cache', 'smoke-failure'), {
    recursive: true,
    force: true,
  });
  await launch();
  if (process.env.CANOPY_SMOKE_TEST_DIAGNOSTICS === '1') {
    await page.evaluate(() => {
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = 'Injected smoke diagnostic failure';
      document.body.append(alert);
      console.error('Injected renderer diagnostic');
    });
    throw new Error('Injected smoke diagnostic failure');
  }
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
  await expect(page.locator('.identity-hint')).toContainText(
    'Temporary identity failure',
  );
  await page
    .getByRole('button', { name: 'Edit assignee for CAN-100', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Assign to me', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Search assignees').press('Escape');
  await page.getByRole('button', { name: 'Retry account lookup' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry account lookup' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Filter assignee').locator('option[value="me"]'),
  ).toBeEnabled();
  const tree = page.getByRole('tree', { name: 'CAN-100 issue tree' });
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  await auditPickers(app, page);
  await auditSelfConnections(app, page);
  const rootSummary = 'A calmer place to get things done';
  const rootTitle = `CAN-100: ${rootSummary} · Canopy demo`;
  const rootTab = page.locator(`[role="tab"][title="${rootTitle}"]`);
  const rootSidebar = page.locator(`.side-tab[title="${rootTitle}"]`);
  for (const label of [rootTab, rootSidebar]) {
    await expect(label).toHaveAttribute('title', rootTitle);
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

  expect(
    await app.evaluate(() => globalThis.canopyPreviewTest.requests),
  ).toEqual([]);

  // Preview leaves the tree mounted and keeps its selection, focus, and scroll.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1240, 600),
  );
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollTop = 120;
  });
  await issue('CAN-108').focus();
  const scrollBeforePreview = await page
    .locator('.tree-scroll')
    .evaluate((element) => element.scrollTop);
  expect(scrollBeforePreview).toBeGreaterThan(0);
  await page.keyboard.press('Space');
  const preview = page.getByRole('complementary', {
    name: 'Preview CAN-108',
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByText('Comments temporarily unavailable.'),
  ).toBeVisible();
  await expect(
    preview.getByText('Details for CAN-108.', { exact: false }),
  ).toBeVisible();
  await preview.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.getByText('Retrying comments…')).toBeVisible();
  await expect(
    preview.getByText('Details for CAN-108.', { exact: false }),
  ).toBeVisible();
  await expect(preview.getByText('Ready for review.')).toBeVisible();
  await expect(
    preview.getByText('CAN-108 blocks', { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText('CAN-108 is blocked by', { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole('heading', {
      name: 'Linked issue references',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    preview.getByText(/separate from hierarchy children/),
  ).toBeVisible();
  await expect(tree.getByRole('treeitem')).toHaveCount(15);
  await expect(issue('CAN-200')).toHaveCount(0);
  await mkdir(join(workspace, '.cache'), { recursive: true });
  await page.screenshot({
    path: join(workspace, '.cache', 'preview.png'),
    fullPage: true,
  });
  await expect(issue('CAN-108')).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
  ).toBe(scrollBeforePreview);
  await preview.getByRole('button', { name: /Preview CAN-200:/ }).click();
  await expect(
    page.getByRole('complementary', { name: 'Preview CAN-200', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(issue('CAN-108')).toBeFocused();
  expect(
    await page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
  ).toBe(scrollBeforePreview);
  await page.keyboard.press('Space');
  await expect(preview).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('complementary', { name: 'Preview CAN-109', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Shift+F10');
  const rowMenu = page.getByRole('menu', { name: 'Actions for CAN-109' });
  await expect(rowMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rowMenu).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: 'Preview CAN-109', exact: true }),
  ).toBeVisible();
  await expect(issue('CAN-109')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await rowMenu
    .getByRole('menuitem', { name: 'Copy key', exact: true })
    .click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'CAN-109',
  );
  await page.keyboard.press('Shift+F10');
  await rowMenu
    .getByRole('menuitem', { name: 'Copy title', exact: true })
    .click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'Add linked issue references',
  );
  await page.keyboard.press('Shift+F10');
  await rowMenu
    .getByRole('menuitem', { name: 'Copy link', exact: true })
    .click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'https://example.invalid/browse/CAN-109',
  );
  // All entry points expose the same menu and its keyboard navigation.
  await issue('CAN-109').locator('.summary').click({ button: 'right' });
  await expect(
    rowMenu.getByRole('menuitem', { name: 'Copy key', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    rowMenu.getByRole('menuitem', { name: 'Open in Jira', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    rowMenu.getByRole('menuitem', { name: 'Copy key', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('.error-banner')).toContainText(
    'Demo issues exist only in Canopy.',
  );
  await expect(issue('CAN-109')).toBeFocused();
  await issue('CAN-109')
    .getByRole('button', { name: 'Actions for CAN-109', exact: true })
    .click();
  await expect(rowMenu).toBeVisible();
  const rowTrigger = issue('CAN-109').getByRole('button', {
    name: 'Actions for CAN-109',
    exact: true,
  });
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'true');
  await rowTrigger.locator('svg').click();
  await expect(rowMenu).toBeHidden();
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');
  await rowTrigger.press('Enter');
  await expect(rowMenu).toBeVisible();
  await rowTrigger.press('Space');
  await expect(rowMenu).toBeHidden();
  await rowTrigger.click();
  const otherTrigger = issue('CAN-108').getByRole('button', {
    name: 'Actions for CAN-108',
    exact: true,
  });
  await otherTrigger.click();
  await expect(
    page.getByRole('menu', { name: 'Actions for CAN-108' }),
  ).toBeVisible();
  await expect(rowMenu).toBeHidden();
  await expect(otherTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');
  await rowTrigger.press('Enter');
  await expect(
    rowMenu.getByRole('menuitem', { name: 'Copy key', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rowMenu).toBeHidden();
  await expect(issue('CAN-109')).toBeFocused();
  const title = issue('CAN-109').locator('.summary');
  // Force truncation independently of platform fonts and window geometry.
  const previousMaxWidth = await title.evaluate((element) => {
    const previous = element.style.maxWidth;
    element.style.maxWidth = '80px';
    return previous;
  });
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  await expect(title).toHaveCSS('overflow', 'hidden');
  await expect(title).toHaveCSS('white-space', 'nowrap');
  await expect(title).toHaveAttribute(
    'title',
    'Add linked issue references — Double-click to edit',
  );
  await expect(title).toHaveAccessibleName('Add linked issue references');
  await expect(issue('CAN-109')).toHaveAccessibleName(
    'CAN-109: Add linked issue references',
  );
  expect(
    await title.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await title.evaluate((element, value) => {
    element.style.maxWidth = value;
  }, previousMaxWidth);

  const resize = page.getByRole('separator', { name: 'Resize issue preview' });
  await resize.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '440');
  const resizeBox = await resize.boundingBox();
  await page.mouse.move(resizeBox.x + 3, resizeBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x - 27, resizeBox.y + 30);
  await page.mouse.up();
  await expect(resize).toHaveAttribute('aria-valuenow', '470');
  await resize.focus();
  await page.keyboard.press('End');
  await expect(resize).toHaveAttribute('aria-valuenow', '720');
  const paneBox = await page.locator('.issue-preview').boundingBox();
  const contentBox = await page.locator('.tree-with-preview').boundingBox();
  expect(paneBox.width).toBeLessThanOrEqual(contentBox.width - 120);
  await page.keyboard.press('Home');
  for (let step = 0; step < 7; step++) await page.keyboard.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '440');

  await page.keyboard.press('Escape');
  await expect(issue('CAN-109')).toBeFocused();
  await expect(page.locator('.issue-preview')).toHaveCount(0);
  await issue('CAN-109')
    .getByRole('button', { name: 'Add linked issue references', exact: true })
    .focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.issue-preview')).toHaveCount(0);

  // Customized wide columns retain horizontal and vertical position across menus/previews.
  const issueColumnResize = page.getByRole('separator', {
    name: 'Resize Issue column',
  });
  const initialIssueWidth = Number(
    await issueColumnResize.getAttribute('aria-valuenow'),
  );
  for (let step = 0; step < 40; step++)
    await issueColumnResize.press('ArrowRight');
  await expect(issueColumnResize).toHaveAttribute(
    'aria-valuenow',
    String(initialIssueWidth + 400),
  );
  await issue('CAN-109').focus();
  await page.keyboard.press('Space');
  await page.locator('.tree-scroll').evaluate((element) => {
    element.scrollLeft = 100;
    element.scrollTop = 120;
  });
  const scrolledPosition = await page
    .locator('.tree-scroll')
    .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }));
  expect(scrolledPosition.x).toBeGreaterThan(0);
  expect(scrolledPosition.y).toBeGreaterThan(0);
  await page.keyboard.press('Shift+F10');
  await expect(rowMenu).toBeVisible();
  await page.keyboard.press('Escape');
  expect(
    await page
      .locator('.tree-scroll')
      .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop })),
  ).toEqual(scrolledPosition);
  await page.keyboard.press('Escape');
  await expect(page.locator('.issue-preview')).toHaveCount(0);
  expect(
    await page
      .locator('.tree-scroll')
      .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop })),
  ).toEqual(scrolledPosition);
  for (let step = 0; step < 40; step++)
    await issueColumnResize.press('ArrowLeft');
  await expect(issueColumnResize).toHaveAttribute(
    'aria-valuenow',
    String(initialIssueWidth),
  );

  // A late request must never replace a newly selected preview or reopen a closed pane.
  await app.evaluate(() => {
    globalThis.canopyPreviewTest.hold = ['CAN-101'];
  });
  await issue('CAN-101').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.issue-preview')).toContainText(
    'Loading issue preview…',
  );
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(globalThis.canopyPreviewTest.release['CAN-101']),
      ),
    )
    .toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.issue-preview h2')).toHaveText(
    'Design the navigation shell',
  );
  await app.evaluate(() => globalThis.canopyPreviewTest.release['CAN-101']());
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.canopyPreviewTest.completed.includes('CAN-101'),
      ),
    )
    .toBe(true);
  await expect(page.locator('.issue-preview h2')).toHaveText(
    'Design the navigation shell',
  );
  await page.keyboard.press('Escape');
  await app.evaluate(() => {
    globalThis.canopyPreviewTest.hold = ['CAN-103'];
    globalThis.canopyPreviewTest.completed = [];
  });
  await issue('CAN-103').focus();
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(globalThis.canopyPreviewTest.release['CAN-103']),
      ),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await app.evaluate(() => globalThis.canopyPreviewTest.release['CAN-103']());
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.canopyPreviewTest.completed.includes('CAN-103'),
      ),
    )
    .toBe(true);
  await expect(page.locator('.issue-preview')).toHaveCount(0);
  await expect(issue('CAN-103')).toBeFocused();

  // Full fetch errors can retry into explicit empty states without editable controls.
  await app.evaluate(() => {
    globalThis.canopyPreviewTest.hold = [];
    globalThis.canopyPreviewTest.fail = ['CAN-103'];
  });
  await page.keyboard.press('Space');
  await expect(page.locator('.issue-preview')).toContainText(
    'Preview temporarily unavailable.',
  );
  await app.evaluate(() => {
    globalThis.canopyPreviewTest.fail = [];
    globalThis.canopyPreviewTest.empty = ['CAN-103'];
  });
  await page
    .locator('.issue-preview')
    .getByRole('button', { name: 'Retry', exact: true })
    .click();
  await expect(page.locator('.issue-preview')).toContainText('No description.');
  await expect(page.locator('.issue-preview')).toContainText('No comments.');
  await expect(page.locator('.issue-preview')).toContainText(
    'No linked issue references.',
  );
  await expect(
    page.locator(
      '.issue-preview input, .issue-preview textarea, .issue-preview [contenteditable=true]',
    ),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

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
  await issue('CAN-108')
    .getByTitle(/Double-click to edit/)
    .click();
  await page.getByRole('button', { name: 'Focus selected subtree' }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(
    page.getByRole('navigation', { name: 'Issue ancestry' }),
  ).toContainText('CAN-100');
  await page.getByRole('button', { name: 'Back to root', exact: true }).click();
  await issue('CAN-108')
    .getByTitle(/Double-click to edit/)
    .click();
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
  await issue('CAN-106')
    .getByTitle(/Double-click to edit/)
    .first()
    .click();
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
  await issue('CAN-114')
    .getByTitle(/Double-click to edit/)
    .click();
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
  await issue('CAN-114')
    .getByTitle(/Double-click to edit/)
    .dblclick();
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
  await issue('CAN-111')
    .getByTitle(/Double-click to edit/)
    .dblclick();
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

  // Enter edits a focused summary; Escape cancels without saving on blur.
  await issue('CAN-111')
    .getByTitle(/Double-click to edit/)
    .press('Enter');
  await summaryInput.fill('Cancelled draft');
  await summaryInput.press('Escape');
  await expect(issue('CAN-111').getByText(summary)).toBeVisible();
  await issue('CAN-111')
    .getByTitle(/Double-click to edit/)
    .press('Enter');
  await summaryInput.fill('Keyboard draft');
  await summaryInput.press('Tab');
  await expect(page.getByLabel('Choose value')).toBeFocused();
  await page.getByLabel('Choose value').press('Escape');
  await expect(issue('CAN-111').getByText('Keyboard draft')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo edit to CAN-111' }),
  ).toBeEnabled();
  await page.keyboard.press(`${modifier}+z`);
  await expect(issue('CAN-111').getByText(summary)).toBeVisible();

  await mkdir(join(workspace, '.cache'), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const linkedIssue = tree.getByTitle('1 linked issue');
  await linkedIssue.click();
  const links = linkedIssue.locator(
    'xpath=ancestor::div[contains(@class,"issue-row")]/following-sibling::div[contains(@class,"linked-panel")]',
  );
  await expect(links.getByText('CAN-200')).toBeVisible();
  await issue('CAN-108').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.issue-preview')).toBeVisible();
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
  await expect(page.locator('.issue-preview')).toHaveCount(0);
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
    .getByRole('option', { name: /CAN-100 A calmer/ })
    .click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await secondTab.click();

  await page.getByLabel('Filter status').selectOption('todo');
  await expect(issue('CAN-202')).toBeVisible();
  await issue('CAN-202')
    .getByTitle(/Double-click to edit/)
    .click();
  await page.locator('.tree-view-menu summary').click();
  await page.getByRole('button', { name: 'Focus selected subtree' }).click();
  await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(1);
  await page.getByLabel('Filter priority').selectOption('3');
  await page.getByRole('textbox', { name: 'Find in tree' }).fill('arrow keys');
  await secondTab.click({ button: 'middle' });
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Filter status')).toHaveValue('todo');
  await expect(page.getByLabel('Filter priority')).toHaveValue('3');
  await expect(page.getByRole('textbox', { name: 'Find in tree' })).toHaveValue(
    '',
  );
  await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(1);
  await expect(issue('CAN-202')).toHaveAttribute('aria-selected', 'true');
  // History restores its captured filtered subtree, rather than a later edit to that tab.
  await firstTab.click();
  await secondTab.click();
  await page.getByLabel('Filter status').selectOption('');
  await page.getByLabel('Filter priority').selectOption('');
  await page.getByRole('button', { name: 'Back to root', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Filter status')).toHaveValue('todo');
  await expect(page.getByLabel('Filter priority')).toHaveValue('3');
  await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(1);
  await expect(issue('CAN-202')).toHaveAttribute('aria-selected', 'true');
  // Restore the previously saved drag order after reopening appended the tab.
  await secondTab.dragTo(firstTab);

  // Workspace writes are intentionally debounced.
  await page.waitForTimeout(350);
  await close();
  // A resized preview persists its width; loaded workspace widths are honored.
  const savedWorkspace = JSON.parse(
    await readFile(join(userData, 'workspace.json'), 'utf8'),
  );
  expect(savedWorkspace.previewWidth).toBe(440);
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
  await issue('CAN-110').focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('separator', { name: 'Resize issue preview' }),
  ).toHaveAttribute('aria-valuenow', '560');
  await page
    .getByRole('button', { name: 'Close issue preview', exact: true })
    .click();
  await expect(issue('CAN-110')).toBeFocused();
  await expect(issue('CAN-111').getByText(summary)).toBeVisible();
  await expect(issue('CAN-111').getByText('Highest')).toBeVisible();
  await expect(issue('CAN-111').getByText('Sam Rivera')).toBeVisible();
  await expect(issue('CAN-111').getByText('In Progress')).toBeVisible();
  await expectIssueBefore('CAN-112', 'CAN-111');

  await auditMutations();

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
  // The earlier error assertion is complete. Its banner is transient across
  // restart, so remove it before testing restoration under an unchanged layout.
  await page.locator('.error-banner button').click();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  // Exercise the gutter-free geometry used by overlay scrollbars on macOS.
  await setScrollbars('none');
  await issue('CAN-111').focus();
  const beforeClose = await scrollGeometry();
  expect(beforeClose.maximum, JSON.stringify(beforeClose)).toBeGreaterThan(2);
  await page.locator('.tree-scroll').evaluate(
    (element, target) => {
      element.scrollTop = target;
    },
    Math.min(120, Math.floor(beforeClose.maximum / 2)),
  );
  const closedScroll = await page
    .locator('.tree-scroll')
    .evaluate((element) => element.scrollTop);
  expect(closedScroll).toBeGreaterThan(0);
  expect(beforeClose.maximum - closedScroll).toBeGreaterThanOrEqual(
    closedScroll,
  );
  // Setting scrollTop queues a browser scroll event. Wait for the renderer's
  // saved view before closing so the fixture does not race that event.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const workspace = await window.canopy.loadWorkspace();
        return workspace.tabs.find((tab) => tab.rootKey === 'CAN-100')
          ?.scrollTop;
      }),
    )
    .toBe(closedScroll);
  const restoreSnapshot = await page.evaluate(() =>
    window.canopy.tree('demo', 'CAN-100'),
  );
  await page.getByRole('tab', { name: /CAN-100/ }).click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const workspace = await window.canopy.loadWorkspace();
        return workspace.closedTabs.find((tab) => tab.rootKey === 'CAN-100')
          ?.scrollTop;
      }),
    )
    .toBe(closedScroll);
  await expect(
    page.getByRole('navigation', { name: 'Pinned roots' }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await close();
  await launch();
  await setScrollbars('none');
  await expect(page.getByRole('tab')).toHaveCount(0);
  // Hold the initial tree response to cover restoration into a still-loading favorite.
  await app.evaluate(({ ipcMain }, snapshot) => {
    let release;
    const loaded = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.releaseRestoreTree = release;
    ipcMain.removeHandler('canopy:tree');
    ipcMain.handle('canopy:tree', async (_event, connectionId, rootKey) => {
      if (connectionId !== 'demo' || rootKey !== snapshot.rootKey)
        throw new Error('Unexpected root in delayed restoration fixture');
      await loaded;
      return snapshot;
    });
  }, restoreSnapshot);
  // A favorite opens a closed root; reopen restores into that existing tab.
  await page
    .getByRole('navigation', { name: 'Pinned roots' })
    .getByRole('button', { name: /CAN-100 A calmer/ })
    .click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.keyboard.press(`${modifier}+Shift+t`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const workspace = await window.canopy.loadWorkspace();
        const restored = workspace.tabs.find(
          (tab) => tab.rootKey === 'CAN-100',
        );
        return {
          selectedKey: restored?.selectedKey,
          scrollTop: restored?.scrollTop,
        };
      }),
    )
    .toEqual({ selectedKey: 'CAN-111', scrollTop: closedScroll });
  // A loading placeholder can emit scroll events while the saved tree is absent.
  await page.locator('.tree-scroll').dispatchEvent('scroll');
  // Allow the 180ms persistence debounce to expose any overwrite rather than
  // accepting a stale saved value from before the placeholder event.
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const workspace = await window.canopy.loadWorkspace();
        return workspace.tabs.find((tab) => tab.rootKey === 'CAN-100')
          ?.scrollTop;
      }),
    )
    .toBe(closedScroll);
  await app.evaluate(() => globalThis.releaseRestoreTree());
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  const afterRestore = await scrollGeometry();
  const restoreGeometry = JSON.stringify({
    beforeClose,
    afterRestore,
    closedScroll,
  });
  expect(closedScroll, restoreGeometry).toBeLessThanOrEqual(
    afterRestore.maximum,
  );
  await expect
    .poll(
      () =>
        page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
      { message: restoreGeometry },
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

  // A saved offset can become infeasible when the viewport grows. Reopening
  // must restore to the native maximum, not to zero or the old unreachable value.
  for (const scrollbarMode of ['auto', 'none']) {
    await setScrollbars(scrollbarMode);
    const normal = await scrollGeometry();
    await page.locator('.tree-scroll').evaluate((element) => {
      element.style.flex = '0 0 120px';
      element.style.maxHeight = '120px';
      element.scrollTop = 1e9;
    });
    const narrowed = await scrollGeometry();
    expect(
      narrowed.offset,
      JSON.stringify({ scrollbarMode, normal, narrowed }),
    ).toBeGreaterThan(normal.maximum);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.canopy.loadWorkspace()).tabs.find(
              (tab) => tab.rootKey === 'CAN-100',
            )?.scrollTop,
        ),
      )
      .toBe(narrowed.offset);
    await page
      .getByRole('tab', { name: /CAN-100/ })
      .click({ button: 'middle' });
    await expect(page.getByRole('tab')).toHaveCount(0);
    // Native scroll events may be coalesced while restoration is guarded.
    // Persisting the clamped offset must not depend on receiving that event.
    await page.evaluate(() => {
      window.suppressRestoreScroll = (event) => {
        if (
          event.target instanceof Element &&
          event.target.matches('.tree-scroll')
        )
          event.stopImmediatePropagation();
      };
      window.addEventListener('scroll', window.suppressRestoreScroll, true);
    });
    await page.keyboard.press(`${modifier}+Shift+t`);
    await expect(
      page.getByRole('tree', { name: 'CAN-100 issue tree' }),
    ).toBeVisible();
    const expanded = await scrollGeometry();
    const geometry = JSON.stringify({
      scrollbarMode,
      normal,
      narrowed,
      expanded,
    });
    expect(expanded.maximum, geometry).toBeGreaterThan(0);
    expect(expanded.maximum, geometry).toBeLessThan(narrowed.offset);
    await expect
      .poll(
        () =>
          page.locator('.tree-scroll').evaluate((element) => element.scrollTop),
        { message: geometry },
      )
      .toBe(expanded.maximum);
    await expect
      .poll(
        () =>
          page.evaluate(
            async () =>
              (await window.canopy.loadWorkspace()).tabs.find(
                (tab) => tab.rootKey === 'CAN-100',
              )?.scrollTop,
          ),
        { message: geometry },
      )
      .toBe(expanded.maximum);
    await page.evaluate(() => {
      window.removeEventListener('scroll', window.suppressRestoreScroll, true);
      delete window.suppressRestoreScroll;
    });
  }
  await page
    .locator('#smoke-scrollbars')
    .evaluate((element) => element.remove());

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

  // Run table scenarios after the workspace held-load fixture has completed.
  {
    await page.waitForTimeout(350);
    await close();
    await launch();
    await openIssue('CAN-100');
    await page.getByLabel('Filter status').selectOption('');
    await page.getByLabel('Filter priority').selectOption('');
    await page.getByLabel('Filter assignee').selectOption('');
    if (
      await page
        .getByRole('button', { name: 'Back to root', exact: true })
        .isVisible()
    )
      await page
        .getByRole('button', { name: 'Back to root', exact: true })
        .click();
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .uncheck();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    await openIssue('CAN-200');
    const statusResize = page.getByRole('separator', {
      name: 'Resize Status column',
    });
    await expect(statusResize).toHaveAttribute('aria-valuenow', '128');
    const statusFits = () =>
      page
        .locator('.issue-row .status')
        .first()
        .evaluate((badge) => {
          const original = badge.textContent;
          try {
            return ['In Progress', 'Not Started'].every((label) => {
              badge.textContent = label;
              return badge.scrollWidth <= badge.clientWidth;
            });
          } finally {
            badge.textContent = original;
          }
        });
    expect(await statusFits()).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(920, window.getSize()[1]);
    });
    await expect
      .poll(() =>
        page
          .locator('.tree-scroll')
          .evaluate((tree) => tree.scrollWidth > tree.clientWidth),
      )
      .toBe(true);
    expect(await statusFits()).toBe(true);
    await resizeWindow(600);
    // Table presentation is stored per root and survives closing and reopening.
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('large');
    await page
      .getByLabel('Row spacing', { exact: true })
      .selectOption('comfortable');
    await page.getByLabel('Show Priority column').uncheck();
    await page.getByLabel('Move Status column left').click();
    await page.getByLabel('Sort by', { exact: true }).selectOption('status');
    await page.getByLabel('Sort direction').selectOption('desc');
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .uncheck();
    await page.locator('.view-settings > summary').click();
    await expect(page.locator('.column-heading').nth(1)).toHaveAttribute(
      'data-column',
      'status',
    );
    await expect(
      page.getByRole('button', { name: 'Sort by Priority', exact: true }),
    ).toHaveCount(0);
    await statusResize.press('ArrowRight');
    await expect(statusResize).toHaveAttribute('aria-valuenow', '138');
    await statusResize.scrollIntoViewIfNeeded();
    const divider = await statusResize.boundingBox();
    await page.mouse.move(
      divider.x + divider.width / 2,
      divider.y + divider.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      divider.x + divider.width / 2 + 20,
      divider.y + divider.height / 2,
    );
    await page.mouse.up();
    await expect(statusResize).toHaveAttribute('aria-valuenow', '158');
    await statusResize.dblclick();
    await expect(statusResize).toHaveAttribute('aria-valuenow', '128');
    await statusResize.press('ArrowRight');
    const statusHeader = page.getByRole('button', {
      name: 'Sort by Status',
      exact: true,
    });
    const assigneeHeader = page.getByRole('button', {
      name: 'Sort by Assignee',
      exact: true,
    });
    await assigneeHeader.dragTo(statusHeader);
    await expect(page.locator('.column-heading').nth(1)).toHaveAttribute(
      'data-column',
      'assignee',
    );
    await statusHeader.dragTo(assigneeHeader);
    await expect(page.locator('.column-heading').nth(1)).toHaveAttribute(
      'data-column',
      'status',
    );
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '15px');
    await expect(page.locator('.issue-row').first()).toHaveCSS(
      'min-height',
      '40px',
    );
    await page.keyboard.press(`${modifier}+w`);
    await openIssue('CAN-200');
    await expect(
      page.getByRole('separator', { name: 'Resize Status column' }),
    ).toHaveAttribute('aria-valuenow', '138');
    await expect(page.locator('.column-heading').nth(1)).toHaveAttribute(
      'data-column',
      'status',
    );

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

    await expect(
      page.getByRole('separator', { name: 'Resize Status column' }),
    ).toHaveAttribute('aria-valuenow', '138');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '15px');
    await page.locator('.view-settings > summary').click();
    await expect(page.getByLabel('Sort by', { exact: true })).toHaveValue(
      'status',
    );
    await expect(page.getByLabel('Sort direction')).toHaveValue('desc');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).not.toBeChecked();
    await expect(page.getByLabel('Row spacing', { exact: true })).toHaveValue(
      'comfortable',
    );
    await expect(page.getByLabel('Show Priority column')).not.toBeChecked();
    // Text size and row spacing remain independent in every combination used here.
    await page.getByLabel('Text size', { exact: true }).selectOption('small');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await expect(page.locator('.issue-row').first()).toHaveCSS(
      'min-height',
      '40px',
    );
    await page
      .getByLabel('Row spacing', { exact: true })
      .selectOption('compact');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await expect(page.locator('.issue-row').first()).toHaveCSS(
      'min-height',
      '30px',
    );
    await page.getByLabel('Text size', { exact: true }).selectOption('large');
    await page
      .getByLabel('Row spacing', { exact: true })
      .selectOption('comfortable');
    await page
      .getByRole('button', { name: 'Use as connection default' })
      .click();
    await page.getByLabel('Text size', { exact: true }).selectOption('small');
    await page
      .getByRole('button', { name: 'Reset this root to default' })
      .click();
    await expect(page.getByLabel('Text size', { exact: true })).toHaveValue(
      'large',
    );
    await page.locator('.view-settings > summary').click();

    // An uncustomized root inherits the saved connection view, including Hide done.
    await openIssue('CAN-201');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '15px');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('button', { name: 'Sort by Priority', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press(`${modifier}+w`);

    await page.getByRole('tab', { name: /CAN-100/ }).click();
    await expect(issue('CAN-111').getByText(summary)).toBeVisible();
    await expect(issue('CAN-111').getByText('Highest')).toBeVisible();
    await expect(issue('CAN-111').getByText('Sam Rivera')).toBeVisible();
    await expect(issue('CAN-111').getByText('In Progress')).toBeVisible();
    await expectIssueBefore('CAN-112', 'CAN-111');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '13px');
    await expect(
      issue('CAN-100').locator(':scope > .issue-row .grab'),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Sort by Priority', exact: true })
      .click();
    await expect(
      page.getByText('Loading Jira priority order…', { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Reorder CAN-111/ }),
    ).toBeDisabled();
    await expect(
      page.getByText('Ranking is disabled while a column sort is active.', {
        exact: false,
      }),
    ).toBeVisible();
    await expectIssueBefore('CAN-111', 'CAN-112');
    const rankAttempts = await readFile(
      join(userData, 'rank-attempts.json'),
      'utf8',
    );
    const disabledHandle = page.getByRole('button', {
      name: /Reorder CAN-111/,
    });
    await expect(disabledHandle).toHaveAttribute('draggable', 'false');
    // Dispatch a shortcut directly too: the handler and write guard must reject it.
    await disabledHandle.dispatchEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
    });
    await disabledHandle.dispatchEvent('dragstart', { bubbles: true });
    await issue('CAN-112')
      .locator(':scope > .issue-row')
      .dispatchEvent('drop', { bubbles: true });
    await page.waitForTimeout(100);
    expect(await readFile(join(userData, 'rank-attempts.json'), 'utf8')).toBe(
      rankAttempts,
    );
    await expectIssueBefore('CAN-111', 'CAN-112');
    for (const [name, first, second] of [
      ['Issue summary', 'CAN-111', 'CAN-112'],
      ['Assignee', 'CAN-112', 'CAN-111'],
      ['Status', 'CAN-111', 'CAN-112'],
    ]) {
      const header = page.getByRole('button', {
        name: `Sort by ${name}`,
        exact: true,
      });
      await header.click();
      await expectIssueBefore(first, second);
      await header.click();
      await expectIssueBefore(second, first);
      await expect(
        issue('CAN-110').locator(
          ':scope > [role="group"] > [data-tree-key="CAN-111"]',
        ),
      ).toBeVisible();
    }
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Sort by', { exact: true }).selectOption('rank');
    await page.locator('.view-settings > summary').click();
    await expectIssueBefore('CAN-112', 'CAN-111');
    const headerTop = (await page.locator('.column-head').boundingBox()).y;
    await page.locator('.tree-scroll').evaluate((element) => {
      element.style.maxHeight = '180px';
      element.scrollTop = 200;
    });
    expect(
      Math.abs(
        (await page.locator('.column-head').boundingBox()).y - headerTop,
      ),
    ).toBeLessThan(1);
    await page.locator('.tree-scroll').evaluate((element) => {
      element.style.maxHeight = '';
      element.scrollTop = 0;
    });

    await page.getByTitle('Open in Jira', { exact: true }).first().click();
    const errorText = page.locator('.error-banner span').first();
    await expect(errorText).toContainText('Demo issues exist only in Canopy.');
    await expect(errorText).toHaveCSS('user-select', 'text');
    await errorText.selectText();
    await page.keyboard.press(`${modifier}+c`);
    expect(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
    ).toContain('Demo issues exist only in Canopy.');

    // Actual navigation filters participate in root views, defaults and history.
    await page.getByRole('tab', { name: /CAN-200/ }).click();
    await page.getByLabel('Filter priority').selectOption('3');
    await page.getByLabel('Filter status').selectOption('todo');
    await page.getByLabel('Filter assignee').selectOption('');
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('medium');
    await page.locator('.view-settings > summary').click();
    await page.getByRole('tab', { name: /CAN-100/ }).click();
    await page.getByLabel('Filter assignee').selectOption('me');
    await page.getByLabel('Filter status').selectOption('progress');
    await page.getByLabel('Filter priority').selectOption('2');
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .check();
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('small');
    await page
      .getByRole('button', { name: 'Use as connection default' })
      .click();
    await page.locator('.view-settings > summary').click();
    await page.getByRole('tab', { name: /CAN-200/ }).click();
    await expect(page.getByLabel('Filter priority')).toHaveValue('3');
    await expect(page.getByLabel('Filter status')).toHaveValue('todo');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).not.toBeChecked();
    await page.locator('.view-settings > summary').click();
    await page
      .getByRole('button', { name: 'Reset this root to default' })
      .click();
    await page.locator('.view-settings > summary').click();
    await expect(page.getByLabel('Filter assignee')).toHaveValue('me');
    await expect(page.getByLabel('Filter status')).toHaveValue('progress');
    await expect(page.getByLabel('Filter priority')).toHaveValue('2');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).toBeChecked();
    // A default can refer to a value absent from this root; show the active filter.
    await expect(
      page.getByLabel('Filter priority').locator('option:checked'),
    ).toContainText('not in this tree');
    await openIssue('CAN-201', false);
    await expect(page.getByLabel('Filter priority')).toHaveValue('2');
    await expect(page.getByLabel('Filter assignee')).toHaveValue('me');
    await page.keyboard.press(`${modifier}+w`);
    await page.getByRole('tab', { name: /CAN-100/ }).click();
    await page.getByLabel('Filter assignee').selectOption('');
    await page.getByLabel('Filter status').selectOption('');
    await page.getByLabel('Filter priority').selectOption('3');
    await page.getByRole('tab', { name: /CAN-200/ }).click();
    await page.getByRole('tab', { name: /CAN-100/ }).click();
    await page.getByLabel('Filter priority').selectOption('4');
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .uncheck();
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('large');
    await page.locator('.view-settings > summary').click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Filter priority')).toHaveValue('3');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).toBeChecked();
    // An unrelated root change must not replace the restored override.
    await page.getByRole('tab', { name: /CAN-200/ }).click();
    await page.locator('.view-settings > summary').click();
    await page.getByLabel('Text size', { exact: true }).selectOption('large');
    await page.locator('.view-settings > summary').click();
    await page.getByRole('tab', { name: /CAN-100/ }).click();
    await expect(page.getByLabel('Filter priority')).toHaveValue('3');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await page
      .getByRole('tab', { name: /CAN-100/ })
      .click({ button: 'middle' });
    await page.keyboard.press(`${modifier}+Shift+t`);
    await expect(page.getByLabel('Filter priority')).toHaveValue('3');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await page.waitForTimeout(350);
    await close();
    await launch();
    await expect(page.getByLabel('Filter priority')).toHaveValue('3');
    await expect(page.locator('.issue-tree')).toHaveCSS('font-size', '11px');
    await expect(
      page.getByRole('checkbox', { name: 'Hide done', exact: true }),
    ).toBeChecked();
    await page.getByLabel('Filter priority').selectOption('');
    await page
      .getByRole('checkbox', { name: 'Hide done', exact: true })
      .uncheck();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();

    // Capability failures keep the tree readable and remove every rank action.
    await page.waitForTimeout(350);
    for (const state of ['unsupported', 'unknown']) {
      await close();
      await launch(false, { CANOPY_SMOKE_RANKING: state });
      await expect(
        page.getByRole('tree', { name: 'CAN-100 issue tree' }),
      ).toBeVisible();
      await expect(page.locator('.grab')).toHaveCount(0);
      await expect(
        page.getByText(
          state === 'unsupported'
            ? 'Jira Rank is unavailable for this tree.'
            : 'Ranking permissions could not be verified. Refresh to try again.',
          { exact: true },
        ),
      ).toBeVisible();
      await issue('CAN-111').dispatchEvent('keydown', {
        key: 'ArrowUp',
        altKey: true,
        bubbles: true,
      });
      await page.waitForTimeout(100);
      expect(
        JSON.parse(
          await readFile(join(userData, 'rank-attempts.json'), 'utf8'),
        ),
      ).toBe(0);
    }
    await close();
    await launch(false, { CANOPY_SMOKE_PRIORITY_FAILURES: '1' });
    await expect(
      page.getByRole('button', { name: /Reorder CAN-111/ }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Sort by Priority', exact: true })
      .click();
    await expect(
      page.getByText('Priority order could not be loaded:', { exact: false }),
    ).toBeVisible();
    await expectIssueBefore('CAN-112', 'CAN-111');
    await expect(
      page.getByRole('button', { name: /Reorder CAN-111/ }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Retry priority sort' }).click();
    await expect(
      page.getByText('Priority order could not be loaded:', { exact: false }),
    ).toHaveCount(0);
    await expectIssueBefore('CAN-111', 'CAN-112');
    await expect(
      issue('CAN-110').locator(
        ':scope > [role="group"] > [data-tree-key="CAN-111"]',
      ),
    ).toBeVisible();
    expect(
      JSON.parse(await readFile(join(userData, 'rank-attempts.json'), 'utf8')),
    ).toBe(0);
  }

  await auditMutationViews();

  await close();
  await writeFile(
    join(userData, 'workspace.json'),
    JSON.stringify({
      tabs: ['CAN-100', 'CAN-200'].map((rootKey) => ({
        id: `refresh-${rootKey}`,
        connectionId: 'demo',
        rootKey,
        expanded: [rootKey],
        hideDone: false,
        scrollTop: 0,
      })),
      activeTabId: 'refresh-CAN-200',
      shortcuts: {},
      theme: 'system',
      sidebarCollapsed: false,
    }),
  );
  await launch();
  await auditSearch(app, page);
  await auditRefresh(app, page, resizeWindow);

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

  await auditGithub(app, page);

  await auditWorkflow(app, page);

  await auditPreview(app, page);

  expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([]);
  console.log(
    `Canopy Electron smoke test passed. Screenshot: ${screenshotPath}`,
  );
} catch (error) {
  smokeFailure = error;
  try {
    await captureFailure(error);
  } catch (diagnosticError) {
    console.error('Could not capture smoke diagnostics:', diagnosticError);
  }
} finally {
  for (const cleanup of [
    close,
    () => rm(userData, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      if (smokeFailure) console.error('Smoke cleanup also failed:', error);
      else cleanupFailure ??= error;
    }
  }
}

if (smokeFailure) throw smokeFailure;
if (cleanupFailure) throw cleanupFailure;
