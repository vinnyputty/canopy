import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const appPath = process.env.CANOPY_APP_PATH;
const executablePath = process.env.CANOPY_ELECTRON_PATH;
if (!appPath || !executablePath)
  throw new Error('Instance check needs the staged app and Electron runtime.');
const directory = await mkdtemp(join(tmpdir(), 'canopy-instance-check-'));
const sessions = [];
const children = [];
const focusFailures = [];
const stateOnly = process.argv.includes('--state-only');
const hiddenWindowCheck = process.platform === 'linux' && stateOnly;
async function verifyFocus(session, scenario) {
  if (stateOnly) {
    console.log(`Native focus acceptance pending: ${scenario} (--state-only).`);
    return;
  }
  try {
    await expect
      .poll(() =>
        session.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().length === 1 &&
            BrowserWindow.getAllWindows()[0].isFocused(),
        ),
      )
      .toBe(true);
  } catch (error) {
    focusFailures.push(
      new Error(
        `Window focus failed after ${scenario}. Run this check on an active desktop.`,
        { cause: error },
      ),
    );
  }
}
const env = { ...process.env, CANOPY_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;

async function duplicate(args, profileEnv = env) {
  const child = spawn(
    executablePath,
    // Match Playwright's test launch for the downloaded Linux runtime.
    [...args, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    { env: profileEnv, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Duplicate launch did not exit.\n${stderr}`)),
      10000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Duplicate launch exited with code ${code}, signal ${signal}.\n${stderr}`,
          ),
        );
    });
  });
}
async function open(args, profileEnv = env) {
  const session = await electron.launch({
    executablePath,
    args,
    env: profileEnv,
  });
  sessions.push(session);
  await session.evaluate(({ app }) => {
    globalThis.canopySecondLaunches = 0;
    app.on('second-instance', () => {
      globalThis.canopySecondLaunches += 1;
    });
  });
  return session;
}
try {
  const normal = await open([appPath]);
  const page = await normal.firstWindow();
  await expect(
    page.getByRole('heading', { name: 'See the whole tree.' }),
  ).toBeVisible();
  if (hiddenWindowCheck) {
    console.log(
      'Native minimization acceptance pending: Linux --state-only checks hidden-window restoration because a virtual display may have no window manager.',
    );
    await normal.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
    await expect
      .poll(() =>
        normal.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(false);
  } else {
    await normal.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].minimize(),
    );
    await expect
      .poll(() =>
        normal.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isMinimized(),
        ),
      )
      .toBe(true);
  }
  await Promise.all(Array.from({ length: 3 }, () => duplicate([appPath])));
  await expect
    .poll(() =>
      normal.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return {
          count: windows.length,
          minimized: windows[0]?.isMinimized(),
          visible: windows[0]?.isVisible(),
          launches: globalThis.canopySecondLaunches,
        };
      }),
    )
    .toEqual({
      count: 1,
      minimized: false,
      visible: true,
      launches: 3,
    });

  await verifyFocus(normal, 'duplicate launch');

  const isolated = join(directory, 'isolated');
  const demo = await open([appPath, '--canopy-demo'], {
    ...env,
    CANOPY_USER_DATA: isolated,
    CANOPY_DEMO_TEMP: '1',
  });
  await expect(
    (await demo.firstWindow()).getByRole('region', { name: 'Canopy demo' }),
  ).toBeVisible();
  await writeFile(join(isolated, 'sentinel'), 'active demo');
  await duplicate([appPath, '--canopy-demo'], {
    ...env,
    CANOPY_USER_DATA: isolated,
    CANOPY_DEMO_TEMP: '1',
  });
  expect(await readFile(join(isolated, 'sentinel'), 'utf8')).toBe(
    'active demo',
  );
  await expect
    .poll(() =>
      normal.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    )
    .toBe(1);
  await demo.evaluate(({ BrowserWindow }) => {
    globalThis.canopyDemoCloseHeld = true;
    const closing = BrowserWindow.getAllWindows()[0];
    globalThis.canopyDemoClosingWindowId = closing.id;
    closing.on('close', (event) => {
      if (globalThis.canopyDemoCloseHeld) event.preventDefault();
    });
    closing.close();
  });
  await duplicate([appPath, '--canopy-demo'], {
    ...env,
    CANOPY_USER_DATA: isolated,
    CANOPY_DEMO_TEMP: '1',
  });
  expect(
    await demo.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  await demo.evaluate(({ BrowserWindow }) => {
    globalThis.canopyDemoCloseHeld = false;
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect
    .poll(() =>
      demo.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return (
          windows.length === 1 &&
          windows[0].id !== globalThis.canopyDemoClosingWindowId
        );
      }),
    )
    .toBe(true);
  await expect(
    (await demo.firstWindow()).getByRole('region', { name: 'Canopy demo' }),
  ).toBeVisible();
  await verifyFocus(demo, 'demo duplicate launch during pending close');
  const demoExited = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error('Demo close without a pending launch did not exit.')),
      10000,
    );
    demo.process().once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Demo exited with ${code}.`));
    });
  });
  await demo.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await demoExited;
  sessions.splice(sessions.indexOf(demo), 1);

  if (process.platform === 'darwin') {
    await normal.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() =>
        normal.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(0);
    await Promise.all([duplicate([appPath]), duplicate([appPath])]);
    await expect
      .poll(() =>
        normal.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(1);
    await expect(
      (await normal.firstWindow()).getByRole('heading', {
        name: 'See the whole tree.',
      }),
    ).toBeVisible();
    await verifyFocus(normal, 'closed-window duplicate launch');
    await normal.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() =>
        normal.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(0);
    await normal.evaluate(({ app }) => {
      app.emit('activate');
      app.emit('activate');
    });
    await expect
      .poll(() =>
        normal.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(1);
    await expect(
      (await normal.firstWindow()).getByRole('heading', {
        name: 'See the whole tree.',
      }),
    ).toBeVisible();
    await verifyFocus(normal, 'activate event after closing the window');
    console.log(
      'Native Dock activation acceptance pending: manually click the Dock icon with the window closed. The emitted activate event checks the application handler.',
    );
  }

  const startupDirectory = join(directory, 'startup');
  const startupEnv = {
    ...env,
    CANOPY_USER_DATA: startupDirectory,
    CANOPY_SMOKE_HOLD_STARTUP: '1',
    CANOPY_SMOKE_HOLD_WINDOW_SAVE: '1',
  };
  const fixture = join(appPath, 'dist', 'smoke-main.cjs');
  const starting = await open([fixture], startupEnv);
  await expect
    .poll(() => starting.evaluate(() => typeof globalThis.canopyReleaseStartup))
    .toBe('function');
  await expect
    .poll(() =>
      starting.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    )
    .toBe(0);
  // A second process must exit before it initializes or writes fixture state.
  await Promise.all(
    Array.from({ length: 3 }, () => duplicate([fixture], startupEnv)),
  );
  expect(await readdir(startupDirectory)).not.toContain('rank-attempts.json');
  expect(await starting.evaluate(() => globalThis.canopySecondLaunches)).toBe(
    3,
  );
  await starting.evaluate(() => globalThis.canopyReleaseStartup());
  await starting.firstWindow();
  await verifyFocus(starting, 'launch during startup');
  await expect
    .poll(() =>
      readFile(join(startupDirectory, 'rank-attempts.json'), 'utf8').catch(
        () => null,
      ),
    )
    .toBe('0');
  await writeFile(join(startupDirectory, 'workspace.json.tmp'), 'stale');
  await starting.evaluate(({ BrowserWindow }) => {
    globalThis.canopyHoldWindowSave = true;
    const closing = BrowserWindow.getAllWindows()[0];
    globalThis.canopyClosingWindowId = closing.id;
    closing.close();
  });
  await expect
    .poll(() =>
      starting.evaluate(() => typeof globalThis.canopyReleaseWindowSave),
    )
    .toBe('function');
  await Promise.all([
    duplicate([fixture], startupEnv),
    duplicate([fixture], startupEnv),
  ]);
  expect(
    await starting.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  await starting.evaluate(() => {
    globalThis.canopyHoldWindowSave = false;
    globalThis.canopyReleaseWindowSave();
  });
  await expect
    .poll(() =>
      starting.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return (
          windows.length === 1 &&
          !windows[0].isDestroyed() &&
          windows[0].id !== globalThis.canopyClosingWindowId &&
          globalThis.canopySecondLaunches === 5
        );
      }),
    )
    .toBe(true);
  await verifyFocus(starting, 'duplicate launch during pending close');
  await expect(
    (await starting.firstWindow()).getByRole('heading', {
      name: 'See the whole tree.',
    }),
  ).toBeVisible();
  await starting.close();
  sessions.splice(sessions.indexOf(starting), 1);
  expect(
    await readFile(join(startupDirectory, 'workspace.json.tmp'), 'utf8'),
  ).toBe('stale');
  await normal.close();
  sessions.splice(sessions.indexOf(normal), 1);
  console.log(
    'Instance state checks passed: rapid duplicate launches, window restoration, independent demo and smoke profiles, duplicate launches during startup and normal/demo close, and ordinary demo exit.',
  );
  if (focusFailures.length)
    throw new AggregateError(
      focusFailures,
      'Instance focus verification failed; state checks passed.',
    );
  if (!stateOnly) console.log('Instance focus checks passed.');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const session of sessions.reverse())
    await session.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
