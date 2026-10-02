// Run only after source review and an explicit exclusive desktop token.
if (!process.env.CANOPY_DESKTOP_TOKEN || !process.env.CANOPY_ELECTRON_PATH) {
  throw new Error(
    'An explicitly granted CANOPY_DESKTOP_TOKEN and CANOPY_ELECTRON_PATH are required. This audit launches Electron.',
  );
}
const { _electron: electron, expect } = await import('@playwright/test');
const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const root = new URL('..', import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), 'canopy-perf-desktop-'));
const measurements = [];
try {
  await cp(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'canopy-performance-sample',
      version: '0.0.0',
      main: 'dist/performance-main.cjs',
    }),
  );
  for (const provider of ['jira', 'github']) {
    const env = {
      ...process.env,
      CANOPY_USER_DATA: join(directory, provider),
      CANOPY_PERF_PROVIDER: provider,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    const sample = { provider };
    const started = performance.now();
    try {
      app = await electron.launch({
        executablePath: process.env.CANOPY_ELECTRON_PATH,
        args: [directory],
        env,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(60000);
      await expect(page.getByRole('tree')).toBeVisible();
      sample.firstTreeWallMs = performance.now() - started;
      await expect(
        page.getByRole('button', { name: 'Cancel load', exact: true }),
      ).toHaveCount(0);
      sample.initialRootWallMs = performance.now() - started;
      await page.evaluate(() => {
        globalThis.canopyLongTasks = [];
        new PerformanceObserver((list) =>
          globalThis.canopyLongTasks.push(
            ...list.getEntries().map((entry) => entry.duration),
          ),
        ).observe({ type: 'longtask', buffered: true });
      });
      const initialRows = await page.locator('[data-tree-key]').count();
      sample.expandedDomRows = initialRows;
      const filterStarted = performance.now();
      await page
        .getByRole('textbox', { name: 'Find in tree' })
        .fill('region 3');
      await expect
        .poll(() => page.locator('[data-tree-key]').count())
        .toBeLessThan(initialRows);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      sample.filterPaintWallMs = performance.now() - filterStarted;
      await page.getByRole('textbox', { name: 'Find in tree' }).fill('');
      await expect(page.locator('[data-tree-key]')).toHaveCount(initialRows);
      sample.scroll = await page.evaluate(async () => {
        const element = document.querySelector('.tree-scroll');
        const intervals = [];
        let previous = performance.now();
        for (let i = 0; i < 120; i++) {
          element.scrollTop = i * 300;
          const now = await new Promise((resolve) =>
            requestAnimationFrame(resolve),
          );
          intervals.push(now - previous);
          previous = now;
        }
        intervals.sort((a, b) => a - b);
        return {
          frameP50Ms: intervals[60],
          frameP95Ms: intervals[114],
          finalScrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
        };
      });
      const row = page.locator('[data-tree-key]').first();
      await row.focus();
      await page.keyboard.press('ArrowDown');
      sample.keyboardFocusedKey = await page.evaluate(() =>
        document.activeElement
          ?.closest('[data-tree-key]')
          ?.getAttribute('data-tree-key'),
      );
      await page
        .getByRole('button', { name: 'Large roots', exact: true })
        .click();
      const refreshStarted = performance.now();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Cancel loads', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Cancel loads', exact: true }),
      ).toHaveCount(0);
      sample.savedViewRefreshWallMs = performance.now() - refreshStarted;
      sample.savedViewDomRows = await page.getByRole('listitem').count();
      sample.longTasksMs = await page.evaluate(
        () => globalThis.canopyLongTasks,
      );
      sample.providerCalls = await app.evaluate(() =>
        globalThis.canopyPerf.calls(),
      );
      sample.processMemory = await app.evaluate(async ({ app }) => ({
        processes: app.getAppMetrics(),
        main: await process.getProcessMemoryInfo(),
      }));
      measurements.push(sample);
    } finally {
      await app?.close();
    }
  }
  await writeFile(
    process.env.CANOPY_PERF_DESKTOP_OUTPUT ??
      join(tmpdir(), 'canopy-perf-90-desktop.json'),
    JSON.stringify(measurements, null, 2),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
