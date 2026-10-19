import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const helper = readFileSync(
  process.env.CANOPY_SETTLEMENT_HELPER ??
    new URL('../tools/audit-lifecycle.mjs', import.meta.url),
  'utf8',
);
const adapter = readFileSync(
  process.env.CANOPY_SETTLEMENT_ADAPTER ??
    new URL('../tools/authoring-audit.mjs', import.meta.url),
  'utf8',
);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (value?: any) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function boundary() {
  let rows = '';
  let child = { pid: 4242, exitCode: null as number | null, signalCode: null };
  const signals: unknown[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const spawn = (..._args: any[]) => child;
  const cp = { spawn, execFile: () => {} };
  const shared = runInNewContext(
    helper.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
      '\n;({AuditOwner,deadline,finishAudit})',
    {
      childProcess: cp,
      promisify: () => async () => ({ stdout: rows }),
      syncBuiltinESMExports: () => {},
      cpus: () => [],
      freemem: () => 0,
      totalmem: () => 0,
      process: {
        pid: 100,
        platform: 'darwin',
        env: {},
        kill: (...args: unknown[]) => signals.push(args),
      },
      setTimeout: (callback: () => void, ms: number) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: any) => {
        if (timer) timer.cleared = true;
      },
    },
  );
  const factory = runInNewContext(
    adapter.replace(/^export /gm, '') + ';authoringAuditLifecycle',
  );
  const owner = () =>
    new shared.AuditOwner({ profile: 'inert', executable: 'inert' });
  const capture = () =>
    cp.spawn('inert', [], {
      detached: true,
      env: { CANOPY_USER_DATA: 'inert' },
    } as any);
  return {
    shared,
    cp,
    spawn,
    owner,
    capture,
    signals,
    audit: () =>
      factory(shared)({
        profile: 'inert',
        executable: 'inert',
        report: () => {},
      }),
    alive: (pid = 4242) => {
      child = { pid, exitCode: null, signalCode: null };
      rows = `${pid} 100 ${pid} S Sat Oct  3 12:00:00 2026\n`;
      return child;
    },
    absent: () => {
      child.exitCode = 0;
      rows = '';
    },
    expire: (ms: number) => {
      const timer = timers.find((timer) => !timer.cleared && timer.ms === ms);
      assert.ok(timer, `deadline ${ms}`);
      timer.cleared = true;
      timer.callback();
    },
  };
}
async function failed(promise: Promise<any>) {
  try {
    await promise;
  } catch (error) {
    return error as any;
  }
  assert.fail('expected retained failure');
}

for (const spawnLate of [false, true]) {
  test(`pending launch retains capture and profile through late settlement (spawn=${spawnLate})`, async () => {
    const h = boundary(),
      gate = deferred(),
      audit = h.audit();
    const launch = failed(
      audit.launch('initial', async () => {
        await gate.promise;
        if (spawnLate) h.capture();
        return {};
      }),
    );
    await turn();
    h.expire(30_000);
    const primary = await launch;
    let removed = false;
    const result = await failed(
      audit.finish({
        primary,
        primaryFailed: true,
        removeProfile: async () => {
          removed = true;
        },
      }),
    );
    assert.equal(removed, false);
    assert.equal(result.cause, primary);
    assert.notEqual(
      h.cp.spawn,
      h.spawn,
      'capture belongs to original pending acquisition',
    );
    if (spawnLate) h.alive();
    gate.resolve();
    await turn();
    assert.equal(
      h.cp.spawn,
      h.spawn,
      'capture restored upon original settlement',
    );
    const again = await failed(
      audit.finish({
        primary,
        primaryFailed: true,
        removeProfile: async () => {
          removed = true;
        },
      }),
    );
    assert.equal(again.cause, primary);
    assert.equal(removed, false, 'late settlement cannot grant deletion');
    assert.equal(
      h.signals.length,
      0,
      'late spawn cannot grant orphan signaling',
    );
  });
}

test('captured clean exit and fresh absence do not settle an original close writer', async () => {
  const h = boundary(),
    owner = h.owner(),
    gate = deferred();
  h.alive();
  await owner.launch(async () => {
    h.capture();
    return {};
  });
  h.absent();
  let removed = false,
    closes = 0;
  const finish = failed(
    h.shared.finishAudit({
      owner,
      close: () => {
        closes++;
        return gate.promise;
      },
      removeProfile: async () => {
        removed = true;
      },
      writeEvidence: async () => {},
    }),
  );
  await turn();
  h.expire(10_000);
  await finish;
  assert.equal(removed, false);
  assert.equal(closes, 1);
  assert.equal(owner.operationsSettled, false);
  gate.resolve();
  await turn();
  assert.equal(owner.operationsSettled, true);
  assert.equal(owner.retained, true);
  const result = await owner.shutdown(() => {
    closes++;
    return Promise.resolve();
  });
  assert.equal(result.terminated, false);
  assert.equal(closes, 1);
  assert.equal(h.signals.length, 0);
});

test('settled close permits removal only after original writer and fresh scope absence', async () => {
  const h = boundary(),
    owner = h.owner(),
    gate = deferred();
  h.alive();
  await owner.launch(async () => {
    h.capture();
    return {};
  });
  const effects: string[] = [];
  const finish = h.shared.finishAudit({
    owner,
    close: async () => {
      await gate.promise;
      effects.push('writer');
      h.absent();
    },
    removeProfile: async () => {
      effects.push('remove');
    },
    writeEvidence: async () => {
      effects.push('evidence');
    },
  });
  await turn();
  assert.deepEqual(effects, []);
  gate.resolve();
  await finish;
  assert.deepEqual(effects, ['writer', 'evidence', 'remove']);
  assert.equal(h.signals.length, 0);
});

