// Builds an exact-source pair without launching Electron. A clean committed
// candidate is required; both builds use the same candidate audit harness.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const base = 'af0808d41d39d3f9252b620723014bd76baf953f';
const candidate = git('rev-parse', 'HEAD');
if (git('status', '--porcelain'))
  throw new Error(
    'Commit the reviewed candidate before preparing its exact-source pair.',
  );
if (git('merge-base', base, candidate) !== base)
  throw new Error('Candidate must descend from the pinned main base.');
const directory = await mkdtemp(join(tmpdir(), 'canopy-perf-90-pair-'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const harnessFiles = [
  'tests/fixtures/performance-main.ts',
  'tests/fixtures/large-trees.ts',
  'tests/fixtures/performance-preload.ts',
  'tests/fixtures/performance-ui.ts',
  'tools/perf-desktop.mjs',
  'tools/prepare-perf-desktop.mjs',
];
const manifest = {
  base,
  candidate,
  harnessSource: candidate,
  harness: {},
  builds: [],
  preparedAt: new Date().toISOString(),
  scenarios: [],
  limitations:
    'Synthetic 2ms transport; paired identical audit observer/IPC overhead; DOM observer and RAF are commit/paint-opportunity proxies. No Node measurement is native timing. Memory sampling is process residency, not exact snapshot ownership or a guaranteed peak.',
};
for (const path of harnessFiles)
  manifest.harness[path] = digest(await readFile(join(repo, path)));
for (const [label, source] of [
  ['base', base],
  ['candidate', candidate],
]) {
  const stage = join(directory, label),
    archive = join(stage, 'source'),
    dist = join(stage, 'dist');
  await mkdir(archive, { recursive: true });
  const tar = execFileSync('git', ['archive', source, 'src'], { cwd: repo });
  execFileSync('tar', ['-x', '-C', archive], { input: tar });
  await symlink(join(repo, 'node_modules'), join(archive, 'node_modules'));
  await mkdir(join(dist, 'renderer'), { recursive: true });
  const harnessPlugin = {
    name: 'exact-source',
    setup(builder) {
      builder.onResolve({ filter: /^canopy:production-preload$/ }, () => ({
        path: join(archive, 'src/main/preload.ts'),
      }));
      builder.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (args) => {
        if (!args.importer.startsWith(join(repo, 'tests', 'fixtures'))) return;
        return {
          path: resolve(archive, args.path.replace('../../', '') + '.ts'),
        };
      });
    },
  };
  const nodeOptions = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    plugins: [harnessPlugin],
  };
  await build({
    ...nodeOptions,
    entryPoints: [join(repo, 'tests/fixtures/performance-main.ts')],
    outfile: join(dist, 'performance-main.cjs'),
  });
  await build({
    ...nodeOptions,
    entryPoints: [join(archive, 'src/main/preload.ts')],
    outfile: join(dist, 'production-preload.cjs'),
  });
  await build({
    ...nodeOptions,
    entryPoints: [join(repo, 'tests/fixtures/performance-preload.ts')],
    outfile: join(dist, 'preload.cjs'),
  });
  await build({
    entryPoints: [join(archive, 'src/renderer/main.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    outfile: join(dist, 'renderer/app.js'),
  });
  await build({
    entryPoints: [join(repo, 'tests/fixtures/performance-ui.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    outfile: join(dist, 'renderer/audit.js'),
  });
  await writeFile(
    join(dist, 'renderer/index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\';script-src \'self\';style-src \'self\' \'unsafe-inline\';img-src \'self\' data:;connect-src \'none\';object-src \'none\';base-uri \'none\';form-action \'none\'"><title>Canopy performance sample</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="audit.js"></script><script src="app.js"></script></body></html>',
  );
  await writeFile(
    join(stage, 'package.json'),
    JSON.stringify({
      name: 'canopy-performance-sample',
      version: '0.0.0',
      main: 'dist/performance-main.cjs',
    }),
  );
  // Expected counts are derived from each exact source's real provider/filter
  // modules before any desktop session, never from timing or Cancel visibility.
  const metadataPath = join(stage, 'expected.cjs');
  await build({
    ...nodeOptions,
    stdin: {
      contents: `
    import { largeProvider } from './tests/fixtures/large-trees';
    import { buildIssueTree, filterTree, flattenVisible } from '${join(archive, 'src/renderer/tree.ts')}';
    import { viewResults } from '${join(archive, 'src/renderer/saved-views.ts')}';
    export async function counts() {
      const results = [];
      for (const provider of ['jira', 'github']) {
        const snapshots = {}, sources = [];
        for (const [index, [shape, size]] of [['wide',9901],['tiered',10101],['deep',2001]].entries()) {
          const fixture = largeProvider(provider, shape, size, index);
          const snapshot = await fixture.provider.tree(fixture.rootKey);
          if (snapshot.incomplete || snapshot.issues.length !== size) throw new Error('Incomplete expected fixture');
          const tree = buildIssueTree(snapshot.issues, fixture.rootKey), expanded = new Set(snapshot.issues.map(i => i.key));
          const count = (query, expand) => { const filtered = filterTree(tree, query, {}, true); return filtered ? flattenVisible(filtered, expand).length : 0; };
          sources.push({ id: shape, connectionId: 'fixture', rootKey: fixture.rootKey }); snapshots[shape] = snapshot;
          results.push({ provider, shape, root: fixture.rootKey, issues: size, expandedRows: count('', expanded), collapsedRows: count('', new Set([fixture.rootKey])), filterRows: count('region 3', expanded) });
        }
        const savedRows = viewResults({filters:{assignee:'any',statuses:[],priority:'',hideDone:true},sort:{column:'key',direction:'asc'}}, sources, snapshots, {}).length;
        results.filter(r => r.provider === provider).forEach(r => r.savedRows = savedRows);
      }
      return results;
    }`,
      resolveDir: repo,
      loader: 'ts',
    },
    outfile: metadataPath,
  });
  const counts = await createRequire(import.meta.url)(metadataPath).counts();
  manifest.scenarios.push({ label, source, counts });
  const files = [
    'performance-main.cjs',
    'production-preload.cjs',
    'preload.cjs',
    'renderer/app.js',
    'renderer/app.css',
    'renderer/audit.js',
    'renderer/index.html',
  ];
  const hashes = {};
  for (const path of files)
    hashes[path] = digest(await readFile(join(dist, path)));
  manifest.builds.push({ label, source, stage, files: hashes });
}
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(join(directory, 'manifest.json'));
