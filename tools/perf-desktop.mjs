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
const { readFile, writeFile, mkdtemp, rm } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const { join } = await import('node:path');
const manifestBytes = await readFile(process.env.CANOPY_PERF_PAIR);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const approvedBase = process.env.CANOPY_PERF_APPROVED_BASE;
const approvedHead = process.env.CANOPY_PERF_APPROVED_HEAD;
const approvedManifest = process.env.CANOPY_PERF_APPROVED_MANIFEST_SHA256;
if (
  !/^[a-f0-9]{40}$/.test(approvedBase ?? '') ||
  !/^[a-f0-9]{40}$/.test(approvedHead ?? '') ||
  !/^[a-f0-9]{64}$/.test(approvedManifest ?? '')
)
  throw new Error(
    'Fresh source approval must identify exact CANOPY_PERF_APPROVED_BASE, CANOPY_PERF_APPROVED_HEAD and CANOPY_PERF_APPROVED_MANIFEST_SHA256.',
  );
if (
  createHash('sha256').update(manifestBytes).digest('hex') !== approvedManifest
)
  throw new Error('Approved manifest changed.');
if (
  manifest.base !== approvedBase ||
  manifest.candidate !== approvedHead ||
  manifest.harnessSource !== approvedHead
)
  throw new Error('Approved base/candidate/harness source mismatch.');
const harnessFiles = [
  'tests/fixtures/performance-main.ts',
  'tests/fixtures/large-trees.ts',
  'tests/fixtures/performance-preload.ts',
  'tests/fixtures/performance-ui.ts',
  'tools/perf-desktop.mjs',
  'tools/audit-lifecycle.mjs',
  'tools/prepare-perf-desktop.mjs',
];
const bundleFiles = [
  'performance-main.cjs',
  'production-preload.cjs',
  'preload.cjs',
  'renderer/app.js',
  'renderer/app.css',
  'renderer/audit.js',
  'renderer/index.html',
];
const exactHashes = (hashes, files) =>
  hashes &&
  Object.keys(hashes).length === files.length &&
  files.every((file) => /^[a-f0-9]{64}$/.test(hashes[file] ?? ''));
if (
  !exactHashes(manifest.harness, harnessFiles) ||
  manifest.builds?.length !== 2 ||
  manifest.scenarios?.length !== 2
)
  throw new Error('Incomplete approved paired manifest.');
for (const [label, source] of [
  ['base', approvedBase],
  ['candidate', approvedHead],
]) {
  const builds = manifest.builds.filter(
    (build) => build.label === label && build.source === source,
  );
  const scenarios = manifest.scenarios.filter(
    (scenario) => scenario.label === label && scenario.source === source,
  );
  if (
    builds.length !== 1 ||
    scenarios.length !== 1 ||
    !exactHashes(builds[0].files, bundleFiles) ||
    scenarios[0].counts?.length !== 6
  )
    throw new Error(
      'Paired source ownership or complete scenario coverage changed.',
    );
  for (const provider of ['jira', 'github'])
    for (const shape of ['wide', 'tiered', 'deep']) {
      const specs = scenarios[0].counts.filter(
        (spec) => spec.provider === provider && spec.shape === shape,
      );
      if (
        specs.length !== 1 ||
        !specs[0].root ||
        !specs[0].keyboardNextKey ||
        [
          'issues',
          'expandedRows',
          'collapsedRows',
          'filterRows',
          'savedRows',
        ].some(
          (field) =>
            !Number.isSafeInteger(specs[0][field]) || specs[0][field] < 1,
        )
      )
        throw new Error('Required full-count scenario conditions changed.');
    }
}
for (const [file, hash] of Object.entries(manifest.harness)) {
  const actual = createHash('sha256')
    .update(await readFile(new URL(`../${file}`, import.meta.url)))
    .digest('hex');
  if (actual !== hash) throw new Error(`Approved harness changed: ${file}`);
}
for (const build of manifest.builds) {
  for (const [file, hash] of Object.entries(build.files)) {
    const actual = createHash('sha256')
      .update(await readFile(join(build.stage, 'dist', file)))
      .digest('hex');
    if (actual !== hash)
      throw new Error(`Prepared bundle changed: ${build.label}/${file}`);
  }
}
const { AuditOwner, deadline, finishAudit } =
  await import('./audit-lifecycle.mjs');
const { _electron: electron, expect: defaultExpect } =
  await import('@playwright/test');
const LOAD_MS = 180000;
const expect = defaultExpect.configure({ timeout: LOAD_MS });
const output =
  process.env.CANOPY_PERF_DESKTOP_OUTPUT ?? '/tmp/canopy-perf-90-desktop.json';
