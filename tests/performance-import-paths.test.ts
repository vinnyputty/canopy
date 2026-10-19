import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { execute, findNode, sourceFile } from './source-probe';

const preparer = sourceFile(
  new URL('../tools/prepare-perf-desktop.mjs', import.meta.url),
);
const template = findNode(
  preparer,
  (node): node is ts.TemplateExpression =>
    ts.isTemplateExpression(node) &&
    node
      .getText()
      .includes('import { buildIssueTree, filterTree, flattenVisible }'),
).getText();

for (const [archive, join] of [
  ['C:\\Canopy space\\source', win32.join],
  ['D:\\Canopy\'s "quoted" space\\source', win32.join],
  ['/tmp/Canopy\'s "quoted" \\ space/source', posix.join],
] as const)
  test(`actual generated metadata imports preserve ${archive}`, async () => {
    const expected = [
      join(archive, 'src/renderer/tree.ts'),
      join(archive, 'src/renderer/saved-views.ts'),
    ];
    const generated = execute(`() => ${template}`, {
      archive,
      join,
    })() as string;
    async function parse(contents: string) {
      const resolved: string[] = [];
      await build({
        stdin: { contents, loader: 'js' },
        bundle: true,
        platform: 'node',
        write: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'portable-path-resolver',
            setup(builder) {
              builder.onResolve({ filter: /./ }, (args) => {
                if (args.path === 'node:crypto')
                  return { path: args.path, external: true };
                if (args.path === './tests/fixtures/large-trees')
                  return { path: args.path, namespace: 'fixture' };
                assert(
                  expected.includes(args.path),
                  `Changed generated import ${args.path}`,
                );
                resolved.push(args.path);
                return { path: args.path, namespace: 'fixture' };
              });
              builder.onLoad({ filter: /./, namespace: 'fixture' }, () => ({
                contents:
                  'export const largeProvider=()=>{}, buildIssueTree=()=>{}, filterTree=()=>{}, flattenVisible=()=>{}, viewResults=()=>{};',
                loader: 'js',
              }));
            },
          },
        ],
      });
      assert.deepEqual(resolved.sort(), [...expected].sort());
    }
    await parse(generated);
    // Retain the prior single-quoted interpolation as a negative control:
    // backslashes change values, and quote-bearing paths fail to parse.
    let prior = template;
    for (const path of ['src/renderer/tree.ts', 'src/renderer/saved-views.ts'])
      prior = prior.replace(
        '${JSON.stringify(join(archive, ' +
          JSON.stringify(path).replaceAll('"', "'") +
          '))}',
        "'${join(archive, '" + path + "')}'",
      );
    assert.notEqual(prior, template);
    await assert.rejects(parse(execute(`() => ${prior}`, { archive, join })()));
  });
