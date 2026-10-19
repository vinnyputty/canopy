import { register } from 'tsx/cjs/api';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const production = (path) =>
  require(
    resolve(
      process.env.CANOPY_PERF_SOURCE ??
        fileURLToPath(new URL('..', import.meta.url)),
      path,
    ),
  );
register();
const implementations = {
  ...production('src/main/jira.ts'),
  ...production('src/main/github.ts'),
};
const { largeProvider } = require('../tests/fixtures/large-trees.ts');
const { buildIssueTree, filterTree, flattenVisible, reconcileSnapshot } =
  production('src/renderer/tree.ts');
const { viewResults, starterViews } = production('src/renderer/saved-views.ts');
const { RootRefreshGate } = production('src/renderer/refresh.ts');
const results = [];
const snapshots = {};
const sources = [];
const fixtures = new Map();
function measure(fn) {
  const times = [];
  let result;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { ms: +times[2].toFixed(2), result };
}
for (const kind of ['jira', 'github']) {
  for (const [shape, size] of [
    ['wide', 9901],
    ['tiered', 10101],
    ['deep', 2001],
  ]) {
    global.gc?.();
    const fixture = largeProvider(
      kind,
      shape,
      size,
      sources.length,
      Number(process.env.CANOPY_PERF_LATENCY_MS ?? 0),
      implementations,
    );
    global.gc?.();
    const heap = process.memoryUsage().heapUsed;
    let firstProgressMs;
    let progressEvents = 0;
    const start = performance.now();
    const snapshot = await fixture.provider.tree(fixture.rootKey, {
      progress: () => {
        progressEvents++;
        firstProgressMs ??= performance.now() - start;
      },
    });
    const load = performance.now() - start;
    global.gc?.();
    const retainedHeap = process.memoryUsage().heapUsed - heap;
    const build = measure(() =>
      buildIssueTree(snapshot.issues, snapshot.rootKey),
    );
    const filter = measure(() =>
      filterTree(build.result, 'region 3', {}, true),
    );
    const flatten = measure(() =>
      flattenVisible(build.result, new Set(snapshot.issues.map((x) => x.key))),
    );

    const reconcile = measure(() =>
      reconcileSnapshot(snapshot, structuredClone(snapshot)),
    );
    const id = `${kind}:${shape}`;
    fixtures.set(id, fixture);
    snapshots[id] = snapshot;
    sources.push({ id, connectionId: kind, rootKey: snapshot.rootKey });
    results.push({
      kind,
      shape,
      issues: snapshot.issues.length,
      calls: fixture.calls(),
      loadMs: +load.toFixed(2),
      retainedHeapMiB: +(retainedHeap / 1048576).toFixed(2),
      snapshotMiB: +(
        Buffer.byteLength(JSON.stringify(snapshot)) / 1048576
      ).toFixed(2),
      buildMs: build.ms,
      filterMs: filter.ms,
      flattenMs: flatten.ms,
      reconcileMs: reconcile.ms,
      firstProgressMs:
        firstProgressMs === undefined ? null : +firstProgressMs.toFixed(2),
      progressEvents,
      expandedRows: flatten.result.length,
    });
  }
}
const view = {
  ...starterViews()[0],
  filters: { assignee: 'any', statuses: [], priority: '', hideDone: true },
};
const saved = measure(() => viewResults(view, sources, snapshots, {}));
const gate = new RootRefreshGate();
let reads = 0;
const refreshCallsBefore = [...fixtures.values()].reduce(
  (sum, fixture) => sum + fixture.calls(),
  0,
);
const refreshStarted = performance.now();
await Promise.all(
  sources.flatMap((source) =>
    Array.from({ length: 3 }, () => {
      const load = gate.load(source.id, false, true, async () => {
        reads++;
        const fixture = fixtures.get(source.id);
        const next = await fixture.provider.tree(fixture.rootKey);
        snapshots[source.id] = next;
        return next;
      });
      return load.promise;
    }),
  ),
);
const refreshMs = performance.now() - refreshStarted;
const refreshedView = measure(() => viewResults(view, sources, snapshots, {}));
const refreshCalls =
  [...fixtures.values()].reduce((sum, fixture) => sum + fixture.calls(), 0) -
  refreshCallsBefore;
process.stdout.write(
  JSON.stringify(
    {
      source: process.env.CANOPY_PERF_SOURCE ?? 'worktree',
      head:
        process.env.CANOPY_PERF_HEAD ??
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'utf8',
        }).trim(),
      runtime: process.version,
      latencyMs: Number(process.env.CANOPY_PERF_LATENCY_MS ?? 0),
      samples: 5,
      results,
      multiRoot: {
        roots: sources.length,
        savedViewMs: saved.ms,
        results: saved.result.length,
        duplicateRefreshConsumers: 18,
        refreshReads: reads,
        refreshCalls,
        realRefreshMs: +refreshMs.toFixed(2),
        refreshedViewMs: refreshedView.ms,
      },
      desktop:
        'Not measured: Node timings exclude IPC, React commit, layout, paint, scroll latency and desktop memory.',
    },
    null,
    2,
  ) + '\n',
);
