import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const packaged = process.env.CANOPY_PACKAGED_EXE;
const appPath = process.env.CANOPY_APP_PATH;
if (!appPath?.trim()) throw new Error('CANOPY_APP_PATH is required.');
const manifest = JSON.parse(
  await readFile(join(appPath, 'package.json'), 'utf8'),
);
const directory = await mkdtemp(join(tmpdir(), 'canopy-branding-'));
const env = { ...process.env, CANOPY_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
if (!packaged) env.CANOPY_SMOKE_BRANDING = '1';
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: packaged || process.env.CANOPY_ELECTRON_PATH,
    args: packaged ? [] : [appPath],
    env,
  });
  if (!packaged) {
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.canopyBrandingCreation?.reading),
      )
      .toBe(true);
    await app.evaluate(({ app, Menu }) => {
      const about = Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Help')
        .submenu.items.find((item) => item.label === 'About & Support');
      app.emit('activate');
      about.click();
      about.click();
      about.click();
    });
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      0,
    );
    await app.evaluate(() =>
      globalThis.canopyBrandingCreation.releaseCreation(),
    );
  }
  let page = await app.firstWindow();
  const watch = (page) => page.on('pageerror', (error) => errors.push(error));
  watch(page);
  await expect(
    page.getByRole('button', { name: 'About & Support', exact: true }),
  ).toBeVisible();
  if (!packaged) {
    await expect
      .poll(() =>
        app.evaluate(() => globalThis.canopyBrandingCreation.subscribing),
      )
      .toBe(true);
    await expect(
      page.getByRole('dialog', { name: 'About & Support' }),
    ).toBeHidden();
    await app.evaluate(() =>
      globalThis.canopyBrandingCreation.releaseSubscription(),
    );
    const early = page.getByRole('dialog', { name: 'About & Support' });
    await expect(
      early.getByText(`Version ${manifest.version}`, { exact: true }),
    ).toBeVisible();
    await expect(
      early.getByRole('button', { name: 'Close dialog' }),
    ).toBeFocused();
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
    await page.keyboard.press('Escape');
  }
  const supportButton = page.getByRole('button', {
    name: 'About & Support',
    exact: true,
  });
  for (const close of ['escape', 'button', 'backdrop']) {
    await supportButton.focus();
    await supportButton.press('Enter');
    const modal = page.getByRole('dialog', { name: 'About & Support' });
    const first = modal.getByRole('button', { name: 'Close dialog' });
    const last = modal.getByRole('button', {
      name: 'Report an issue',
      exact: true,
    });
    await expect(first).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'button') await first.click();
    else
      await page
        .locator('.dialog-backdrop')
        .click({ position: { x: 1, y: 1 } });
    await expect(modal).toBeHidden();
    await expect(supportButton).toBeFocused();
  }
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
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette
    .getByRole('option')
    .filter({ hasText: 'About & Support' })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(supportButton).toBeFocused();
  const priorFocus = page.getByRole('button', {
    name: 'Settings',
    exact: true,
  });
  await priorFocus.focus();
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
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(priorFocus).toBeFocused();
  // About can replace Settings without changing its reading preferences or
  // stranding Settings' keyboard return target.
  await priorFocus.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await app.evaluate(({ Menu }) => {
    const about = Menu.getApplicationMenu()
      .items.find((item) => item.label === 'Help')
      .submenu.items.find((item) => item.label === 'About & Support');
    about.click();
    about.click();
  });
  await expect(
    dialog.getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(priorFocus).toBeFocused();
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
    if (!packaged)
      await app.evaluate(() => {
        globalThis.canopyBrandingCreation.holdCreation = true;
        globalThis.canopyBrandingCreation.holdSubscription = true;
      });
    await app.evaluate(({ app, Menu }) => {
      const about = Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Canopy')
        .submenu.items.find((item) => item.label === 'About Canopy');
      app.emit('activate');
      about.click();
      about.click();
      about.click();
    });
    if (!packaged) {
      await expect
        .poll(() =>
          app.evaluate(() => globalThis.canopyBrandingCreation.reading),
        )
        .toBe(true);
      assert.equal(
        await app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
        0,
      );
      await app.evaluate(() =>
        globalThis.canopyBrandingCreation.releaseCreation(),
      );
    }
    page = await next;
    watch(page);
    dialog = page.getByRole('dialog', { name: 'About & Support' });
    if (!packaged) {
      await expect
        .poll(() =>
          app.evaluate(() => globalThis.canopyBrandingCreation.subscribing),
        )
        .toBe(true);
      await expect(dialog).toBeHidden();
      await app.evaluate(() =>
        globalThis.canopyBrandingCreation.releaseSubscription(),
      );
    }
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
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
    `Branding Electron checks passed (${packaged ? 'packaged' : 'staged'}): version, links, failure/retry, menus, palette, icons, serialized creation/readiness, modal focus/restoration, About reopening.`,
  );
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
