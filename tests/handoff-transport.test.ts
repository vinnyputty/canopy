import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let source: string;
let native: string;
before(async () => {
  for (const name of ['transport', 'native']) {
    const result = await build({
      ...(name === 'transport'
        ? {
            stdin: {
              contents:
                "export * from './tools/handoff-transport.mjs'; export {AuditOwner as CanonicalOwner} from './tools/audit-lifecycle.mjs'; export {runSampleAudit} from './tools/handoff-audit.mjs';",
              resolveDir: process.cwd(),
              sourcefile: 'handoff-test-entry.mjs',
            },
          }
        : { entryPoints: ['tools/handoff-native.mjs'] }),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      external: ['node:*', '@playwright/test'],
    });
    if (name === 'transport') source = result.outputFiles[0].text;
    else native = result.outputFiles[0].text;
  }
});

const birth = 'Fri Oct  2 12:34:56 2026';
function fixture(platform = 'darwin', rows = true) {
  let visible = rows;
  let signals = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 23456,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  const cp: any = {
    spawn: () => child,
    execFile: () => {
      throw Error('Callback exec is forbidden');
    },
  };
  let snapshot = async (command: string) => {
    if (platform === 'win32') {
      assert.equal(command, 'powershell.exe');
      return {
        stdout: JSON.stringify(
          visible
            ? [
                {
                  pid: child.pid,
                  ppid: 100,
                  start: '2026-10-02T12:34:56.1234567Z',
                },
              ]
            : [],
        ),
        stderr: '',
      };
    }
    assert.equal(command, 'ps');
    return {
      stdout: visible ? `${child.pid} 100 ${child.pid} S ${birth}\n` : '',
      stderr: '',
    };
  };
  cp.execFile[promisify.custom] = (command: string) => snapshot(command);
  const setSnapshot = (reader: typeof snapshot) => {
    snapshot = reader;
  };
  const exports: any = {};
  const context = {
    module: { exports },
    exports,
    require: (name: string) => {
      if (name === 'node:child_process') return cp;
      if (name === 'node:module') return { syncBuiltinESMExports() {} };
      if (name === '@playwright/test')
        return {
          _electron: {
            launch() {
              throw Error('Electron forbidden');
            },
          },
          expect() {
            throw Error('Browser forbidden');
          },
        };
      return require(name);
    },
    process: {
      platform,
      pid: 100,
      env: {},
      cpuUsage: process.cpuUsage.bind(process),
      memoryUsage: process.memoryUsage.bind(process),
      kill() {
        signals++;
        throw Error('Signals forbidden');
      },
    },
    Buffer,
    setTimeout,
    clearTimeout,
    console,
  };
  runInNewContext(source, context);
  const api: any = context.module.exports;
  const nativeContext = { ...context, module: { exports: {} }, exports: {} };
  runInNewContext(native, nativeContext);
  const nativeApi: any = nativeContext.module.exports;
  // Constructor defaults stay untouched in the actual adapter. The source
  // snapshots are immediate; all synthetic children close normally or refuse
  // cleanup before any canonical signaling branch is reached.
  let spawned = 0;
  const launch = () => {
    spawned++;
    return cp.spawn('/fixture/electron', [], {
      detached: platform !== 'win32',
      env: { CANOPY_USER_DATA: '/fixture/profile' },
    });
  };
  const stop = () => {
    visible = false;
    child.exitCode = 0;
    child.emit('close', 0, null);
  };
  const session = { process: () => child, close: async () => stop() };
  const TestOwner = class extends api.CanonicalOwner {
    constructor(options: any) {
      super({ ...options, graceMs: 5, killMs: 10, operationMs: 30 });
    }
  };
  const make = (
    open = async () => {
      launch();
      return session;
    },
  ) =>
    api.createHandoffTransport({
      profile: '/fixture/profile',
      executable: '/fixture/electron',
      Owner: TestOwner,
      open,
      duplicate: () => {
        const child = launch();
        const closed = nativeApi.observeDuplicate(child);
        return { child, closed };
      },
    });
  return {
    api,
    nativeApi,
    make,
    child,
    cp,
    setSnapshot,
    launch,
    stop,
    exitOnly() {
      visible = false;
      child.exitCode = 0;
    },
    session,
    get signals() {
      return signals;
    },
    get spawned() {
      return spawned;
    },
  };
}