test('no captured child retains the profile without signals', async () => {
  const h = boundary(),
    owner = h.owner();
  await failed(owner.launch(async () => ({})));
  const result = await owner.shutdown();
  assert.equal(result.terminated, false);
  assert.equal(h.signals.length, 0);
});

test('overlapping owner hooks restore the original spawn after out-of-order settlement', async () => {
  const h = boundary(),
    first = h.owner(),
    second = h.owner(),
    a = deferred(),
    b = deferred();
  const one = failed(first.launch(() => a.promise));
  const two = failed(second.launch(() => b.promise));
  await turn();
  a.resolve();
  await one;
  assert.notEqual(h.cp.spawn, h.spawn);
  b.resolve();
  await two;
  assert.equal(h.cp.spawn, h.spawn);
});

for (const phase of ['diagnostic', 'evidence', 'run']) {
  test(`pending ${phase} writer retains profile even after late settlement`, async () => {
    const h = boundary(),
      audit = h.audit(),
      gate = deferred();
    h.alive();
    const app = { process: () => h.capture(), close: async () => h.absent() };
    const owner = h.owner();
    if (phase === 'run') {
      const child = h.capture();
      app.process = () => child;
      await audit.launch('initial', async () => {
        h.capture();
        return app;
      });
      const run = failed(audit.run('write', () => gate.promise));
      await turn();
      h.expire(30_000);
      await run;
      let removed = false;
      await failed(
        audit.finish({
          app,
          removeProfile: async () => {
            removed = true;
          },
        }),
      );
      assert.equal(removed, false);
      gate.resolve();
      await turn();
      await failed(
        audit.finish({
          app,
          removeProfile: async () => {
            removed = true;
          },
        }),
      );
      assert.equal(removed, false);
    } else {
      await owner.launch(async () => {
        h.capture();
        return {};
      });
      h.absent();
      let removed = false;
      const finish = failed(
        h.shared.finishAudit({
          owner,
          close: async () => {},
          diagnostics:
            phase === 'diagnostic'
              ? [{ label: 'writer', run: () => gate.promise }]
              : [],
          writeEvidence: () =>
            phase === 'evidence' ? gate.promise : Promise.resolve(),
          removeProfile: async () => {
            removed = true;
          },
        }),
      );
      await turn();
      h.expire(3000);
      await finish;
      assert.equal(removed, false);
      gate.resolve();
      await turn();
      assert.equal(removed, false);
    }
  });
}

test('restart refuses an unsettled close and finalization never repeats it', async () => {
  const h = boundary(),
    audit = h.audit(),
    gate = deferred();
  const child = h.alive();
  let closes = 0;
  const app = {
    process: () => child,
    close: () => {
      closes++;
      return gate.promise;
    },
  };
  await audit.launch('initial', async () => {
    h.capture();
    return app;
  });
  h.absent();
  const close = failed(audit.closeForRestart(app));
  await turn();
  h.expire(10_000);
  const primary = await close;
  await failed(
    audit.launch('restart', async () => {
      assert.fail('restart launch refused');
    }),
  );
  let removed = false;
  await failed(
    audit.finish({
      app,
      primary,
      primaryFailed: true,
      removeProfile: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(closes, 1);
  assert.equal(removed, false);
  gate.resolve();
  await turn();
  await failed(
    audit.finish({
      app,
      primary,
      primaryFailed: true,
      removeProfile: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(closes, 1);
  assert.equal(removed, false);
  assert.equal(h.signals.length, 0);
});

for (const primary of [undefined, null, false, 0, '']) {
  test(`pending writer cleanup keeps raw ${String(primary)} primary`, async () => {
    const h = boundary(),
      owner = h.owner(),
      gate = deferred();
    h.alive();
    await owner.launch(async () => {
      h.capture();
      return {};
    });
    h.absent();
    let removed = false;
    const finish = failed(
      h.shared.finishAudit({
        owner,
        primary,
        primaryFailed: true,
        close: () => gate.promise,
        removeProfile: async () => {
          removed = true;
        },
        writeEvidence: async () => {},
        secondary: () => {
          throw false;
        },
      }),
    );
    await turn();
    h.expire(10_000);
    const result = await finish;
    assert.equal(result.cause, primary);
    assert.equal(result.errors[0], primary);
    assert.equal(removed, false);
    gate.reject(null);
    await turn();
    assert.equal(h.signals.length, 0);
  });
}

test('unformattable diagnostics preserve raw primary and secondary values', async () => {
  const h = boundary(),
    owner = h.owner();
  h.alive();
  await owner.launch(async () => {
    h.capture();
    return {};
  });
  h.absent();
  const primary = {
    get message() {
      throw new Error('formatter');
    },
  };
  const secondary = {
    toString() {
      throw new Error('formatter');
    },
  };
  const result = await failed(
    h.shared.finishAudit({
      owner,
      primary,
      primaryFailed: true,
      close: async () => {},
      diagnostics: [
        {
          label: 'fault',
          run: async () => {
            throw secondary;
          },
        },
      ],
      removeProfile: async () => {},
      writeEvidence: async () => {},
    }),
  );
  assert.equal(result.cause, primary);
  assert.equal(result.errors[0], primary);
  assert.equal(result.errors[1].cause, secondary);
});
