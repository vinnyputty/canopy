import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  process.env.CANOPY_PORTABLE_WRAPPER_SOURCE ??
    new URL('../tools/portable-check.mjs', import.meta.url),
  'utf8',
);
const body = source.slice(source.indexOf('const directory ='));

async function run(
  platform: string,
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; stdio: string; timeout: number },
  ) => { error?: Error; status: number | null },
  binary = process.execPath,
  windowsHost = false,
) {
  const removed: string[] = [];
  const completion = runInNewContext(
    `(async () => { ${body.replaceAll('import.meta.url', 'moduleUrl')} })()`,
    {
      moduleUrl: windowsHost
        ? 'file:///D:/fixture/tools/portable-check.mjs'
        : new URL('../tools/portable-check.mjs', import.meta.url).href,
      dirname: windowsHost ? win32.dirname : dirname,
      join: windowsHost ? win32.join : join,
      fileURLToPath: windowsHost
        ? (url: string) => fileURLToPath(url, { windows: true })
        : fileURLToPath,
      tmpdir: () => '/fixture temp',
      mkdtemp: async () => '/fixture temp/alternate cwd',
      rm: async (path: string, options: unknown) => {
        assert.deepEqual(JSON.parse(JSON.stringify(options)), {
          recursive: true,
          force: true,
        });
        removed.push(path);
      },
      process: {
        platform,
        execPath: process.execPath,
        env: { JS_BINARY__NODE_BINARY: binary },
      },
      spawnSync: spawn,
    },
  );
  try {
    await completion;
  } finally {
    assert.deepEqual(removed, ['/fixture temp/alternate cwd']);
  }
}

for (const windowsHost of [false, true]) {
  for (const platform of ['darwin', 'linux', 'win32']) {
    test(`actual portable wrapper keeps command-specific bounds and alternate cwd on ${platform} with ${windowsHost ? 'Windows' : 'native'} host paths`, async () => {
      const calls: { command: string; args: string[]; timeout: number }[] = [];
      await run(
        platform,
        (command, args, options) => {
          assert.equal(options.cwd, '/fixture temp/alternate cwd');
          assert.equal(options.stdio, 'inherit');
          calls.push({ command, args, timeout: options.timeout });
          return { status: 0 };
        },
        '/controlled node',
        windowsHost,
      );
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => call.command === '/controlled node'));
      assert.deepEqual(
        calls.map((call) => [
          Array.from(call.args, (arg) =>
            windowsHost ? win32.basename(arg) : basename(arg),
          ),
          call.timeout,
        ]),
        [
          [['test.mjs'], 600_000],
          [['check.mjs', 'types'], platform === 'win32' ? 600_000 : 60_000],
          [['check.mjs', 'format'], platform === 'win32' ? 600_000 : 60_000],
        ],
      );
    });
  }
}

test('portable wrapper propagates the exact child error and stops following commands', async () => {
  const fault = Object.assign(new Error('owned child timed out'), {
    code: 'ETIMEDOUT',
  });
  let calls = 0;
  await assert.rejects(
    run('darwin', () => {
      calls++;
      return { error: fault, status: null };
    }),
    (error) => error === fault,
  );
  assert.equal(calls, 1);
});

for (const mode of ['success', 'nonzero', 'timeout'] as const) {
  test(`portable wrapper handles actual owned Node ${mode} and cleans alternate cwd`, async () => {
    let calls = 0;
    let childError: Error | undefined;
    const completion = run('darwin', (_command, _args, options) => {
      calls++;
      assert.equal(options.timeout, calls === 1 ? 600_000 : 60_000);
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          mode === 'success'
            ? 'process.exit(0)'
            : mode === 'nonzero'
              ? 'process.exit(23)'
              : 'setInterval(() => {}, 1000)',
        ],
        { timeout: mode === 'timeout' ? 200 : 2000, encoding: 'utf8' },
      );
      childError = result.error;
      return result;
    });
    if (mode === 'success') {
      await completion;
      assert.equal(calls, 3);
    } else {
      await assert.rejects(completion, (error: unknown) =>
        mode === 'timeout'
          ? error === childError &&
            (childError as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          : String(error).includes('test.mjs') &&
            String(error).includes('failed from /fixture temp/alternate cwd'),
      );
      assert.equal(calls, 1);
    }
  });
}
