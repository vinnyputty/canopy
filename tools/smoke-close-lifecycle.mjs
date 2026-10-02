import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function closed(app) {
  return expect
    .poll(
      () =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      { timeout: 25_000 },
    )
    .toBe(0);
}

async function keepProcessAlive(app) {
  // Window assertions precede Playwright's inspector disconnect in app.close().
  // A listener prevents Electron's default quit when the last window closes.
  await app.evaluate(({ app }) => {
    app.removeAllListeners('window-all-closed');
    app.on('window-all-closed', () => {});
  });
}

async function holdWorkspaceReplacement(app) {
  await app.evaluate(async () => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const original = fs.rename;
    const audit = { release: null };
    globalThis.closePendingWrite = audit;
    fs.rename = (source, destination) => {
      if (!String(destination).endsWith('workspace.json'))
        return original(source, destination);
      return new Promise((resolve, reject) => {
        audit.release = () => {
          fs.rename = original;
          original(source, destination).then(resolve, reject);
        };
      });
    };
  });
}

export async function auditCloseLifecycle({
  launch,
  close,
  current,
  userData,
}) {
  let { app, page } = current();
  await keepProcessAlive(app);
  const launchLifecycle = async () => {
    await launch();
    ({ app, page } = current());
    await keepProcessAlive(app);
  };
  await page.evaluate(() => window.canopy.flushWorkspace());
  await holdWorkspaceReplacement(app);
  await page.evaluate(async () => {
    const workspace = await window.canopy.loadWorkspace();
    void window.canopy.saveWorkspace({ ...workspace, sidebarCollapsed: true });
  });
  await expect
    .poll(() => app.evaluate(() => !!globalThis.closePendingWrite.release))
    .toBe(true);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.forcefullyCrashRenderer();
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  const crashClosed = closed(app);
  await app.evaluate(() => globalThis.closePendingWrite.release());
  await crashClosed;
  await close();
  expect(
    JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8'))
      .sidebarCollapsed,
  ).toBe(true);

  await launchLifecycle();
  const failedLoadClosed = closed(app);
  await app.evaluate(async ({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    try {
      await window.loadFile(app.getPath('userData') + '/missing-renderer.html');
      throw new Error('Missing renderer unexpectedly loaded.');
    } catch (error) {
      if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
    }
    window.close();
  });
  await failedLoadClosed;
  await close();

  await launchLifecycle();
  await page.evaluate(() => window.canopy.flushWorkspace());
  await app.evaluate(({ dialog }) => {
    globalThis.closeTimeoutDialogs = [];
    globalThis.closeOriginalDialog = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.closeTimeoutDialogs.push(options);
      return {
        response: globalThis.closeTimeoutDialogs.length === 1 ? 0 : 1,
        checkboxChecked: false,
      };
    };
  });
  await page.evaluate(() => {
    window.setTimeout(() => {
      while (true) {
        /* Intentionally hang the renderer. */
      }
    }, 0);
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.closeTimeoutDialogs.length), {
      timeout: 25_000,
    })
    .toBe(1);
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  const prompt = await app.evaluate(() => globalThis.closeTimeoutDialogs[0]);
  expect(prompt.buttons).toEqual(['Keep open', 'Close anyway']);
  expect(prompt.defaultId).toBe(0);
  expect(prompt.cancelId).toBe(0);
  const hungClosed = closed(app);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await hungClosed;
  expect(await app.evaluate(() => globalThis.closeTimeoutDialogs.length)).toBe(
    2,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.closeOriginalDialog;
  });
  await close();
  await launchLifecycle();
  await page.evaluate(() => window.canopy.flushWorkspace());
  const beforeStall = JSON.parse(
    await readFile(join(userData, 'workspace.json'), 'utf8'),
  );
  await holdWorkspaceReplacement(app);
  await page.evaluate(async () => {
    const workspace = await window.canopy.loadWorkspace();
    void window.canopy.saveWorkspace({
      ...workspace,
      sidebarCollapsed: !workspace.sidebarCollapsed,
    });
  });
  await expect
    .poll(() => app.evaluate(() => !!globalThis.closePendingWrite.release))
    .toBe(true);
  await app.evaluate(({ dialog }) => {
    globalThis.closeTimeoutDialogs = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.closeTimeoutDialogs.push(options);
      return {
        response: globalThis.closeTimeoutDialogs.length === 1 ? 0 : 1,
        checkboxChecked: false,
      };
    };
  });
  // Crash during an active flush with both workspace and bounds writes stalled.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.closeTimeoutDialogs.length), {
      timeout: 25_000,
    })
    .toBe(1);
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  expect(
    await app.evaluate(() => globalThis.closeTimeoutDialogs[0].detail),
  ).toContain('abandons unfinished writes');
  const stalledClosed = closed(app);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await stalledClosed;
  expect(await app.evaluate(() => globalThis.closeTimeoutDialogs.length)).toBe(
    2,
  );
  await close();
  expect(
    JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8')),
  ).toEqual(beforeStall);
  // Leave the caller with a fresh launch and production quit behavior.
  await launch();
  console.log(
    'Close lifecycle passed: crash drains available writes, failed load closes, renderer and main-write stalls share a deadline with keep-open or explicit abandonment.',
  );
}