for (const [file, hash] of [
  [
    'audit-lifecycle.mjs',
    '7d793fdc7bd53e3bfd76376f8425cb63ef74cedb7fdab158dd712220fff14bd4',
  ],
  [
    'audit-lifecycle.d.mts',
    'e02df8cb96069a6cb9e83ab76729f157d34239150d78cb77b57506d066f00985',
  ],
])
  test(`canonical merged helper bytes: ${file}`, async () => {
    assert.equal(
      createHash('sha256')
        .update(await readFile(`tools/${file}`))
        .digest('hex'),
      hash,
    );
  });

for (const platform of ['darwin', 'win32']) {
  test(`actual canonical original birth/close/absence: ${platform}`, async () => {
    const f = fixture(platform);
    const transport = f.make();
    const owner = transport.owner();
    assert.equal(transport.owners[0], owner);
    assert.equal(await owner.open({}), f.session);
    assert.equal(owner.canonical.child, f.child);
    const first = owner.shutdown();
    assert.equal(owner.shutdown(), first);
    const result = await first;
    assert.equal(result.terminated, true);
    assert.equal(result.errors.length, 0);
    assert.equal(transport.operations.pending.size, 0);
    assert.equal(f.signals, 0);
    assert.equal(f.spawned, 1);
    assert.throws(() => owner.open({}), /repeated or closing/);
  });
  test(`ordinary fast exit without original birth retains: ${platform}`, async () => {
    const f = fixture(platform, false);
    const transport = f.make();
    const owner = transport.owner();
    const original = transport.deadline(
      () => owner.duplicate({}),
      30_000,
      'Duplicate sample',
    );
    original.catch(() => {});
    // The actual direct close observer was installed at spawn; exit is neither
    // held nor changed to make a canonical snapshot easier to capture.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    f.stop();
    await assert.rejects(original);
    const result = await owner.shutdown();
    assert.equal(result.terminated, false);
    assert.match(
      result.errors[0].message,
      /birth\/child ownership unconfirmed/,
    );
    assert.equal(f.child.listenerCount('error'), 0);
    assert.equal(f.child.listenerCount('close'), 0);
    assert.equal(f.signals, 0);
    assert.equal(f.spawned, 1);
  });
}

test('deadline retains the original pre-spawn acquisition until true settlement', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = f.make(async () => {
    await held;
    f.launch();
    return f.session;
  });
  const owner = transport.owner();
  await assert.rejects(
    transport.deadline(() => owner.open({}), 5, 'Sample startup'),
    /timed out/,
  );
  const cleanup = owner.shutdown();
  let settled = false;
  cleanup.then(() => {
    settled = true;
  });
  await assert.rejects(
    transport.deadline(() => cleanup, 5, 'Owned sample shutdown'),
    /timed out/,
  );
  assert.equal(settled, false);
  assert(transport.operations.pending.size > 0);
  assert.equal(f.spawned, 0);
  release();
  const result = await cleanup;
  assert.equal(result.terminated, true);
  assert.equal(f.spawned, 1);
  assert.equal(f.signals, 0);
});

test('pending UI operation prevents canonical close and absence success', async () => {
  const f = fixture();
  const transport = f.make();
  const owner = transport.owner();
  await owner.open({});
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    transport.deadline(() => held, 5, 'Sample UI'),
    /timed out/,
  );
  const cleanup = owner.shutdown();
  await assert.rejects(
    transport.deadline(() => cleanup, 5, 'Owned sample shutdown'),
    /timed out/,
  );
  assert.equal(f.child.exitCode, null);
  release();
  assert.equal((await cleanup).terminated, true);
});

