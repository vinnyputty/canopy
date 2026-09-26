import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const appPath = process.env.CANOPY_APP_PATH;
const packagedExecutable = process.env.CANOPY_PACKAGED_EXE;
const executablePath = packagedExecutable || process.env.CANOPY_ELECTRON_PATH;
if ((!appPath && !packagedExecutable) || !executablePath)
  throw new Error('Demo check needs the staged app and Electron runtime.');

async function openDemo() {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-demo-check-'));
  const savedWindow = JSON.stringify({
    bounds: { x: 40, y: 50, width: 1000, height: 700 },
    maximized: false,
  });
  await writeFile(join(directory, 'window.json'), savedWindow);
  const env = { ...process.env, CANOPY_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath,
    args: [...(packagedExecutable ? [] : [appPath]), '--canopy-demo'],
    env,
  });
  const child = app.process();
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await expect(page.getByRole('region', { name: 'Canopy demo' })).toBeVisible();
  return { app, child, page, directory, errors, savedWindow };
}

async function closeDemo(session) {
  if (session.child.exitCode === null) await session.app.close();
  await rm(session.directory, { recursive: true, force: true });
  if (session.errors.length) throw session.errors[0];
}

const first = await openDemo();
try {
  const { page } = first;
  await expect(page.getByRole('button', { name: 'Stop demo' })).toBeVisible();
  const progress = page.getByRole('progressbar', { name: 'Step progress' });
  await expect(progress).toBeVisible();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toHaveClass(/demo-target-highlight/);
  await page.getByRole('button', { name: 'Pause demo' }).click();
  const pausedProgress = await progress.evaluate((bar) => bar.value);
  await page.waitForTimeout(800);
  if ((await progress.evaluate((bar) => bar.value)) !== pausedProgress)
    throw new Error('Step progress advanced while paused.');
  await page.getByRole('button', { name: 'Next demo step' }).click();
  await expect(page.getByText('Step 1 of 7 · Paused')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Expand CAN-100' }),
  ).toHaveClass(/demo-target-highlight/);
  await expect(page.locator('[data-tree-key="CAN-108"]')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText('Starting tour · Paused')).toBeVisible();
  await page.getByRole('button', { name: 'Resume demo' }).click();
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
  const resumedProgress = await progress.evaluate((bar) => bar.value);
  await page.waitForTimeout(700);
  if ((await progress.evaluate((bar) => bar.value)) <= resumedProgress)
    throw new Error('Step progress did not advance after Resume.');
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  await expect(
    page.getByText('Playback stopped. Explore the sample workspace freely.'),
  ).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(page.locator('[data-tree-key="CAN-108"]')).toHaveCount(0);
  await page.context().setOffline(true);
  await page.getByTitle('Refresh', { exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Connection status' }),
  ).toHaveText('Local sample');
  await page.getByRole('button', { name: 'Expand CAN-100' }).click();
  await expect(page.locator('[data-tree-key="CAN-111"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand CAN-110' }).click();
  await expect(page.locator('[data-tree-key="CAN-111"]')).toBeVisible();
  await page.getByRole('textbox', { name: 'Find in tree' }).fill('CAN-108');
  await expect(page.locator('[data-tree-key="CAN-108"]')).toBeVisible();
  await page.getByRole('textbox', { name: 'Find in tree' }).fill('');
  await page.locator('[data-tree-key="CAN-111"]').focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('complementary', { name: 'Preview CAN-111' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close issue preview' }).click();
  await page.getByRole('button', { name: 'Reset and replay' }).click();
  await expect(page.getByRole('button', { name: 'Stop demo' })).toBeVisible();
  await expect(page.getByText('Step 6 of 7')).toBeVisible({ timeout: 60000 });
  await expect(
    page.locator('[data-tree-key="CAN-111"] .priority-editor select'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await page.waitForTimeout(1800);
  const stopped = await page.evaluate(
    async () =>
      (await window.canopy.tree('demo', 'CAN-100')).issues.find(
        (issue) => issue.key === 'CAN-111',
      )?.priority?.name,
  );
  if (stopped !== 'High')
    throw new Error(`Stop during edit left priority ${stopped}`);
  await page.getByRole('button', { name: 'Reset and replay' }).click();
  await expect(
    page.getByRole('button', { name: 'Edit priority for CAN-111' }),
  ).toContainText('Highest', { timeout: 60000 });
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await page.waitForTimeout(1800);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.canopy.tree('demo', 'CAN-100')).issues.find(
            (issue) => issue.key === 'CAN-111',
          )?.priority?.name,
      ),
    )
    .toBe('High');
  await expect(
    page.getByRole('button', { name: 'Undo edit to CAN-111' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset and replay' }).click();
  await expect(
    page.getByText('Tour complete. The sample tree is yours to explore.'),
  ).toBeVisible({ timeout: 70000 });
  const final = await page.evaluate(async () => {
    const issues = (await window.canopy.tree('demo', 'CAN-100')).issues;
    return {
      priority: issues.find((issue) => issue.key === 'CAN-111')?.priority?.name,
      order: issues
        .filter((issue) => issue.parentKey === 'CAN-110')
        .map((issue) => issue.key),
    };
  });
  if (final.priority !== 'High' || final.order.join(',') !== 'CAN-112,CAN-111')
    throw new Error(
      `Tour left unexpected sample data: ${JSON.stringify(final)}`,
    );
  await page.getByRole('button', { name: 'Previous demo step' }).click();
  await expect(page.getByText('Step 6 of 7')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.canopy.tree('demo', 'CAN-100')).issues
          .filter((issue) => issue.parentKey === 'CAN-110')
          .map((issue) => issue.key)
          .join(','),
      ),
    )
    .toBe('CAN-111,CAN-112');
  await page.getByRole('button', { name: 'Next demo step' }).click();
  await expect(page.getByText('Step 7 of 7')).toBeVisible();
  await expect(
    page.getByText('Tour complete. The sample tree is yours to explore.'),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Open in Jira' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Edit priority for CAN-111' }).click();
  await page.getByLabel('Choose value').selectOption('4');
  await expect(
    page.getByRole('button', { name: 'Edit priority for CAN-111' }),
  ).toContainText('Low');
  await page.getByRole('button', { name: 'Undo edit to CAN-111' }).click();
  await expect(
    page.getByRole('button', { name: 'Edit priority for CAN-111' }),
  ).toContainText('High');
  await page.getByRole('button', { name: /Reorder CAN-112/ }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.canopy.tree('demo', 'CAN-100')).issues
          .filter((issue) => issue.parentKey === 'CAN-110')
          .map((issue) => issue.key)
          .join(','),
      ),
    )
    .toBe('CAN-111,CAN-112');
  await page.getByRole('button', { name: 'Reset and replay' }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.canopy.tree('demo', 'CAN-100')).issues
          .filter((issue) => issue.parentKey === 'CAN-110')
          .map((issue) => issue.key)
          .join(','),
      ),
    )
    .toBe('CAN-111,CAN-112');
  await page.locator('[data-tree-key="CAN-100"]').click();
  await expect(
    page.getByText('Playback stopped because you took control.'),
  ).toBeVisible();
  const exited = new Promise((resolve) => first.child.once('exit', resolve));
  await page.getByRole('button', { name: 'Close demo' }).click();
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Demo did not exit after Close demo.')),
        5000,
      ),
    ),
  ]);
  if (
    (await readFile(join(first.directory, 'window.json'), 'utf8')) !==
    first.savedWindow
  )
    throw new Error('Demo changed the saved window layout.');
  console.log(
    'Demo checks passed: pause and progress, highlighted targets, step navigation, Stop, Reset, complete tour, manual takeover.',
  );
} finally {
  await closeDemo(first);
}

