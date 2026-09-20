import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replaceFile } from '../src/main/replace-file';

const failure = (code: string) => Object.assign(new Error(code), { code });

test('Windows replacement retries temporary locks without deleting the saved file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-replace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'workspace.json');
  const source = `${destination}.tmp`;
  await writeFile(destination, 'saved');
  await writeFile(source, 'latest');
  let attempts = 0;
  await replaceFile(source, destination, 'win32', async (from, to) => {
    assert.equal(await readFile(destination, 'utf8'), 'saved');
    assert.equal(await readFile(source, 'utf8'), 'latest');
    const code = ['EPERM', 'EACCES', 'EBUSY'][attempts++];
    if (code) throw failure(code);
    await rename(from, to);
  });
  assert.equal(attempts, 4);
  assert.equal(await readFile(destination, 'utf8'), 'latest');
  await assert.rejects(readFile(source), { code: 'ENOENT' });
});

test('persistent Windows failures stop retrying and preserve both files for recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-replace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'workspace.json');
  const source = `${destination}.tmp`;
  await writeFile(destination, 'saved');
  await writeFile(source, 'latest');
  const error = failure('EPERM');
  let attempts = 0;
  await assert.rejects(
    replaceFile(source, destination, 'win32', async () => {
      attempts += 1;
      throw error;
    }),
    (caught) => caught === error,
  );
  assert.equal(attempts, 7);
  assert.equal(await readFile(destination, 'utf8'), 'saved');
  assert.equal(await readFile(source, 'utf8'), 'latest');
  await replaceFile(source, destination);
  assert.equal(await readFile(destination, 'utf8'), 'latest');
});

test('non-lock errors and non-Windows failures propagate immediately', async () => {
  for (const [platform, code] of [
    ['win32', 'ENOENT'],
    ['win32', 'ENOSPC'],
    ['linux', 'EPERM'],
    ['darwin', 'EACCES'],
  ] as const) {
    const error = failure(code);
    let attempts = 0;
    await assert.rejects(
      replaceFile('source', 'destination', platform, async () => {
        attempts += 1;
        throw error;
      }),
      (caught) => caught === error,
    );
    assert.equal(attempts, 1);
  }
});