test('original evidence writer remains registered after deadline', async () => {
  const f = fixture();
  const transport = f.make();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    transport.deadline(() => held, 5, 'Sample evidence'),
    /timed out/,
  );
  assert.equal(transport.operations.pending.size, 1);
  release();
  await transport.operations.settle();
  assert.equal(transport.operations.pending.size, 0);
});

for (const primary of [undefined, null, false, 0, '', new Error('RAW')]) {
  test(`original duplicate error waits for close and retains raw ${String(primary)}`, async () => {
    const f = fixture();
    const original = f.nativeApi.observeDuplicate(f.child);
    let rejected = false;
    original.catch(() => {
      rejected = true;
    });
    f.child.emit('error', primary);
    f.child.emit(
      'error',
      new Error('Repeated error must not replace original'),
    );
    assert.equal(f.child.listenerCount('error'), 1);
    await Promise.resolve();
    assert.equal(rejected, false);
    f.stop();
    let caught = false;
    try {
      await original;
    } catch (error) {
      caught = true;
      assert.equal(error, primary);
    }
    assert(caught);
    assert.equal(f.child.listenerCount('error'), 0);
    assert.equal(f.child.listenerCount('close'), 0);
    assert.equal(f.signals, 0);
  });
}

test('canonical group capture can confirm absence without the original root birth', async () => {
  const f = fixture('darwin', false);
  let groupVisible = true;
  f.setSnapshot(async () => ({
    stdout: groupVisible
      ? `23457 ${f.child.pid} ${f.child.pid} S ${birth}\n`
      : '',
    stderr: '',
  }));
  const canonical = new f.api.CanonicalOwner({
    profile: '/fixture/profile',
    executable: '/fixture/electron',
  });
  const returned = await canonical.launch(async () => {
    const child = f.launch();
    await canonical.scopes[0].ready;
    groupVisible = false;
    f.stop();
    return child;
  });
  canonical.confirm(returned);
  assert.equal(canonical.child, f.child);
  assert.equal(canonical.scopes[0].rootStart, undefined);
  assert.equal(canonical.scopes[0].capturedRows, true);
  const result = await canonical.shutdown();
  assert.equal(result.terminated, true);
  assert.equal(result.errors.length, 0);
  assert.equal(f.signals, 0);
  // This is exact canonical source against inert snapshots, not a native
  // duplicate qualification. The adapter refuses missing root birth evidence.
});

test('pending original session close cannot turn bounded canonical absence into success', async () => {
  const f = fixture();
  let release!: () => void;
  let closes = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.session.close = async () => {
    closes++;
    f.stop();
    await held;
  };
  const transport = f.make();
  const owner = transport.owner();
  await owner.open({});
  const result = await owner.shutdown();
  assert.equal(f.child.exitCode, 0);
  assert.equal(result.terminated, false);
  assert(
    result.errors.some((error: Error) => /still pending/.test(error.message)),
  );
  assert.equal(transport.operations.pending.size, 1);
  release();
  await transport.operations.settle();
  assert.equal(await owner.shutdown(), result);
  assert.equal(closes, 1);
  assert.equal(f.signals, 0);
});

test('canonical birth reuse excludes the unrelated replacement from cleanup', async () => {
  const f = fixture();
  const transport = f.make();
  const owner = transport.owner();
  await owner.open({});
  f.session.close = async () => {
    f.stop();
    f.setSnapshot(async () => ({
      stdout: `${f.child.pid} 100 ${f.child.pid} S Fri Oct  2 12:34:57 2026\n`,
      stderr: '',
    }));
  };
  const result = await owner.shutdown();
  assert.equal(result.terminated, true);
  assert.equal(result.errors.length, 0);
  assert.equal(f.signals, 0);
  assert.equal(owner.canonical.scopes[0].groupRetired, true);
});

test('parent close is insufficient while the canonical retained descendant remains', async () => {
  const f = fixture();
  let root = true;
  f.setSnapshot(async () => ({
    stdout: `${root ? `${f.child.pid} 100 ${f.child.pid} S ${birth}\n` : ''}23457 ${f.child.pid} 23457 S ${birth}\n`,
    stderr: '',
  }));
  f.session.close = async () => {
    root = false;
    f.stop();
  };
  const owner = f.make().owner();
  await owner.open({});
  const result = await owner.shutdown();
  assert.equal(f.child.exitCode, 0);
  assert.equal(result.terminated, false);
  assert(result.errors.length > 0);
  assert(f.signals > 0); // Inert VM denial, never an OS signal.
});

