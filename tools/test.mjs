import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = (await readdir(join(root, 'tests')))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(root, 'tests', f));
const result = spawnSync(
  process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
  ['--import', pathToFileURL(require.resolve('tsx')).href, '--test', ...files],
  { stdio: 'inherit', env: process.env, cwd: root },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
