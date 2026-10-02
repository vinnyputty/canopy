// Source review and a fresh exclusive desktop token precede this launcher.
if (
  !process.env.CANOPY_DESKTOP_TOKEN ||
  !process.env.CANOPY_ELECTRON_PATH ||
  !process.env.CANOPY_PERF_PAIR
) {
  throw new Error(
    'Explicit CANOPY_DESKTOP_TOKEN, CANOPY_ELECTRON_PATH and prepared CANOPY_PERF_PAIR are required. This audit launches Electron.',
  );
}
const { readFile, writeFile, mkdir, rm } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const { join } = await import('node:path');
const manifest = JSON.parse(
  await readFile(process.env.CANOPY_PERF_PAIR, 'utf8'),
);
if (process.env.CANOPY_PERF_APPROVED_HEAD !== manifest.candidate)
  throw new Error(
    'Fresh source approval must identify this exact candidate via CANOPY_PERF_APPROVED_HEAD.',
  );
if (
  manifest.base !== 'af0808d41d39d3f9252b620723014bd76baf953f' ||
  !/^[a-f0-9]{40}$/.test(manifest.candidate)
)
  throw new Error('Expected exact base/current candidate source IDs.');
for (const build of manifest.builds) {
  for (const [file, hash] of Object.entries(build.files)) {
    const actual = createHash('sha256')
      .update(await readFile(join(build.stage, 'dist', file)))
      .digest('hex');
    if (actual !== hash)
      throw new Error(`Prepared bundle changed: ${build.label}/${file}`);
  }
}
const { _electron: electron, expect } = await import('@playwright/test');
const output =
  process.env.CANOPY_PERF_DESKTOP_OUTPUT ?? '/tmp/canopy-perf-90-desktop.json';
