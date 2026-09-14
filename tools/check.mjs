import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
if (process.argv[2] === 'types') {
  const result = spawnSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '--noEmit'],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
// Read runfiles directly: Prettier's CLI intentionally skips symlink inputs.
const prettier = await import('prettier');
const config = JSON.parse(await readFile('.prettierrc.json', 'utf8'));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
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
  'README.md',
  'package.json',
  'tsconfig.json',
];
let failed = false;
for (const path of paths) {
  if (!/\.(?:[cm]?js|tsx?|css|json|md|ya?ml)$/.test(path)) continue;
  if (
    !(await prettier.check(await readFile(path, 'utf8'), {
      ...config,
      filepath: path,
    }))
  ) {
    process.stderr.write(`Formatting needed: ${path}\n`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
