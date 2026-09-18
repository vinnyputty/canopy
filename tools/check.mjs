import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === 'types') {
  const result = spawnSync(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--project',
      join(root, 'tsconfig.json'),
      '--noEmit',
    ],
    { stdio: 'inherit', cwd: root },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
// Read runfiles directly: Prettier's CLI intentionally skips symlink inputs.
const prettier = await import('prettier');
const config = JSON.parse(
  await readFile(join(root, '.prettierrc.json'), 'utf8'),
);
async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [join(root, path)];
      }),
    )
  ).flat();
}
const paths = [
  ...(
    await Promise.all(
      ['src', 'broker', 'tests', 'tools', 'docs', '.github'].map(files),
    )
  ).flat(),
  join(root, 'README.md'),
  join(root, 'package.json'),
  join(root, 'tsconfig.json'),
];
let failed = false;
for (const path of paths) {
  if (!/\.(?:[cm]?js|tsx?|css|json|md|ya?ml)$/.test(path)) continue;
  const workspacePath = relative(root, path);
  if (
    !(await prettier.check(await readFile(path, 'utf8'), {
      ...config,
      filepath: workspacePath,
    }))
  ) {
    process.stderr.write(`Formatting needed: ${workspacePath}\n`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
