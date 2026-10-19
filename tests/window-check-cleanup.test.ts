import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { AuditOwner, finishAudit } from '../tools/audit-lifecycle.mjs';
import { disposeProcess } from './fixtures/owned-process.js';

// Execute the actual harness with the actual lifecycle helper. Only disposable
// owned Node children are launched. These controls grant no Electron authority.
async function probe(
  t: TestContext,
  options: {
    primary?: unknown;
    body?: string;
    mode?: 'refuse' | 'hang' | 'reject' | 'mismatch' | 'missing' | 'pending';
    exitCode?: number;
    firstOnly?: boolean;
    removeFails?: boolean;
  } = {},
) {
  const primary = Object.hasOwn(options, 'primary')
    ? options.primary
    : new Error('original fixture assertion');
  const profile = await mkdtemp(join(tmpdir(), 'canopy-window-cleanup-test-'));
  const children: ChildProcess[] = [];
  const exits: Promise<unknown>[] = [];
  const owners: AuditOwner[] = [];
  const calls: string[] = [];
  let removals = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  class NodeOwner extends AuditOwner {
    constructor(options: ConstructorParameters<typeof AuditOwner>[0]) {
      assert.equal(options.profile, profile);
      assert.equal(options.executable, process.execPath);
      super({
        ...options,
        graceMs:
          optionsMode === 'hang' || optionsMode === 'refuse'
            ? 120
            : process.platform === 'win32'
              ? 15000
              : 3000,
        killMs:
          process.platform === 'win32'
            ? 60000
            : optionsMode === 'refuse'
              ? 150
              : 1500,
        operationMs: process.platform === 'win32' ? 15000 : 1000,
        ...(optionsMode === 'refuse' ? { signalGroup: () => false } : {}),
      });
      owners.push(this);
    }
  }
  const optionsMode = options.mode;
  t.after(async () => {
    release();
    for (const owner of owners) owner.restore();
    for (const child of children) await disposeProcess(child);
    await Promise.all(exits);
    await rm(profile, { recursive: true, force: true });
  });
  const source = await readFile(
    new URL('../tools/window-check.mjs', import.meta.url),
    'utf8',
  );
  let harness = source.replace(/^import .*;$/gm, '');
  const start = harness.indexOf(
    '\ntry {\n  await launch();',
    harness.indexOf('let failed = false;'),
  );
  const end = harness.indexOf('} catch (error) {\n  failed = true;', start);
  assert.ok(start >= 0 && end > start);
  harness =
    harness.slice(0, start) +
    '\ntry {\n' +
    (options.body ?? 'await launch(); throw primary;\n') +
    harness.slice(end);
  assert.ok(!harness.includes('import '));
  const operation = runInNewContext(`(async () => { ${harness} })()`, {
    assert,
    AuditOwner: NodeOwner,
    finishAudit,
    primary,
    electron: {
      launch: async (launchOptions: {
        executablePath: string;
        env: NodeJS.ProcessEnv;
      }) => {
        assert.equal(
          owners.length,
          children.length + 1,
          'owner retained before launch',
        );
        const mode =
          !options.firstOnly || children.length === 0
            ? options.mode
            : undefined;
        if (mode === 'missing') return { process: () => undefined };
        const child = childProcess.spawn(
          launchOptions.executablePath,
          [
            '-e',
            "process.on('message',code=>process.exit(Number.isInteger(code) ? code : 0)); setInterval(()=>{},1000); process.send('ready');",
          ],
          {
            detached: process.platform !== 'win32',
            env: launchOptions.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        children.push(child);
        const childExit = once(child, 'exit');
        exits.push(childExit);
        await once(child, 'message');
        if (mode === 'reject') throw primary;
        if (mode === 'pending') await held;
        return {
          process: () => (mode === 'mismatch' ? {} : child),
          firstWindow: async () => ({ waitForLoadState: async () => {} }),
          evaluate: async (_callback: unknown, stopOptions?: unknown) => {
            if (stopOptions) {
              child.send(options.exitCode ?? 0);
              await childExit;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return {
              bounds: { x: 1, y: 2, width: 900, height: 600 },
              maximized: false,
            };
          },
          close: async () => {
            calls.push('close');
            if (mode === 'hang' || mode === 'refuse')
              await new Promise(() => {});
            else {
              if (child.connected)
                await new Promise<void>((resolve, reject) => {
                  child.send('normal', (error) =>
                    error ? reject(error) : resolve(),
                  );
                });
              await childExit;
            }
          },
        };
      },
    },
    mkdtemp: async () => profile,
    rm: async (path: string, flags: Parameters<typeof rm>[1]) => {
      assert.equal(path, profile);
      removals++;
      assert.ok(
        children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
      if (options.removeFails) throw new Error('profile removal failed');
      await rm(path, flags);
    },
    tmpdir,
    join,
    process: {
      env: {
        CANOPY_APP_PATH: '/fixture-app',
        CANOPY_ELECTRON_PATH: process.execPath,
      },
    },
    console: { log() {}, error() {} },
    // Keep source debounce pauses fast; stop's native deadline is separately tested.
    setTimeout: (callback: () => void, ms: number) =>
      setTimeout(callback, ms === 350 || ms === 50 ? 0 : ms),
    clearTimeout,
  }) as Promise<void>;
  let failed = false;
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    failed = true;
    error = caught;
  }
  return { primary, profile, error, failed, calls, children, owners, removals };
}

for (const primary of [new Error('assertion'), 0, false, null, undefined]) {
  test(`qualified normal cleanup preserves raw primary ${String(primary)}`, async (t) => {
    const check = await probe(t, { primary });
    assert.equal(check.failed, true);
    assert.equal(check.error, primary);
    assert.equal(check.removals, 1);
    await assert.rejects(stat(check.profile), { code: 'ENOENT' });
  });
}

test('a hung close fails after qualified forced shutdown', async (t) => {
  const check = await probe(t, { mode: 'hang' });
  assert.equal((check.error as AggregateError).errors[0], check.primary);
  assert.ok(
    (check.error as AggregateError).errors.some((error: Error) =>
      /required forced shutdown/.test(error.message),
    ),
  );
  assert.ok(
    (check.error as AggregateError).errors.some((error: Error) =>
      /Abnormal audit exit/.test(error.message),
    ),
  );
  assert.equal(check.removals, 1);
});

test(
  'refused termination retains the profile and original failure',
  { skip: process.platform === 'win32' },
  async (t) => {
    const check = await probe(t, { mode: 'refuse' });
    assert.equal((check.error as AggregateError).errors[0], check.primary);
    assert.equal(check.removals, 0);
    assert.equal(check.children[0].exitCode, null);
    await stat(check.profile);
  },
);

for (const mode of ['reject', 'mismatch', 'missing', 'pending'] as const) {
  test(`unconfirmed acquisition ${mode} retains the profile`, async (t) => {
    const check = await probe(t, {
      mode,
      ...(mode === 'pending'
        ? {
            body: 'launch().catch(() => {}); await pause(50); throw primary;\n',
          }
        : {}),
    });
    assert.equal(check.failed, true);
    assert.equal(check.removals, 0);
    assert.deepEqual(check.calls, []);
    await stat(check.profile);
  });
}

test('every relaunch keeps its original owner and application association', async (t) => {
  const check = await probe(t, {
    body: 'await launch(); await running.close(); running = undefined; await launch(); throw primary;\n',
  });
  assert.equal(check.error, check.primary);
  assert.equal(check.owners.length, 2);
  assert.equal(check.owners[0].child, check.children[0]);
  assert.equal(check.owners[1].child, check.children[1]);
  assert.equal(check.removals, 1);
});

test('an early failed acquisition still blocks shared-profile removal after a relaunch', async (t) => {
  const check = await probe(t, {
    mode: 'reject',
    firstOnly: true,
    body: 'try { await launch(); } catch {} await launch(); throw primary;\n',
  });
  assert.equal(check.owners.length, 2);
  assert.equal(check.removals, 0);
  assert.equal((check.error as AggregateError).errors[0], check.primary);
  await stat(check.profile);
});

test('profile removal failure follows the falsy primary', async (t) => {
  const check = await probe(t, { primary: undefined, removeFails: true });
  assert.equal((check.error as AggregateError).errors[0], undefined);
  assert.match(
    String((check.error as AggregateError).errors[1]),
    /profile removal failed/,
  );
});

test('fully qualified success removes its disposable profile', async (t) => {
  const check = await probe(t, { body: 'await launch();\n' });
  assert.equal(check.failed, false);
  assert.equal(check.removals, 1);
});

test('success without a retained launch owner fails and retains the profile', async (t) => {
  const check = await probe(t, { body: '' });
  assert.equal(check.failed, true);
  assert.equal(check.removals, 0);
  await stat(check.profile);
});

test('an early pending acquisition survives a later confirmed relaunch', async (t) => {
  const check = await probe(t, {
    mode: 'pending',
    firstOnly: true,
    body: 'launch().catch(() => {}); await pause(50); await launch(); throw primary;\n',
  });
  assert.equal(check.owners.length, 2);
  assert.equal(check.removals, 0);
  assert.equal((check.error as AggregateError).errors[0], check.primary);
  await stat(check.profile);
});

test('qualified stop and fullscreen fallback keep the application association', async (t) => {
  const check = await probe(t, {
    body: 'await launch(); const app = running; await settleWindowScope(app, () => app.close()); running = undefined; await launch(); throw primary;\n',
  });
  assert.equal(check.error, check.primary);
  assert.equal(check.removals, 1);
});

test('actual stop qualifies each healthy owned scope before relaunch and removal', async (t) => {
  const check = await probe(t, {
    body: 'await launch(); await stop(); await launch(); await stop();\n',
  });
  assert.equal(check.failed, false);
  assert.equal(check.owners.length, 2);
  assert.equal(check.removals, 1);
  assert.deepEqual(check.calls, []);
});

test('actual immediate nonzero exit fails while stop evaluation is held', async (t) => {
  const check = await probe(t, {
    exitCode: 9,
    body: 'await launch(); await stop();\n',
  });
  assert.equal(check.failed, true);
  assert.match(
    String((check.error as AggregateError).errors[0]),
    /Electron exited with 9\/null/,
  );
  assert.ok(
    (check.error as AggregateError).errors.some((error: Error) =>
      /Abnormal audit exit/.test(error.message),
    ),
  );
});