test('an unverified returned handle grants neither close nor signaling authority', async () => {
  const f = fixture();
  let foreignCloses = 0;
  const foreign = {
    process: () => Object.assign(new EventEmitter(), { pid: 34567 }),
    close: async () => {
      foreignCloses++;
    },
  };
  const transport = f.make(async () => {
    f.launch();
    return foreign as any;
  });
  const owner = transport.owner();
  await assert.rejects(owner.open({}), /does not match/);
  const result = await owner.shutdown();
  assert.equal(result.terminated, false);
  assert.equal(foreignCloses, 0);
  assert.equal(f.signals, 0);
});

for (const primary of [undefined, null, false, 0, '', new Error('RAW')]) {
  test(`actual workflow and canonical captured rejection preserve ${String(primary)}`, async () => {
    const f = fixture();
    const transport = f.make(async () => {
      f.launch();
      await Promise.resolve();
      f.stop();
      throw primary;
    });
    let evidence: any;
    let caught = false;
    try {
      await f.api.runSampleAudit({
        transport,
        options: {},
        expect() {
          throw Error('UI forbidden');
        },
        writeEvidence: async (value: any) => {
          evidence = value;
        },
      });
    } catch (error) {
      caught = true;
      assert.equal((error as AggregateError).cause, primary);
      assert.equal((error as AggregateError).errors[0], primary);
    }
    assert(caught);
    assert.equal(evidence.failed, true);
    assert.equal(evidence.confirmedOwnedAbsence, false);
    assert.equal(evidence.profileRetained, true);
    assert.equal(f.spawned, 1);
    assert.equal(f.signals, 0);
  });
}

test('original full child close is required after parent exit and successful session close', async () => {
  const f = fixture();
  f.session.close = async () => f.exitOnly();
  const transport = f.make();
  const owner = transport.owner();
  await owner.open({});
  const cleanup = owner.shutdown();
  await assert.rejects(
    transport.deadline(() => cleanup, 5, 'Owned sample shutdown'),
    /timed out/,
  );
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.listenerCount('close'), 1);
  f.stop();
  assert.equal((await cleanup).terminated, true);
  assert.equal(f.child.listenerCount('close'), 0);
  assert.equal(f.child.listenerCount('error'), 0);
  assert.equal(f.signals, 0);
});

test('birthless canonical group capture is refused by the actual duplicate adapter', async () => {
  const f = fixture('darwin', false);
  let visible = true;
  f.setSnapshot(async () => ({
    stdout: visible ? `23457 ${f.child.pid} ${f.child.pid} S ${birth}\n` : '',
    stderr: '',
  }));
  const transport = f.make();
  const owner = transport.owner();
  await assert.rejects(owner.duplicate({}), /birth unconfirmed/);
  visible = false;
  f.stop();
  const result = await owner.shutdown();
  assert.equal(result.terminated, false);
  assert.equal(owner.canonical.scopes[0].rootStart, undefined);
  assert.equal(owner.canonical.scopes[0].capturedRows, true);
  assert.equal(f.child.listenerCount('close'), 0);
  assert.equal(f.child.listenerCount('error'), 0);
  assert.equal(f.spawned, 1);
  assert.equal(f.signals, 0);
});

test('a duplicate with original birth and full close uses canonical absence without replay', async () => {
  const f = fixture();
  const transport = f.make();
  const owner = transport.owner();
  const delivery = owner.duplicate({});
  delivery.catch(() => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  f.stop();
  await delivery;
  const result = await owner.shutdown();
  assert.equal(result.terminated, true);
  assert.equal(result.errors.length, 0);
  assert.equal(f.spawned, 1);
  assert.equal(f.signals, 0);
});
