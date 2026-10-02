import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'canopy-branding-'));
const packaged = process.env.CANOPY_PACKAGED_EXE;
const appPath = process.env.CANOPY_APP_PATH;
const manifest = JSON.parse(
  await readFile(join(appPath, 'package.json'), 'utf8'),
);
const env = { ...process.env, CANOPY_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: packaged || process.env.CANOPY_ELECTRON_PATH,
    args: packaged ? [] : [appPath],
    env,
  });
  let page = await app.firstWindow();
  const watch = (page) => page.on('pageerror', (error) => errors.push(error));
  watch(page);
  await expect(
    page.getByRole('button', { name: 'About & Support', exact: true }),
  ).toBeVisible();
  // Intercept the OS browser boundary in this disposable test process. Exercise
  // the real validated IPC handlers and menu callbacks, including failure/retry.
  await app.evaluate(({ shell }) => {
    globalThis.brandingTest = { urls: [], fail: false };
    shell.openExternal = async (url) => {
      if (globalThis.brandingTest.fail) throw new Error('Browser unavailable');
      globalThis.brandingTest.urls.push(url);
    };
  });
  await page
    .getByRole('button', { name: 'About & Support', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'About & Support' });
  await expect(
    dialog.getByText(`Version ${manifest.version}`, { exact: true }),
  ).toBeVisible();
  assert.equal(
    await app.evaluate(({ app }) => app.getVersion()),
    manifest.version,
  );
  await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 1024);
  const destinations = [
    ['Releases', 'https://github.com/vinnyputty/canopy/releases'],
    ['Documentation', 'https://github.com/vinnyputty/canopy#readme'],
    [
      'Report an issue',
      'https://github.com/vinnyputty/canopy/issues/new/choose',
    ],
  ];
  for (const [label] of destinations)
    await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.brandingTest.urls))
    .toEqual(destinations.map(([, url]) => url));
  await app.evaluate(() => {
    globalThis.brandingTest.fail = true;
  });
  await dialog
    .getByRole('button', { name: 'Documentation', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Could not open the link',
  );
  await app.evaluate(() => {
    globalThis.brandingTest.fail = false;
  });
  await dialog
    .getByRole('button', { name: 'Documentation', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeHidden();
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.canopy.openSupportLink('https://example.invalid');
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  );
  await page
    .getByRole('button', { name: 'About & Support', exact: true })
    .last()
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'Help')
      .submenu.items.find((item) => item.label === 'About & Support')
      .click(),
  );
  await expect(dialog).toBeVisible();
  for (const [label] of destinations) {
    await app.evaluate(
      ({ Menu }, label) =>
        Menu.getApplicationMenu()
          .items.find((item) => item.label === 'Help')
          .submenu.items.find((item) => item.label === label)
          .click(),
      label,
    );
  }
  await expect
    .poll(() => app.evaluate(() => globalThis.brandingTest.urls.slice(-3)))
    .toEqual(destinations.map(([, url]) => url));
  const identity = await app.evaluate(({ app, BrowserWindow, nativeImage }) => {
    const { join } = process.getBuiltinModule('node:path');
    const { existsSync } = process.getBuiltinModule('node:fs');
    const root = app.getAppPath();
    return {
      title: BrowserWindow.getAllWindows()[0].getTitle(),
      png: nativeImage
        .createFromPath(join(root, 'dist/branding/icons/256x256.png'))
        .getSize(),
      ico: existsSync(join(root, 'dist/branding/icon.ico')),
      icns: existsSync(join(root, 'dist/branding/icon.icns')),
    };
  });
  assert.equal(identity.title, 'Canopy');
  assert.deepEqual(identity.png, { width: 256, height: 256 });
  assert.equal(identity.ico, true);
  assert.equal(identity.icns, true);
  if (process.platform === 'darwin') {
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Canopy')
        .submenu.items.find((item) => item.label === 'About Canopy')
        .click(),
    );
    await expect(dialog).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect.poll(() => app.windows().length).toBe(0);
    const next = app.waitForEvent('window');
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Canopy')
        .submenu.items.find((item) => item.label === 'About Canopy')
        .click(),
    );
    page = await next;
    watch(page);
    dialog = page.getByRole('dialog', { name: 'About & Support' });
    await expect(
      dialog.getByText(`Version ${manifest.version}`, { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Releases', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.brandingTest.urls.at(-1)))
      .toBe(destinations[0][1]);
  }
  assert.deepEqual(errors, []);
  console.log(
    `Branding Electron checks passed (${packaged ? 'packaged' : 'staged'}): version, links, failure/retry, menus, palette, icons, About reopening.`,
  );
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
