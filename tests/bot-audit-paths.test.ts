import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = (name: string) =>
  ts.createSourceFile(
    name,
    readFileSync(
      process.env.CANOPY_BOT_AUDIT_SOURCE
        ? `${process.env.CANOPY_BOT_AUDIT_SOURCE}/tools/${name}`
        : new URL(`../tools/${name}`, import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
function find(ast: ts.SourceFile, predicate: (n: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  function walk(n: ts.Node) {
    if (predicate(n)) found = n;
    ts.forEachChild(n, walk);
  }
  walk(ast);
  assert.ok(found);
  return found;
}
const run = (text: string, context: object) =>
  vm.runInNewContext(
    ts.transpileModule(text.replaceAll('import.meta.url', 'moduleURL'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
for (const mode of ['native', 'POSIX', 'Windows'] as const)
  for (const override of [false, true])
    test(`actual benchmark resolves Unicode/spaces and retains source override with ${mode} paths, override=${override}`, () => {
      const ast = source('benchmark-large-trees.mjs');
      const initializer = (
        find(
          ast,
          (n) =>
            ts.isVariableDeclaration(n) && n.name.getText(ast) === 'production',
        ) as ts.VariableDeclaration
      ).initializer!;
      // Native uses this host's real URL/path rules; explicit other-OS
      // controls keep their URL decoder and path implementation paired.
      const moduleURL =
        mode === 'native'
          ? pathToFileURL(
              resolve(
                tmpdir(),
                'canopy 界',
                'tools',
                'benchmark-large-trees.mjs',
              ),
            ).href
          : mode === 'Windows'
            ? 'file:///D:/canopy%20%E7%95%8C/tools/benchmark-large-trees.mjs'
            : 'file:///tmp/canopy%20%E7%95%8C/tools/benchmark-large-trees.mjs';
      const path =
        mode === 'Windows'
          ? win32
          : mode === 'POSIX'
            ? posix
            : { join, resolve };
      const decode =
        mode === 'native'
          ? fileURLToPath
          : (url: URL) => fileURLToPath(url, { windows: mode === 'Windows' });
      const repo = decode(new URL('..', moduleURL));
      const selected = override
        ? mode === 'native'
          ? resolve(tmpdir(), 'override 界')
          : mode === 'Windows'
            ? 'D:\\override 界'
            : '/tmp/override 界'
        : repo;
      const fn = run(`(${initializer.getText(ast)})`, {
        moduleURL,
        URL,
        fileURLToPath: decode,
        resolve: path.resolve,
        process: { env: override ? { CANOPY_PERF_SOURCE: selected } : {} },
        require: (p: string) => p,
      });
      assert.equal(
        fn('src/main/jira.ts'),
        path.resolve(selected, 'src/main/jira.ts'),
      );
      const cwd = (
        find(
          ast,
          (n) => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'cwd',
        ) as ts.PropertyAssignment
      ).initializer;
      assert.equal(
        run(`(${cwd.getText(ast)})`, { moduleURL, URL, fileURLToPath: decode }),
        repo,
      );
    });
for (const platform of ['darwin', 'win32'])
  for (const override of [false, true])
    test(`actual evidence output uses ${platform} temporary root and preserves override=${override}`, () => {
      const ast = source('perf-desktop.mjs');
      const init = (
        find(
          ast,
          (n) =>
            ts.isVariableDeclaration(n) && n.name.getText(ast) === 'output',
        ) as ts.VariableDeclaration
      ).initializer!;
      const temp = platform === 'win32' ? 'D:\\Temp 界' : '/tmp/Temp 界',
        path = platform === 'win32' ? win32 : { join };
      const expected = override
        ? 'explicit-output.json'
        : path.join(temp, 'canopy-perf-90-desktop.json');
      assert.equal(
        run(`(${init.getText(ast)})`, {
          process: {
            env: override ? { CANOPY_PERF_DESKTOP_OUTPUT: expected } : {},
          },
          tmpdir: () => temp,
          join: path.join,
        }),
        expected,
      );
    });
for (const platform of ['darwin', 'win32'])
  test(`actual pair dependency link selects directory kind ${platform} and resolves real Node files`, async () => {
    const ast = source('prepare-perf-desktop.mjs');
    const call = find(
      ast,
      (n) => ts.isCallExpression(n) && n.expression.getText(ast) === 'symlink',
    );
    const directory = await mkdtemp(join(tmpdir(), 'canopy-link 界 '));
    const repo = join(directory, 'repo'),
      archive = join(directory, 'archive');
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await mkdir(archive);
    await writeFile(join(repo, 'node_modules', 'probe'), 'owned');
    let kind: string | undefined;
    try {
      await run(call.getText(ast), {
        repo,
        archive,
        join,
        process: { platform },
        symlink: async (
          target: string,
          path: string,
          type: 'dir' | 'junction',
        ) => {
          kind = type;
          await symlink(target, path, type);
        },
      });
      assert.equal(kind, platform === 'win32' ? 'junction' : 'dir');
      assert.equal(
        await readFile(join(archive, 'node_modules', 'probe'), 'utf8'),
        'owned',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
