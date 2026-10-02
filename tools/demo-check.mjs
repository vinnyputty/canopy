import { _electron as electron, chromium, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const appPath = process.env.CANOPY_APP_PATH;
const packagedExecutable = process.env.CANOPY_PACKAGED_EXE;
const executablePath = packagedExecutable || process.env.CANOPY_ELECTRON_PATH;
if ((!appPath && !packagedExecutable) || !executablePath)
  throw new Error('Demo check needs the staged app and Electron runtime.');

const timeScale = 0.1;
const timingWindow = (ms) => Math.ceil(ms * timeScale) + 100;

async function openDemo() {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-demo-check-'));
  const savedWindow = JSON.stringify({
    bounds: { x: 40, y: 50, width: 1000, height: 700 },
    maximized: false,
  });
  await writeFile(join(directory, 'window.json'), savedWindow);
  const env = {
    ...process.env,
    CANOPY_USER_DATA: directory,
    CANOPY_DEMO_TIME_SCALE: String(timeScale),
  };
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
// Pause synchronously when a target state renders, before its presentation timer
// can expire. The script is reinstalled after every Reset and replay reload.
function installDemoHold() {
  const trace = [];
  globalThis.canopyDemoCheckTrace = trace;
  const record = (event, state = {}) => {
    trace.push({ ms: performance.now(), event, ...state });
    if (trace.length > 64) trace.shift();
  };
  record('script-entry', { hold: sessionStorage.getItem('canopy-check-hold') });
  let previous = '';
  const observer = new MutationObserver(() => {
    const target = sessionStorage.getItem('canopy-check-hold');
    const ready =
      target === 'editor'
        ? document.querySelector(
            '[data-tree-key="CAN-111"] .priority-editor select',
          )
        : target === 'edited' &&
          document
            .querySelector('[aria-label="Edit priority for CAN-111"]')
            ?.textContent?.includes('Highest');
    const pause = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Pause demo',
    );
    const state = {
      target,
      ready: Boolean(ready),
      pause: Boolean(pause),
      rootAction: document
        .querySelector(
          '[aria-label="Expand CAN-100"], [aria-label="Collapse CAN-100"]',
        )
        ?.getAttribute('aria-label'),
      caption: document.querySelector('.demo-tour [role="status"]')
        ?.textContent,
    };
    const signature = JSON.stringify(state);
    if (signature !== previous) {
      record('render', state);
      previous = signature;
    }
    if (!ready || !pause) return;
    record('pause-click', state);
    pause.click();
    sessionStorage.removeItem('canopy-check-hold');
    observer.disconnect();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
await first.page.addInitScript(installDemoHold);

async function demoFailureState() {
  return {
    readyState: document.readyState,
    hold: sessionStorage.getItem('canopy-check-hold'),
    requestedStep: sessionStorage.getItem('canopy-demo-step'),
    requestedPaused: sessionStorage.getItem('canopy-demo-paused'),
    beforeReset: sessionStorage.getItem('canopy-check-before-reset'),
    navigation: performance.getEntriesByType('navigation').map((entry) => ({
      startTime: entry.startTime,
      duration: entry.duration,
      type: entry.type,
    })),
    trace: globalThis.canopyDemoCheckTrace,
    tour: document.querySelector('.demo-tour')?.textContent,
    tree: [...document.querySelectorAll('[data-tree-key]')].map((row) => ({
      key: row.getAttribute('data-tree-key'),
      expanded: row.getAttribute('aria-expanded'),
    })),
    focus: document.activeElement?.getAttribute('aria-label'),
    workspace: await window.canopy.loadWorkspace(),
  };
}

async function reportDemoFailure(page, target, primary) {
  let timer;
  try {
    const state = await Promise.race([
      page.evaluate(demoFailureState),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Demo diagnostic timed out')),
          2000,
        );
      }),
    ]);
    console.error(
      'Demo hold failure:',
      JSON.stringify({ target, error: String(primary), state }),
    );
  } catch (error) {
    console.error('Demo hold diagnostic failed:', String(error));
  } finally {
    clearTimeout(timer);
  }
}
async function resetAndHold(page, target) {
  await page.evaluate((target) => {
    sessionStorage.setItem('canopy-check-hold', target);
    sessionStorage.setItem(
      'canopy-check-before-reset',
      JSON.stringify({
        target,
        tour: document.querySelector('.demo-tour')?.textContent,
        ms: performance.now(),
        tree: [...document.querySelectorAll('[data-tree-key]')].map((row) => ({
          key: row.getAttribute('data-tree-key'),
          expanded: row.getAttribute('aria-expanded'),
        })),
      }),
    );
  }, target);
  await page.getByRole('button', { name: 'Reset and replay' }).click();
  try {
    await expect(page.getByRole('button', { name: 'Resume demo' })).toBeVisible(
      {
        timeout: 30000,
      },
    );
  } catch (error) {
    await reportDemoFailure(page, target, error);
    throw error;
  }
  // Hold beyond either transient state's unpaused lifetime before testing Stop.
  await page.waitForTimeout(timingWindow(4000));
}

try {
  const { page } = first;
  expect(await page.evaluate(() => window.canopy.demoTimeScale())).toBe(
    timeScale,
  );
  await expect(page.getByRole('button', { name: 'Stop demo' })).toBeVisible();
  await expect(page.locator('[data-tree-key="CAN-100"] .summary')).toHaveText(
    'A calmer place to get things done',
  );
  const progress = page.getByRole('progressbar', { name: 'Step progress' });
  await expect(progress).toBeVisible();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toHaveClass(/demo-target-highlight/);
  await page.getByRole('button', { name: 'Pause demo' }).click();
  const pausedProgress = await progress.evaluate((bar) => bar.value);
  // Observe long enough for multiple progress ticks, even at test speed.
  await page.waitForTimeout(timingWindow(800));
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
  await expect
    .poll(() => progress.evaluate((bar) => bar.value), { intervals: [20] })
    .toBeGreaterThan(resumedProgress);
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await expect(
    page.getByRole('tree', { name: 'CAN-100 issue tree' }),
  ).toBeVisible();
  await expect(
    page.getByText('Playback stopped. Explore the sample workspace freely.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  const appearance = page.getByRole('dialog', { name: 'Appearance' });
  await appearance.getByRole('radio', { name: 'Forest' }).check();
  await appearance.getByRole('radio', { name: 'Dark' }).check();
  await appearance.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.canopy.loadWorkspace()).palette),
    )
    .toBe('forest');
  // Stop must stay stopped beyond the next scheduled tour action.
  await page.waitForTimeout(timingWindow(3200));
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
  await page.getByRole('button', { name: 'Show development' }).click();
  await expect(
    page.getByText('Development links are unavailable in the demo workspace.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close issue preview' }).click();
  await page.getByRole('button', { name: 'Actions for CAN-111' }).click();
  const actions = page.getByRole('menu', { name: 'Actions for CAN-111' });
  await expect(
    actions.getByRole('menuitem', { name: 'Copy link' }),
  ).toHaveCount(0);
  await actions.getByRole('menuitem', { name: 'Copy work brief' }).click();
  const brief = page.getByRole('dialog', { name: 'Work brief for CAN-111' });
  await expect(
    brief.getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    '- Issue: Demo CAN-111',
  );
  await expect(brief.getByLabel('Work brief Markdown')).toContainText(
    '- Source: Local sample workspace',
  );
  await brief.getByRole('button', { name: 'Close dialog' }).click();
  await resetAndHold(page, 'editor');
  await expect(page.getByRole('button', { name: 'Stop demo' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'default');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await expect(page.getByText('Step 6 of 7 · Paused')).toBeVisible();
  await expect(
    page.locator('[data-tree-key="CAN-111"] .priority-editor select'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop demo' }).click();
  // An aborted edit must stay restored beyond its pending presentation delay.
  await page.waitForTimeout(timingWindow(1800));
  const stopped = await page.evaluate(
    async () =>
      (await window.canopy.tree('demo', 'CAN-100')).issues.find(
        (issue) => issue.key === 'CAN-111',
      )?.priority?.name,
  );
  if (stopped !== 'High')
    throw new Error(`Stop during edit left priority ${stopped}`);
  await resetAndHold(page, 'edited');
  await expect(
    page.getByRole('button', { name: 'Edit priority for CAN-111' }),
  ).toContainText('Highest');
  await page.getByRole('button', { name: 'Stop demo' }).click();
  // An aborted edit must stay restored beyond its pending presentation delay.
  await page.waitForTimeout(timingWindow(1800));
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
  await page.locator('[data-tree-key="CAN-110"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-tree-key="CAN-111"]')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-tree-key="CAN-111"]')).toBeVisible();
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

{
  const directory = await mkdtemp(join(tmpdir(), 'canopy-demo-launch-check-'));
  const env = { ...process.env, CANOPY_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath,
    args: packagedExecutable ? [] : [appPath],
    env,
  });
  let childPid;
  let childBrowser;
  let page;
  try {
    page = await app.firstWindow();
    expect(await page.evaluate(() => window.canopy.demoTimeScale())).toBe(1);
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
    // Capture the real child and its assigned DevTools endpoint in the test
    // process, so readiness and cleanup work on every desktop platform.
    await app.evaluate(() => {
      const childProcess = process.getBuiltinModule('child_process');
      const originalSpawn = childProcess.spawn;
      globalThis.canopyCheckOutput = '';
      childProcess.spawn = (executable, args, options) => {
        if (!args.includes('--canopy-demo'))
          return originalSpawn(executable, args, options);
        const child = originalSpawn(
          executable,
          [
            ...args,
            '--remote-debugging-port=0',
            // Match Playwright's test launch for the downloaded Linux runtime,
            // whose chrome-sandbox helper is not installed with setuid privileges.
            ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          ],
          {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        globalThis.canopyCheckChild = child;
        const record = (chunk) => {
          globalThis.canopyCheckOutput = (
            globalThis.canopyCheckOutput + chunk.toString()
          ).slice(-8000);
          const match = globalThis.canopyCheckOutput.match(
            /DevTools listening on (ws:\/\/\S+)/,
          );
          if (match) globalThis.canopyCheckEndpoint = match[1];
        };
        child.stdout.on('data', record);
        child.stderr.on('data', record);
        return child;
      };
    });
    await page.getByRole('button', { name: 'Try demo' }).first().click();
    await expect
      .poll(() => app.evaluate(() => globalThis.canopyCheckChild?.pid))
      .toBeGreaterThan(0);
    childPid = await app.evaluate(() => globalThis.canopyCheckChild.pid);
    const duplicateLaunch = await page.evaluate(async () => {
      try {
        await window.canopy.launchDemo();
        return 'A second demo launched.';
      } catch (error) {
        return String(error);
      }
    });
    expect(duplicateLaunch).toContain('The demo is already open.');
    await expect
      .poll(
        async () => {
          const state = await app.evaluate(() => ({
            endpoint: globalThis.canopyCheckEndpoint,
            exitCode: globalThis.canopyCheckChild?.exitCode,
            output: globalThis.canopyCheckOutput,
          }));
          if (state.exitCode !== null && state.exitCode !== undefined)
            throw new Error(
              `Demo child exited (${state.exitCode}) before readiness:\n${state.output}`,
            );
          if (!state.endpoint)
            return state.output || 'Waiting for child DevTools endpoint';
          try {
            childBrowser = await chromium.connectOverCDP(state.endpoint, {
              timeout: 1000,
            });
            return 'connected';
          } catch (error) {
            return `${error}\n${state.output}`;
          }
        },
        { timeout: 10000 },
      )
      .toBe('connected');
    await expect
      .poll(() => childBrowser.contexts()[0]?.pages().length ?? 0)
      .toBeGreaterThan(0);
    const childPage = childBrowser.contexts()[0].pages()[0];
    await expect(
      childPage.getByRole('region', { name: 'Canopy demo' }),
    ).toBeVisible();
    await expect(
      childPage.getByRole('tree', { name: 'CAN-100 issue tree' }),
    ).toBeVisible();
    await expect(
      childPage.getByRole('progressbar', { name: 'Step progress' }),
    ).toBeVisible();

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
    try {
      if (childBrowser) await childBrowser.close();
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {}
        await expect
          .poll(
            () =>
              app.evaluate(() => {
                const child = globalThis.canopyCheckChild;
                return child.exitCode !== null || child.signalCode !== null;
              }),
            { timeout: 10000 },
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  document.visibilityState === 'visible' && document.hasFocus(),
              ),
            { timeout: 10000 },
          )
          .toBe(true);
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