const report = {
  manifest,
  electron: process.env.CANOPY_ELECTRON_PATH,
  samples: [],
  limitations: manifest.limitations,
};
const persist = () => writeFile(output, JSON.stringify(report, null, 2));
// Alternating pairs reduce ordering drift. These are single samples; repeat
// complete pairs with a new output file for a distribution, never mix sources.
for (const provider of ['jira', 'github'])
  for (const shape of ['wide', 'tiered', 'deep']) {
    for (const build of manifest.builds) {
      const spec = manifest.scenarios
        .find((s) => s.label === build.label)
        .counts.find((s) => s.provider === provider && s.shape === shape);
      const roots = manifest.scenarios
        .find((s) => s.label === build.label)
        .counts.filter((s) => s.provider === provider);
      const profile = join(build.stage, `profile-${provider}-${shape}`);
      await rm(profile, { recursive: true, force: true });
      await mkdir(profile, { recursive: true });
      const env = {
        ...process.env,
        CANOPY_USER_DATA: profile,
        CANOPY_PERF_PROVIDER: provider,
        CANOPY_PERF_SHAPE: shape,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const sample = {
        source: build.source,
        label: build.label,
        provider,
        shape,
        expected: spec,
        phases: [],
        memory: [],
      };
      report.samples.push(sample);
      const started = performance.now();
      let app,
        page,
        timer,
        phase = 'launch';
      let memoryPending;
      const memory = async () => {
        if (!app) return;
        if (memoryPending) return memoryPending;
        memoryPending = app
          .evaluate(
            async ({ app }, tag) => ({
              phase: tag,
              at: performance.now(),
              timeOrigin: performance.timeOrigin,
              processes: app.getAppMetrics(),
              main: await process.getProcessMemoryInfo(),
            }),
            phase,
          )
          .then((entry) => {
            sample.memory.push(entry);
          })
          .catch((error) => {
            sample.memoryError = String(error);
          })
          .finally(() => {
            memoryPending = undefined;
          });
        return memoryPending;
      };
      const paint = () =>
        page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
      const begin = async (name) => {
        phase = name;
        await page.evaluate((name) => window.canopyPerfUI.phase(name), name);
        await memory();
        return performance.now();
      };
      const end = async (name, start) => {
        await paint();
        const detail = await page.evaluate(() => ({
          treeRows: document.querySelectorAll('[data-tree-key]').length,
          savedRows: document.querySelectorAll('.saved-view-result').length,
          elements: document.getElementsByTagName('*').length,
        }));
        sample.phases.push({
          name,
          wallThroughPaintOpportunityMs: performance.now() - start,
          ...detail,
        });
        await memory();
      };
      const complete = async (selected, cursor = 0) => {
        // Error/incomplete returns and disappearing Cancel buttons do not satisfy
        // this condition. Require exact normalized counts on each selected root.
        await expect
          .poll(
            async () =>
              page.evaluate(
                ({ selected, cursor }) => {
                  const events = window.canopyPerfAudit
                    .events()
                    .events.slice(cursor);
                  return selected.every((root) =>
                    events.some(
                      (e) =>
                        e.event === 'ipc-delivery' &&
                        e.root === root.root &&
                        e.count === root.issues &&
                        e.incomplete === false,
                    ),
                  );
                },
                { selected, cursor },
              ),
            { timeout: 180000 },
          )
          .toBe(true);
      };
      try {
        app = await electron.launch({
          executablePath: process.env.CANOPY_ELECTRON_PATH,
          args: [build.stage],
          env,
        });
        timer = setInterval(() => {
          void memory();
        }, 250);
        page = await app.firstWindow();
        page.setDefaultTimeout(180000);
        phase = 'initial-load';
        await memory();
        await expect(page.getByRole('tree')).toBeVisible();
        sample.firstVisibleTreeWallMs = performance.now() - started;
        await complete([spec]);
        await expect(page.locator('[data-tree-key]')).toHaveCount(
          spec.expandedRows,
        );
        await end('initial-load', started);
        const initial = await page.evaluate(() => ({
          ipc: window.canopyPerfAudit.events(),
          ui: window.canopyPerfUI.events(),
        }));
        const progress = initial.ipc.events.find(
          (e) =>
            e.event === 'ipc-progress' &&
            e.root === spec.root &&
            e.incomplete &&
            e.count < spec.issues,
        );
        const full = initial.ipc.events.find(
          (e) =>
            e.event === 'ipc-delivery' &&
            e.root === spec.root &&
            !e.incomplete &&
            e.count === spec.issues,
        );
        const fullCommit = initial.ui.events.find(
          (e) => e.event === 'dom-commit' && e.treeRows === spec.expandedRows,
        );
        const fullPaint =
          fullCommit &&
          initial.ui.events.find(
            (e) =>
              e.event === 'paint-opportunity' &&
              e.at >= fullCommit.at &&
              e.treeRows === spec.expandedRows,
          );
        const partialCommit =
          progress &&
          fullCommit &&
          initial.ui.events.find(
            (e) =>
              e.event === 'dom-commit' &&
              e.treeRows > 0 &&
              e.treeRows < spec.expandedRows &&
              initial.ui.timeOrigin + e.at >=
                initial.ipc.timeOrigin + progress.at &&
              e.at < fullCommit.at,
          );
        const partialPaint =
          partialCommit &&
          initial.ui.events.find(
            (e) =>
              e.event === 'paint-opportunity' &&
              e.at >= partialCommit.at &&
              e.at < fullCommit.at &&
              e.treeRows > 0 &&
              e.treeRows < spec.expandedRows,
          );
        sample.firstPartial = progress
          ? {
              ipc: progress,
              domCommit: partialCommit ?? null,
              paintOpportunity: partialPaint ?? null,
              paintOpportunityBeforeFullCommit: Boolean(partialPaint),
            }
          : { state: 'No partial progress emitted by this exact source' };
        sample.fullCompletion = {
          ipc: full,
          domCommit: fullCommit ?? null,
          paintOpportunity: fullPaint ?? null,
        };
        let start = await begin('tree-filter');
        await page
          .getByRole('textbox', { name: 'Find in tree' })
          .fill('region 3');
        await expect(page.locator('[data-tree-key]')).toHaveCount(
          spec.filterRows,
        );
        await end('tree-filter', start);
        start = await begin('tree-filter-clear');
        await page.getByRole('textbox', { name: 'Find in tree' }).fill('');
        await expect(page.locator('[data-tree-key]')).toHaveCount(
          spec.expandedRows,
        );
        await end('tree-filter-clear', start);
        start = await begin('tree-scroll');
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
        await end('tree-scroll', start);
        start = await begin('tree-collapse');
        await page
          .getByRole('button', { name: 'Collapse', exact: true })
          .click();
        // Collapse all keeps only the root; the fixture's initial root expansion
        // (spec.collapsedRows) is a separate recorded state.
        await expect(page.locator('[data-tree-key]')).toHaveCount(1);
        await end('tree-collapse', start);
        start = await begin('tree-expand');
        await page.getByRole('button', { name: 'Expand', exact: true }).click();
        await expect(page.locator('[data-tree-key]')).toHaveCount(
          spec.expandedRows,
        );
        await end('tree-expand', start);
        const row = page.locator('[data-tree-key]').first();
        await row.focus();
        await page.keyboard.press('ArrowDown');
        sample.keyboardFocusedKey = await page.evaluate(() =>
          document.activeElement
            ?.closest('[data-tree-key]')
            ?.getAttribute('data-tree-key'),
        );
        start = await begin('saved-view-load');
        await page
          .getByRole('button', { name: 'Saved view: Large roots', exact: true })
          .click();
        await complete(roots);
        await expect(page.locator('.saved-view-result')).toHaveCount(
          spec.savedRows,
        );
        await expect(
          page.getByRole('button', { name: 'Cancel loads', exact: true }),
        ).toHaveCount(0);
        await end('saved-view-load', start);
        const cursor = await page.evaluate(
          () => window.canopyPerfAudit.events().events.length,
        );
        sample.callsBeforeSavedRefresh = await app.evaluate(() =>
          globalThis.canopyPerf.calls(),
        );
        start = await begin('saved-view-refresh');
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await complete(roots, cursor);
        await expect(page.locator('.saved-view-result')).toHaveCount(
          spec.savedRows,
        );
        await expect(
          page.getByRole('button', { name: 'Cancel loads', exact: true }),
        ).toHaveCount(0);
        await end('saved-view-refresh', start);
        sample.providerCalls = await app.evaluate(() =>
          globalThis.canopyPerf.calls(),
        );
        sample.providerEvents = await app.evaluate(() =>
          globalThis.canopyPerf.events(),
        );
        sample.rendererEvents = await page.evaluate(() => ({
          ipc: window.canopyPerfAudit.events(),
          ui: window.canopyPerfUI.events(),
        }));
        sample.outcome = 'complete';
      } catch (error) {
        sample.outcome = 'failed';
        sample.error = String(error);
        if (page)
          sample.rendererEvents = await page
            .evaluate(() => ({
              ipc: window.canopyPerfAudit?.events(),
              ui: window.canopyPerfUI?.events(),
            }))
            .catch(() => null);
        if (app)
          sample.providerEvents = await app
            .evaluate(() => globalThis.canopyPerf?.events())
            .catch(() => null);
      } finally {
        clearInterval(timer);
        await memory();
        const residentSamples = sample.memory.map((entry) => ({
          phase: entry.phase,
          at: entry.at,
          // Electron process metrics use KiB. Main is already in this sum;
          // the separate getProcessMemoryInfo sample is not added twice.
          workingSetKiB: entry.processes.reduce(
            (sum, process) => sum + (process.memory?.workingSetSize ?? 0),
            0,
          ),
        }));
        sample.sampledMemory = {
          cadenceMs: 250,
          samples: residentSamples.length,
          sampledPeakWorkingSetKiB: Math.max(
            0,
            ...residentSamples.map((s) => s.workingSetKiB),
          ),
          phases: [...new Set(residentSamples.map((s) => s.phase))].map(
            (phase) => {
              const samples = residentSamples.filter((s) => s.phase === phase);
              return {
                phase,
                startWorkingSetKiB: samples[0].workingSetKiB,
                endWorkingSetKiB: samples.at(-1).workingSetKiB,
                growthWorkingSetKiB:
                  samples.at(-1).workingSetKiB - samples[0].workingSetKiB,
                sampledPeakWorkingSetKiB: Math.max(
                  ...samples.map((s) => s.workingSetKiB),
                ),
              };
            },
          ),
        };
        // Persist failures and partial telemetry before closing any session.
        await persist();
        await app?.close();
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
await persist();
if (report.samples.some((s) => s.outcome !== 'complete'))
  throw new Error(`Incomplete audit: see ${output}`);
