import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replaceFile, writeSavedFile } from '../src/main/replace-file';

const failure = (code: string) => Object.assign(new Error(code), { code });

test('saved state ignores a stale temporary file and replaces complete contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'workspace.json');
  await writeFile(`${destination}.tmp`, 'stale');
  await writeFile(destination, 'saved');
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeSavedFile(
        destination,
        JSON.stringify({ index, value: 'x'.repeat(10000) }),
      ),
    ),
  );
  const saved = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(saved.value, 'x'.repeat(10000));
  assert.equal(await readFile(`${destination}.tmp`, 'utf8'), 'stale');
  assert.deepEqual((await readdir(directory)).sort(), [
    'workspace.json',
    'workspace.json.tmp',
  ]);
  if (process.platform !== 'win32')
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('replacement failure preserves saved data and cleans its temporary file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'workspace.json');
  await mkdir(destination);
  await writeFile(join(destination, 'saved'), 'saved');
  await assert.rejects(writeSavedFile(destination, 'latest'));
  assert.equal(await readFile(join(destination, 'saved'), 'utf8'), 'saved');
  assert.deepEqual(await readdir(directory), ['workspace.json']);
});

test(
  'a stale temporary symlink cannot overwrite another file',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'canopy-write-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const destination = join(directory, 'credentials.json');
    const unrelated = join(directory, 'unrelated');
    await writeFile(unrelated, 'keep');
    await symlink(unrelated, `${destination}.tmp`);
    await writeSavedFile(destination, 'new');
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    assert.equal(await readFile(destination, 'utf8'), 'new');
  },
);

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
