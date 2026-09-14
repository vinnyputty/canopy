import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir('tests'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `tests/${f}`);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit', env: process.env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