const report = {
  manifest,
  electron: process.env.CANOPY_ELECTRON_PATH,
  samples: [],
  limitations: manifest.limitations,
};
const persist = () => writeFile(output, JSON.stringify(report, null, 2));
const failures = [];
async function persistFinal(errors) {
  try {
    await deadline(persist, 3000, 'Evidence persistence');
  } catch (error) {
    throw new AggregateError(
      [...errors, error],
      `Evidence persistence failed: ${output}`,
      { cause: errors.length ? errors[0] : error },
    );
  }
}
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
      const profile = await mkdtemp(
        join(build.stage, `profile-${provider}-${shape}-`),
      );
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
        diagnostics: [],
        stderr: [],
      };
      report.samples.push(sample);
      const owner = new AuditOwner({
        profile,
        executable: process.env.CANOPY_ELECTRON_PATH,
      });
      const sampleFailures = [];
      let primary,
        hasPrimary = false;
      const started = performance.now();
      let app,
        page,
        timer,
        phase = 'launch';
      let memoryPending;
      const renderer = (callback, argument) =>
        deadline(
          () => page.evaluate(callback, argument),
          LOAD_MS,
          `Renderer evaluation: ${phase}`,
        );
      const main = (callback, argument) =>
        deadline(
          () => app.evaluate(callback, argument),
          LOAD_MS,
          `Main evaluation: ${phase}`,
        );

      const memory = async () => {
        if (!app) return;
        if (memoryPending) return memoryPending;
        memoryPending = deadline(
          () =>
            main(
              async ({ app }, tag) => ({
                phase: tag,
                at: performance.now(),
                timeOrigin: performance.timeOrigin,
                processes: app.getAppMetrics(),
                main: await process.getProcessMemoryInfo(),
              }),
              phase,
            ),
          5000,
          'Memory snapshot',
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
        deadline(
          () =>
            renderer(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            ),
          LOAD_MS,
          'Paint opportunities',
        );
      const begin = async (name) => {
        phase = name;
        await renderer((name) => window.canopyPerfUI.phase(name), name);
        await memory();
        return performance.now();
      };
      const end = async (name, start) => {
        await paint();
        const detail = await renderer(() => ({
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
      const complete = async (selected, cursor = 0, manualGeneration) => {
        // Error/incomplete returns and disappearing Cancel buttons do not satisfy
        // this condition. Require exact normalized counts on each selected root.
        await expect
          .poll(
            async () =>
              renderer(
                ({ selected, cursor, manualGeneration }) => {
                  const events = window.canopyPerfAudit
                    .events()
                    .events.slice(cursor);
                  return selected.every((root) =>
                    events.some(
                      (e) =>
                        e.event === 'ipc-delivery' &&
                        (manualGeneration === undefined ||
                          e.manualGeneration === manualGeneration) &&
                        e.root === root.root &&
                        e.count === root.issues &&
                        e.incomplete === false,
                    ),
                  );
                },
                { selected, cursor, manualGeneration },
              ),
            { timeout: 180000 },
          )
          .toBe(true);
      };
      try {
        app = await deadline(
          () =>
            owner.launch(() =>
              electron.launch({
                executablePath: process.env.CANOPY_ELECTRON_PATH,
                args: [build.stage],
                env,
                timeout: LOAD_MS,
              }),
            ),
          LOAD_MS,
          'Electron launch',
        );
        owner.confirm(app.process());
        app.process().stderr.on('data', (bytes) => {
          sample.stderr.push(String(bytes).slice(-4096));
          if (sample.stderr.length > 64) sample.stderr.shift();
        });
        timer = setInterval(() => {
          void memory();
        }, 250);
        page = await deadline(() => app.firstWindow(), LOAD_MS, 'First window');
        page.on('crash', () => sample.diagnostics.push('Renderer crash event'));
        page.on('pageerror', (error) =>
          sample.diagnostics.push(String(error.stack ?? error)),
        );
        page.setDefaultTimeout(LOAD_MS);
        phase = 'initial-load';
        await memory();
        await expect(page.getByRole('tree')).toBeVisible();
        sample.firstVisibleTreeWallMs = performance.now() - started;
        await complete([spec]);
        await expect(page.locator('[data-tree-key]')).toHaveCount(
          spec.expandedRows,
        );
        await end('initial-load', started);
        const initial = await renderer(() => ({
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
        sample.scroll = await renderer(async () => {
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
        await expect
          .poll(() =>
            renderer(() =>
              document.activeElement
                ?.closest('[data-tree-key]')
                ?.getAttribute('data-tree-key'),
            ),
          )
          .toBe(spec.keyboardNextKey);
        sample.keyboardFocusedKey = await renderer(() =>
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
        await end('saved-view-load', start);
        const cursor = await renderer(
          () => window.canopyPerfAudit.events().events.length,
        );
        sample.callsBeforeSavedRefresh = await main(() =>
          globalThis.canopyPerf.calls(),
        );
        start = await begin('saved-view-refresh');
        // Arm and click in one renderer turn after real IPC idle: the first
        // subsequent request for each root belongs to this manual generation.
        // Later automatic polls remain telemetry; they cannot invalidate it.
        let manualGeneration;
        await expect
          .poll(
            async () => {
              manualGeneration = await renderer((selected) => {
                if (
                  window.canopyPerfAudit.events().active ||
                  [...document.querySelectorAll('button')].some(
                    (button) => button.textContent.trim() === 'Cancel loads',
                  )
                )
                  return null;
                const button = [...document.querySelectorAll('button')].find(
                  (button) => button.textContent.trim() === 'Refresh',
                );
                if (!button || button.disabled) return null;
                const generation = window.canopyPerfAudit.arm(
                  selected.map((root) => root.root),
                );
                button.click();
                return generation;
              }, roots);
              return manualGeneration !== null;
            },
            { timeout: LOAD_MS },
          )
          .toBe(true);
        sample.manualGeneration = manualGeneration;
        await complete(roots, cursor, manualGeneration);
        await expect(page.locator('.saved-view-result')).toHaveCount(
          spec.savedRows,
        );
        await end('saved-view-refresh', start);
        sample.afterManualCompletion = await renderer(() => ({
          activeIPC: window.canopyPerfAudit.events().active,
          cancelLoadsVisible: [...document.querySelectorAll('button')].some(
            (button) => button.textContent.trim() === 'Cancel loads',
          ),
        }));
        sample.providerCalls = await main(() => globalThis.canopyPerf.calls());
        sample.providerEvents = await main(() =>
          globalThis.canopyPerf.events(),
        );
        sample.rendererEvents = await renderer(() => ({
          ipc: window.canopyPerfAudit.events(),
          ui: window.canopyPerfUI.events(),
        }));
        sample.outcome = 'complete';
      } catch (error) {
        primary = error;
        hasPrimary = true;
        sampleFailures.push(error);
        sample.outcome = 'failed';
        sample.error = String(error);
        if (page)
          sample.rendererEvents = await deadline(
            () =>
              renderer(() => ({
                ipc: window.canopyPerfAudit?.events(),
                ui: window.canopyPerfUI?.events(),
              })),
            3000,
            'Renderer failure evidence',
          ).catch((error) => {
            sample.diagnostics.push(String(error));
            return null;
          });
        if (app)
          sample.providerEvents = await deadline(
            () => main(() => globalThis.canopyPerf?.events()),
            3000,
            'Provider failure evidence',
          ).catch((error) => {
            sample.diagnostics.push(String(error));
            return null;
          });
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
        try {
          await deadline(persist, 3000, 'Evidence persistence');
        } catch (error) {
          sample.diagnostics.push(String(error));
          sampleFailures.push(error);
          if (!hasPrimary) {
            primary = error;
            hasPrimary = true;
          }
        }
        try {
          await finishAudit({
            owner,
            primary,
            close: app ? () => app.close() : undefined,
            diagnostics: app
              ? [
                  {
                    label: 'Main crash evidence',
                    run: async () => {
                      sample.crashes = await main(
                        () => globalThis.canopyPerfCrashes,
                      );
                    },
                  },
                ]
              : [],
            removeProfile: () => rm(profile, { recursive: true, force: true }),
            writeEvidence: persist,
            secondary: (error) => sample.diagnostics.push(String(error)),
          });
        } catch (error) {
          sample.cleanupOrPrimary = String(error);
          if (!hasPrimary) sample.outcome = 'cleanup-failed';
          for (const failure of error instanceof AggregateError
            ? error.errors
            : [error])
            if (!sampleFailures.includes(failure)) sampleFailures.push(failure);
        }
        failures.push(...sampleFailures);
        await persistFinal(failures);
      }
    }
  }
await persistFinal(failures);
if (failures.length || report.samples.some((s) => s.outcome !== 'complete'))
  throw new AggregateError(failures, `Incomplete audit: see ${output}`, {
    cause: failures[0],
  });