if (process.platform !== 'win32') {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-demo-launch-check-'));
  const env = { ...process.env, CANOPY_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath,
    args: packagedExecutable ? [] : [appPath],
    env,
  });
  let childPid;
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Try demo' }).first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        readFile(join(directory, 'workspace.json'), 'utf8').catch(() => null),
      )
      .not.toBeNull();
    const originalWorkspace = await readFile(
      join(directory, 'workspace.json'),
      'utf8',
    );
    const credentialFile = join(directory, 'credentials.json');
    const credentialSentinel = JSON.stringify('encrypted-test-credentials');
    await writeFile(credentialFile, credentialSentinel);
    await page.getByRole('button', { name: 'Try demo' }).first().click();
    await expect
      .poll(
        () => {
          const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
            encoding: 'utf8',
          });
          const processId = app.process().pid;
          const match = table.split('\n').find((line) => {
            const parts = line.trim().split(/\s+/, 3);
            return (
              Number(parts[1]) === processId && line.includes('--canopy-demo')
            );
          });
          childPid = match ? Number(match.trim().split(/\s+/)[0]) : undefined;
          return childPid;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(1400);
    await expect(
      page.getByRole('heading', { name: 'See the whole tree.' }),
    ).toBeVisible();
    const currentWorkspace = await readFile(
      join(directory, 'workspace.json'),
      'utf8',
    );
    if (currentWorkspace !== originalWorkspace)
      throw new Error('Launching the demo changed the real workspace.');
    if ((await readFile(credentialFile, 'utf8')) !== credentialSentinel)
      throw new Error('Launching the demo changed saved credentials.');
    console.log(
      'Installed entry check passed: Try demo starts a separate process and keeps the normal workspace open.',
    );
  } finally {
    if (childPid) {
      try {
        process.kill(childPid);
      } catch {}
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
