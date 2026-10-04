import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export async function checkPackagedFirstSave() {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'packaged-smoke.mjs'),
    'utf8',
  );
  const begin = source.indexOf('        await expect\n          .poll(');
  const finish = source.indexOf("          .toBe('forest');", begin);
  assert(begin >= 0 && finish > begin);
  const block = source.slice(
    begin,
    finish + "          .toBe('forest');".length,
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    'expect',
    'readFile',
    'join',
    'userData',
    block,
  );
  const directory = await mkdtemp(join(tmpdir(), 'canopy-first-save-'));
  const workspace = join(directory, 'workspace.json');
  const atomicSave = async (value) => {
    await writeFile(`${workspace}.tmp`, JSON.stringify(value));
    await rename(`${workspace}.tmp`, workspace);
  };
  try {
    let reads = 0;
    await execute(
      expect,
      async (path, encoding) => {
        assert.equal(path, workspace);
        assert.equal(encoding, 'utf8');
        reads++;
        try {
          return await readFile(path, encoding);
        } catch (error) {
          assert.equal(reads, 1);
          assert.equal(error.code, 'ENOENT');
          // Real initial absence, then an actual owned atomic commit. The poll
          // must retry the missing read and require the committed palette.
          await atomicSave({ palette: 'forest', theme: 'dark' });
          throw error;
        }
      },
      join,
      directory,
    );
    assert.equal(reads, 2);
    assert.deepEqual(JSON.parse(await readFile(workspace, 'utf8')), {
      palette: 'forest',
      theme: 'dark',
    });

    await atomicSave({ palette: 'default', theme: 'dark' });
    reads = 0;
    await execute(
      expect,
      async (path, encoding) => {
        reads++;
        const contents = await readFile(path, encoding);
        if (reads === 1) await atomicSave({ palette: 'forest', theme: 'dark' });
        return contents;
      },
      join,
      directory,
    );
    assert.equal(reads, 2);

    for (const contents of [
      '{malformed',
      'null',
      '[]',
      'false',
      'true',
      '"forest"',
      '0',
      '42',
    ]) {
      await writeFile(workspace, contents);
      reads = 0;
      await assert.rejects(
        execute(
          expect,
          async (path, encoding) => {
            reads++;
            const contents = await readFile(path, encoding);
            // A later healthy save must never hide a malformed first read.
            if (reads === 1) await atomicSave({ palette: 'forest' });
            return contents;
          },
          join,
          directory,
        ),
        (error) =>
          contents === '{malformed'
            ? error instanceof SyntaxError
            : error instanceof TypeError &&
              error.message === 'Workspace state must be a plain object',
      );
      assert.equal(reads, 1);
      assert.equal(
        JSON.parse(await readFile(workspace, 'utf8')).palette,
        'forest',
      );
    }
    // Permission and other unexpected failures must remain the original error,
    // including falsy thrown values; only a genuine ENOENT can be retried.
    for (const failure of [
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      Object.assign(new Error('I/O fault'), { code: 'EIO' }),
      Object.assign(new Error('temporary lock'), { code: 'EBUSY' }),
      null,
      undefined,
      false,
      0,
    ]) {
      reads = 0;
      await assert.rejects(
        execute(
          expect,
          async () => {
            reads++;
            throw failure;
          },
          join,
          directory,
        ),
        (error) => error === failure,
      );
      assert.equal(reads, 1);
    }

    // Short test-only budgets exercise the real pinned expect.poll failure path.
    // The exact production block supplies no timeout/options override.
    const boundedExpect = expect.configure({ timeout: 180 });
    await rm(workspace);
    reads = 0;
    await assert.rejects(
      execute(
        boundedExpect,
        async (path, encoding) => {
          reads++;
          return readFile(path, encoding);
        },
        join,
        directory,
      ),
      (error) =>
        /Timeout|timed out/.test(error.message) && error.code !== 'ENOENT',
    );
    assert(reads >= 2);
    await atomicSave({ palette: 'default' });
    await assert.rejects(
      execute(boundedExpect, readFile, join, directory),
      /Timeout|timed out/,
    );
    assert.equal(
      JSON.parse(await readFile(workspace, 'utf8')).palette,
      'default',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
