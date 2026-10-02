// Preloaded only by the parent-owned Node IPC tests. Preserve real filesystem
// operations while controlling their completion before production boundaries.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

const profile = process.env.CANOPY_USER_DATA;
assert.ok(profile && isAbsolute(profile));
const fs = createRequire(__filename)('node:fs/promises');
const mkdir = fs.mkdir,
  readFile = fs.readFile;
const mode = process.env.CANOPY_IPC_IO;
assert.ok(mode === 'delay' || mode === 'never');
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
fs.mkdir = async (path: string, ...args: any[]) => {
  assert.equal(
    path,
    profile,
    'Only the supplied disposable profile is writable',
  );
  const result = await mkdir(path, ...args);
  console.log('REAL mkdir completed');
  if (mode === 'never') return new Promise(() => {});
  await delay();
  return result;
};
fs.readFile = async (path: string, ...args: any[]) => {
  assert.equal(path, join(profile!, 'updates.json'));
  try {
    return await readFile(path, ...args);
  } finally {
    if (mode === 'delay') await delay();
  }
};
process.on('exit', () => {
  console.log(
    `EXIT timeouts=${process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length}`,
  );
});
