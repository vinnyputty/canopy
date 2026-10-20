import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { callback, execute, sourceFile } from './source-probe';

const captureSource = callback(
  sourceFile(new URL('../tools/smoke-accessibility.mjs', import.meta.url)),
  'capture',
);

function harness(
  options: {
    paintError?: Error;
    captureError?: Error;
    pngWriteError?: Error;
    ariaError?: Error;
    ariaWriteError?: Error;
  } = {},
) {
  const evidence = '/evidence';
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const writes: Array<[string, unknown]> = [];
  let ariaCalls = 0;
  let screenshotCalls = 0;
  const app = {
    async evaluate(callback: (electron: unknown) => Promise<string>) {
      assert.equal(screenshotCalls, 1);
      return callback({
        BrowserWindow: {
          getAllWindows: () => [
            {
              async capturePage() {
                if (options.captureError) throw options.captureError;
                return { toPNG: () => png };
              },
            },
          ],
        },
      });
    },
  };
  const page = {
    screenshot: async () => {
      screenshotCalls++;
      if (options.paintError) throw options.paintError;
      return Buffer.from('cropped');
    },
    locator: () => ({
      async ariaSnapshot() {
        ariaCalls++;
        if (options.ariaError) throw options.ariaError;
        return 'body snapshot';
      },
    }),
  };
  const writeFile = async (path: string, data: unknown) => {
    writes.push([path, data]);
    if (path.endsWith('.png') && options.pngWriteError)
      throw options.pngWriteError;
    if (path.endsWith('.aria.txt') && options.ariaWriteError)
      throw options.ariaWriteError;
  };
  const capture = execute(captureSource, {
    app,
    page,
    evidence,
    writeFile,
    join,
  }) as (name: string) => Promise<void>;
  return {
    run: () => capture('initial-loading'),
    png,
    writes,
    ariaCalls: () => ariaCalls,
    screenshotCalls: () => screenshotCalls,
  };
}

test('capture saves complete native PNG bytes and the matching ARIA snapshot', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.writes, [
    [join('/evidence', 'initial-loading.png'), h.png],
    [join('/evidence', 'initial-loading.aria.txt'), 'body snapshot'],
  ]);
  assert.equal(h.ariaCalls(), 1);
  assert.equal(h.screenshotCalls(), 1);
});

test('paint synchronization failure writes no evidence', async () => {
  const error = new Error('paint failed');
  const h = harness({ paintError: error });
  await assert.rejects(h.run(), error);
  assert.deepEqual(h.writes, []);
  assert.equal(h.ariaCalls(), 0);
});

test('native capture rejection writes no evidence', async () => {
  const error = new Error('capture failed');
  const h = harness({ captureError: error });
  await assert.rejects(h.run(), error);
  assert.deepEqual(h.writes, []);
  assert.equal(h.ariaCalls(), 0);
});

test('PNG write rejection skips the ARIA snapshot', async () => {
  const error = new Error('PNG write failed');
  const h = harness({ pngWriteError: error });
  await assert.rejects(h.run(), error);
  assert.deepEqual(h.writes, [
    [join('/evidence', 'initial-loading.png'), h.png],
  ]);
  assert.equal(h.ariaCalls(), 0);
});

test('ARIA snapshot and write errors propagate', async (t) => {
  await t.test('snapshot', async () => {
    const error = new Error('ARIA snapshot failed');
    const h = harness({ ariaError: error });
    await assert.rejects(h.run(), error);
    assert.deepEqual(h.writes, [
      [join('/evidence', 'initial-loading.png'), h.png],
    ]);
  });
  await t.test('write', async () => {
    const error = new Error('ARIA write failed');
    const h = harness({ ariaWriteError: error });
    await assert.rejects(h.run(), error);
    assert.deepEqual(h.writes, [
      [join('/evidence', 'initial-loading.png'), h.png],
      [join('/evidence', 'initial-loading.aria.txt'), 'body snapshot'],
    ]);
  });
});
