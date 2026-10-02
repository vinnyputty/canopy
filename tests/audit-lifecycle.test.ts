import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AuditOwner,
  deadline,
  finishAudit,
} from '../tools/audit-lifecycle.mjs';

// PowerShell/CIM startup is a subprocess operation, not a close-hang probe.
const processBudgets =
  process.platform === 'win32'
    ? { operationMs: 3000, killMs: 5000 }
    : { operationMs: 1000, killMs: 1500 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

async function fixture(
  signalGroup?: ConstructorParameters<typeof AuditOwner>[0]['signalGroup'],
  escaped = false,
  killTree?: ConstructorParameters<typeof AuditOwner>[0]['killTree'],
) {
  const profile = await mkdtemp(join(tmpdir(), 'canopy-lifecycle-node-'));
  const owner = new AuditOwner({
    profile,
    executable: process.execPath,
    graceMs: 120,
    ...processBudgets,
    signalGroup,
    killTree,
  });
  let child!: ChildProcess;
  let descendant = 0;
  const dispose = async () => {
    // Only the subprocess handles/PIDs created and observed by this fixture.
    owner.restore();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
      else child.kill('SIGKILL');
      await deadline(() => exit, 5000, 'Fixture process exit');
    }
    if (descendant) {
      try {
        process.kill(descendant, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      for (let i = 0; i < 100 && alive(descendant); i++) await sleep(20);
      assert.equal(alive(descendant), false);
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    // Same POSIX group as Playwright's detached launcher; Windows uses its tree.
    await owner.launch(async () => {
      child = childProcess.spawn(
        process.execPath,
        [
          '-e',
          `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'], {stdio:'ignore', detached: ${escaped && process.platform !== 'win32'}});
      console.log(child.pid);
      process.on('message',(message)=> {
        if(message==='normal') { child.once('exit',()=>process.exit(0)); child.kill(); }
        if(message==='abnormal') process.exit(9);
        if(message==='abnormal-reaped') { child.once('exit',()=>process.exit(9)); child.kill(); }
        if(message==='orphan') process.exit(0);
      });
      setInterval(()=>{},1000);
    `,
        ],
        {
          detached: process.platform !== 'win32',
          env: { ...process.env, CANOPY_USER_DATA: profile },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const [data] = await once(child.stdout!, 'data');
      descendant = Number(String(data).trim());
      assert.ok(descendant > 1 && alive(descendant));
      return child;
    });
    owner.confirm(child);
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Fixture initialization and cleanup failed',
        { cause: error },
      );
    }
    throw error;
  }

  return {
    profile,
    owner,
    child,
    descendant,
    async remove() {
      // An external safety property: no live writers when removal starts.
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(
        alive(descendant),
        false,
        'descendant must be gone before deleting profile',
      );
      await rm(profile, { recursive: true, force: true });
    },
    dispose,
  };
}

const noop = async () => {};
async function normalClose(child: ChildProcess) {
  const exited = once(child, 'exit');
  child.send('normal');
  await exited;
}

// Sequential in this file: launch interception is deliberately scoped to one launch.
test('normal shutdown reaps its real descendant before profile removal and leaves unrelated child alone', async () => {
  const f = await fixture();
  const unrelated = childProcess.spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  await once(unrelated, 'spawn');
  try {
    await finishAudit({
      owner: f.owner,
      close: () => normalClose(f.child),
      removeProfile: () => f.remove(),
      writeEvidence: noop,
    });
    await assert.rejects(access(f.profile));
    assert.equal(alive(unrelated.pid!), true);
  } finally {
    await f.dispose();
    unrelated.kill('SIGKILL');
    await once(unrelated, 'exit');
  }
});

for (const mode of ['reject', 'hang'] as const) {
  test(`${mode}ing close terminates only the actual owned group/tree and fails otherwise successful audit`, async () => {
    const f = await fixture();
    const unrelated = childProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    );
    await once(unrelated, 'spawn');
    try {
      const start = Date.now();
      await assert.rejects(
        finishAudit({
          owner: f.owner,
          close:
            mode === 'reject'
              ? async () => {
                  throw new Error('close rejected');
                }
              : () => new Promise(() => {}),
          removeProfile: () => f.remove(),
          writeEvidence: noop,
        }),
        (error: AggregateError) => {
          assert.match(
            error.message,
            mode === 'reject' ? /close rejected/ : /timed out/,
          );
          return true;
        },
      );
      assert.ok(
        Date.now() - start < (process.platform === 'win32' ? 30000 : 6000),
      );
      assert.equal(alive(f.descendant), false);
      assert.equal(alive(unrelated.pid!), true);
      await assert.rejects(access(f.profile));
    } finally {
      await f.dispose();
      unrelated.kill('SIGKILL');
      await once(unrelated, 'exit');
    }
  });
}

for (const mode of ['abnormal', 'orphan'] as const) {
  test(`resolved close with ${mode} root exit still cleans retained descendants and fails`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        finishAudit({
          owner: f.owner,
          close: async () => {
            const exit = once(f.child, 'exit');
            f.child.send(mode);
            await exit;
          },
          removeProfile: () => f.remove(),
          writeEvidence: noop,
        }),
        AggregateError,
      );
      assert.equal(alive(f.descendant), false);
      await assert.rejects(access(f.profile));
    } finally {
      await f.dispose();
    }
  });
}

test('failed scoped signaling retains profile, verifies failure, and preserves original assertion', async () => {
  const denied = () => {
    throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
  };
  const f = await fixture(denied, false, async () => denied());
  const primary = new Error('ORIGINAL ASSERTION');
  let removalAttempted = false;
  const secondary: string[] = [];
  try {
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        primary,
        close: async () => {
          throw new Error('close rejected');
        },
        removeProfile: async () => {
          removalAttempted = true;
        },
        writeEvidence: noop,
        secondary: (error) => secondary.push(error.message),
      }),
      (error: AggregateError) => {
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.ok(
          error.errors.some((e: Error) => e.message.includes('signal denied')),
        );
        return true;
      },
    );
    assert.equal(removalAttempted, false);
    assert.equal(alive(f.descendant), true);
    await access(f.profile);
    assert.ok(
      secondary.some((message) => message.includes('Profile retained')),
    );
  } finally {
    await f.dispose();
  }
});

test('evidence/removal faults remain secondary to assertion and do not skip owned shutdown', async () => {
  const f = await fixture();
  const primary = new Error('ORIGINAL ASSERTION');
  const messages: string[] = [];
  try {
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        primary,
        close: () => normalClose(f.child),
        diagnostics: [
          {
            label: 'Screenshot',
            run: async () => {
              throw new Error('EVIDENCE EACCES');
            },
          },
          {
            label: 'DOM',
            run: async () => {
              throw new Error('EVIDENCE ENOTDIR');
            },
          },
        ],
        removeProfile: async () => {
          assert.equal(alive(f.descendant), false);
          throw new Error('PROFILE EBUSY');
        },
        writeEvidence: async () => {
          throw new Error('CHECKS WRITE FAILURE');
        },
        secondary: (error) => messages.push(error.message),
      }),
      (error: AggregateError) => {
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        for (const fault of ['EACCES', 'ENOTDIR', 'EBUSY', 'CHECKS WRITE'])
          assert.ok(error.errors.some((e: Error) => e.message.includes(fault)));
        return true;
      },
    );
    assert.equal(alive(f.descendant), false);
    assert.equal(messages.length, 4);
  } finally {
    await f.dispose();
  }
});

test('hung diagnostic is bounded, preserves assertion and still terminates actual descendants', async () => {
  const f = await fixture();
  const primary = new Error('ORIGINAL ASSERTION');
  try {
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        primary,
        close: () => normalClose(f.child),
        diagnostics: [
          { label: 'Screenshot', run: () => new Promise(() => {}) },
        ],
        operationMs: 80,
        removeProfile: () => f.remove(),
        writeEvidence: noop,
      }),
      (error: AggregateError) => {
        assert.equal(error.cause, primary);
        assert.match(error.errors[1].message, /Screenshot.*timed out/);
        return true;
      },
    );
    assert.equal(alive(f.descendant), false);
  } finally {
    await f.dispose();
  }
});

test('launch rejection after actual spawn retains original launch error while cleaning process scope', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'canopy-lifecycle-launch-'));
  const owner = new AuditOwner({
    profile,
    executable: process.execPath,
    graceMs: 50,
    ...processBudgets,
  });
  const original = new Error('ORIGINAL LAUNCH');
  let child!: ChildProcess;
  try {
    await assert.rejects(
      owner.launch(async () => {
        child = childProcess.spawn(
          process.execPath,
          ['-e', 'setInterval(()=>{},1000)'],
          {
            detached: process.platform !== 'win32',
            env: { ...process.env, CANOPY_USER_DATA: profile },
            stdio: 'ignore',
          },
        );
        await once(child, 'spawn');
        throw original;
      }),
      (error) => error === original,
    );
    await assert.rejects(
      finishAudit({
        owner,
        primary: original,
        diagnostics: [
          {
            label: 'Launch evidence',
            run: async () => {
              throw new Error('EVIDENCE ENOTDIR');
            },
          },
        ],
        removeProfile: async () => {
          assert.ok(child.exitCode !== null || child.signalCode !== null);
          await rm(profile, { recursive: true, force: true });
        },
        writeEvidence: noop,
      }),
      (error: AggregateError) =>
        error.cause === original && error.errors[0] === original,
    );
    assert.equal(alive(child.pid!), false);
  } finally {
    owner.restore();
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
  }
});

test('launch failure without spawned process preserves primary while reporting filesystem faults', async () => {
  const owner = new AuditOwner({
    profile: 'never-created',
    executable: process.execPath,
  });
  const primary = new Error('ORIGINAL LAUNCH');
  await assert.rejects(
    finishAudit({
      owner,
      primary,
      diagnostics: [
        {
          label: 'Evidence directory',
          run: async () => {
            throw new Error('EVIDENCE ENOTDIR');
          },
        },
      ],
      removeProfile: async () => {
        throw new Error('PROFILE EBUSY');
      },
      writeEvidence: async () => {
        throw new Error('EVIDENCE EACCES');
      },
    }),
    (error: AggregateError) =>
      error.cause === primary &&
      error.errors[0] === primary &&
      error.errors.length === 4,
  );
});

test('otherwise successful audit fails evidence/removal errors independently', async () => {
  const owner = new AuditOwner({
    profile: 'never-created',
    executable: process.execPath,
  });
  await assert.rejects(
    finishAudit({
      owner,
      removeProfile: async () => {
        throw new Error('PROFILE EBUSY');
      },
      writeEvidence: async () => {
        throw new Error('EVIDENCE EACCES');
      },
    }),
    (error: AggregateError) => error.errors.length === 2,
  );
});

test('deadline bounds an audit stalled after a real owned launch and cleanup still succeeds in terminating it', async () => {
  const f = await fixture();
  let primary: unknown;
  try {
    try {
      await deadline(() => new Promise(() => {}), 50, 'Audit body');
    } catch (error) {
      primary = error;
    }
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        primary,
        removeProfile: () => f.remove(),
        writeEvidence: noop,
      }),
      (error: AggregateError) => error.cause === primary,
    );
    assert.equal(alive(f.descendant), false);
  } finally {
    await f.dispose();
  }
});

test('abnormal resolved close fails even when all descendants exited normally', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        close: async () => {
          const exit = once(f.child, 'exit');
          f.child.send('abnormal-reaped');
          await exit;
        },
        removeProfile: () => f.remove(),
        writeEvidence: noop,
      }),
      (error: AggregateError) => {
        assert.ok(
          error.errors.some((detail: Error) =>
            /Abnormal audit exit: code=9/.test(detail.message),
          ),
        );
        assert.ok(
          !error.errors.some((detail: Error) =>
            /forced shutdown/.test(detail.message),
          ),
        );
        return true;
      },
    );
    assert.equal(alive(f.descendant), false);
  } finally {
    await f.dispose();
  }
});

test(
  'a no-op signal cannot claim termination or remove a live profile',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture(() => false);
    let removal = false;
    try {
      await assert.rejects(
        finishAudit({
          owner: f.owner,
          close: async () => {
            throw new Error('close rejected');
          },
          removeProfile: async () => {
            removal = true;
          },
          writeEvidence: noop,
        }),
        (error: AggregateError) =>
          error.errors.some((detail: Error) =>
            /termination could not be established/.test(detail.message),
          ),
      );
      assert.equal(removal, false);
      assert.equal(alive(f.descendant), true);
      await access(f.profile);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'retained descendant that left the POSIX group is still terminated by birth identity',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture(undefined, true);
    try {
      await assert.rejects(
        finishAudit({
          owner: f.owner,
          close: async () => {
            throw new Error('close rejected');
          },
          removeProfile: () => f.remove(),
          writeEvidence: noop,
        }),
        AggregateError,
      );
      assert.equal(alive(f.descendant), false);
    } finally {
      await f.dispose();
    }
  },
);

test('secondary logging failure cannot mask primary or prevent shutdown', async () => {
  const f = await fixture();
  const primary = new Error('ORIGINAL ASSERTION');
  try {
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        primary,
        close: () => normalClose(f.child),
        diagnostics: [
          {
            label: 'Evidence',
            run: async () => {
              throw new Error('EVIDENCE EACCES');
            },
          },
        ],
        removeProfile: () => f.remove(),
        writeEvidence: noop,
        secondary: () => {
          throw new Error('logger rejected');
        },
      }),
      (error: AggregateError) =>
        error.cause === primary &&
        error.errors[0] === primary &&
        error.errors.some(
          (detail: Error) =>
            detail.message === 'Secondary error reporting failed',
        ),
    );
    assert.equal(alive(f.descendant), false);
  } finally {
    await f.dispose();
  }
});

test('exact palette audit catch/finally preserves assertion plus filesystem faults and reaps real children', async () => {
  const source = await readFile(
    join(process.cwd(), 'tools/palette-check.mjs'),
    'utf8',
  );
  const tail = source.slice(
    source.indexOf('} catch (error) {\n  failure = error;') + 1,
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction(
    'app',
    'page',
    'owner',
    'directory',
    'evidence',
    'record',
    'finishAudit',
    'rm',
    'mkdir',
    'writeFile',
    'join',
    'deadline',
    'injected',
    'let failure; const log=[]; try { throw injected; }' + tail,
  );
  const f = await fixture();
  const primary = new Error('ORIGINAL ASSERTION');
  const records: string[] = [];
  try {
    await assert.rejects(
      run(
        {
          process: () => f.child,
          close: async () => {
            throw new Error('close rejected');
          },
        },
        {
          isClosed: () => false,
          screenshot: async () => {},
          locator: () => ({ innerText: async () => 'owned fixture' }),
        },
        f.owner,
        f.profile,
        'unused-evidence',
        (message: string) => records.push(message),
        finishAudit,
        async () => {
          assert.equal(alive(f.descendant), false);
          throw new Error('PROFILE EBUSY');
        },
        async () => {
          throw new Error('EVIDENCE ENOTDIR');
        },
        async () => {
          throw new Error('EVIDENCE WRITE');
        },
        join,
        deadline,
        primary,
      ),
      (error: AggregateError) => {
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.ok(
          error.errors.some((detail: Error) =>
            /PROFILE EBUSY/.test(detail.message),
          ),
        );
        assert.ok(
          error.errors.some((detail: Error) =>
            /EVIDENCE ENOTDIR/.test(detail.message),
          ),
        );
        return true;
      },
    );
    assert.ok(records[0].includes('ORIGINAL ASSERTION'));
    assert.ok(records.some((message) => message.startsWith('SECONDARY')));
    assert.equal(alive(f.descendant), false);
  } finally {
    await f.dispose();
  }
});

test(
  'a launch without an isolated POSIX group is refused and its live profile retained',
  { skip: process.platform === 'win32' },
  async () => {
    const profile = await mkdtemp(
      join(tmpdir(), 'canopy-lifecycle-unverified-'),
    );
    const owner = new AuditOwner({
      profile,
      executable: process.execPath,
      graceMs: 50,
      killMs: 100,
    });
    let child!: ChildProcess;
    let removed = false;
    try {
      await assert.rejects(
        owner.launch(async () => {
          child = childProcess.spawn(
            process.execPath,
            ['-e', 'setInterval(()=>{},1000)'],
            {
              detached: false,
              env: { ...process.env, CANOPY_USER_DATA: profile },
              stdio: 'ignore',
            },
          );
          await once(child, 'spawn');
          return child;
        }),
        /isolated owned process scope/,
      );
      await assert.rejects(
        finishAudit({
          owner,
          removeProfile: async () => {
            removed = true;
          },
          writeEvidence: noop,
        }),
        AggregateError,
      );
      assert.equal(removed, false);
      assert.equal(alive(child.pid!), true);
      await access(profile);
    } finally {
      owner.restore();
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test('mismatched application handle is never closed and unrelated process stays alive', async () => {
  const f = await fixture();
  const other = childProcess.spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  await once(other, 'spawn');
  let closed = false;
  try {
    assert.throws(() => f.owner.confirm(other), /does not match/);
    await assert.rejects(
      finishAudit({
        owner: f.owner,
        close: async () => {
          closed = true;
          other.kill('SIGKILL');
        },
        removeProfile: () => f.remove(),
        writeEvidence: noop,
      }),
      AggregateError,
    );
    assert.equal(closed, false);
    assert.equal(alive(other.pid!), true);
    assert.equal(alive(f.descendant), false);
    await access(f.profile);
  } finally {
    await f.dispose();
    const exit = once(other, 'exit');
    other.kill('SIGKILL');
    await exit;
  }
});

// These probes retain real subprocess handles outside capture so an unknown
// launch can stay alive through finalization and still be cleaned by the test.
async function captureProbe(
  mode: 'command' | 'pid' | 'mixed' | 'exact' | 'irrelevant',
  unverifiedPid?: number,
) {
  const profile = await mkdtemp(join(tmpdir(), 'canopy-lifecycle-capture-'));
  const original = childProcess.spawn;
  const children: ChildProcess[] = [];
  const signals: number[] = [];
  const owner = new AuditOwner({
    profile,
    executable: process.execPath,
    graceMs: 100,
    ...processBudgets,
    signalGroup: (pid, signal) => {
      signals.push(pid);
      return process.kill(pid, signal as NodeJS.Signals);
    },
  });
  const primary = new Error('fixture launch interrupted');
  let removed = false;
  let closed = false;
  let known: ChildProcess | undefined;
  let unknown: ChildProcess | undefined;
  // Model a launcher command form or a returned handle without a usable PID.
  // The actual spawned executable is always this probe's own Node runtime.
  childProcess.spawn = ((command, args, options) => {
    if (
      command !== process.execPath &&
      command !== `${process.execPath}.different-command-form`
    )
      return original(command, args ?? [], options ?? {});
    const child = original(process.execPath, args ?? [], options ?? {});
    children.push(child);
    if (mode === 'pid' && options?.env?.CANOPY_USER_DATA === profile)
      return { pid: unverifiedPid } as ChildProcess;
    return child;
  }) as typeof childProcess.spawn;
  const spawn = async (command: string, bearingProfile = true) => {
    const env = { ...process.env };
    if (bearingProfile) env.CANOPY_USER_DATA = profile;
    else delete env.CANOPY_USER_DATA;
    const returned = childProcess.spawn(
      command,
      [
        '-e',
        "process.on('message',()=>process.exit(0)); setInterval(()=>{},1000)",
      ],
      {
        detached: process.platform !== 'win32',
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const actual = children.at(-1)!;
    await once(actual, 'spawn');
    assert.equal(alive(actual.pid!), true);
    return { actual, returned };
  };
  try {
    const operation = async () => {
      if (mode === 'mixed' || mode === 'exact' || mode === 'irrelevant')
        known = (await spawn(process.execPath)).actual;
      if (mode !== 'exact') {
        const result = await spawn(
          mode === 'command' || mode === 'mixed'
            ? `${process.execPath}.different-command-form`
            : process.execPath,
          mode !== 'irrelevant',
        );
        unknown = result.actual;
      }
      if (mode === 'exact' || mode === 'irrelevant') return known!;
      throw primary;
    };
    if (mode === 'exact' || mode === 'irrelevant') {
      const app = await owner.launch(operation);
      owner.confirm(app);
      await finishAudit({
        owner,
        close: async () => {
          closed = true;
          const exit = once(known!, 'exit');
          known!.send('normal');
          await exit;
        },
        removeProfile: async () => {
          assert.equal(known!.exitCode, 0);
          removed = true;
          await rm(profile, { recursive: true, force: true });
        },
        writeEvidence: noop,
      });
      assert.equal(closed, true);
      assert.equal(removed, true);
      assert.deepEqual(signals, []);
      if (unknown) assert.equal(alive(unknown.pid!), true);
    } else {
      await assert.rejects(
        owner.launch(operation),
        (error) => error === primary,
      );
      await assert.rejects(
        finishAudit({
          owner,
          primary,
          close: async () => {
            closed = true;
          },
          removeProfile: async () => {
            removed = true;
            await rm(profile, { recursive: true, force: true });
          },
          writeEvidence: noop,
        }),
        (error: AggregateError) => {
          assert.equal(error.cause, primary);
          assert.equal(error.errors[0], primary);
          assert.ok(
            error.errors.some((e: Error) =>
              /Unestablished launch ownership/.test(e.message),
            ),
          );
          return true;
        },
      );
      assert.equal(
        removed,
        false,
        'live unverified writer forbids profile removal',
      );
      assert.equal(
        closed,
        false,
        'unverified application close must not be called',
      );
      assert.equal(
        alive(unknown!.pid!),
        true,
        'unknown process must not be signaled',
      );
      await access(profile);
      if (known) {
        assert.ok(known.exitCode !== null || known.signalCode !== null);
        if (process.platform !== 'win32')
          assert.deepEqual(signals, [-known.pid!]);
      } else assert.deepEqual(signals, []);
    }
  } finally {
    owner.restore();
    childProcess.spawn = original;
    syncBuiltinESMExports();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await rm(profile, { recursive: true, force: true });
  }
}

test('profile-bearing unmatched command retains the live writer profile without signaling it', async () => {
  await captureProbe('command');
});

test('profile-bearing handle with unestablished PID retains its live writer profile', async () => {
  for (const pid of [undefined, Number.NaN, 0, process.pid])
    await captureProbe('pid', pid);
});

test('mixed verified and unknown launches clean only the verified scope and retain the shared profile', async () => {
  await captureProbe('mixed');
});

test('exact capture confirms its handle and permits profile removal after normal exit', async () => {
  await captureProbe('exact');
});

test('spawn without the audit profile does not block normal owned cleanup or get signaled', async () => {
  await captureProbe('irrelevant');
});

test('fixture initialization failure preserves its error and cleans observed real parent/descendant handles', async () => {
  const originalLaunch = AuditOwner.prototype.launch;
  const originalSpawn = childProcess.spawn;
  const primary = new Error('INITIAL SNAPSHOT FAILURE');
  let child: ChildProcess | undefined;
  let descendant = 0;
  let profile: string | undefined;
  childProcess.spawn = ((command, args, options) => {
    const created = originalSpawn(command, args ?? [], options ?? {});
    if (options?.env?.CANOPY_USER_DATA?.includes('canopy-lifecycle-node-')) {
      child = created;
      profile = options.env.CANOPY_USER_DATA;
      created.stdout!.once('data', (data) => {
        descendant = Number(String(data).trim());
      });
    }
    return created;
  }) as typeof childProcess.spawn;
  AuditOwner.prototype.launch = async function (operation) {
    await originalLaunch.call(this, operation);
    throw primary;
  };
  try {
    await assert.rejects(fixture(), (error) => error === primary);
    assert.ok(child && descendant && profile);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(alive(descendant), false);
    await assert.rejects(access(profile));
  } finally {
    AuditOwner.prototype.launch = originalLaunch;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
      else child.kill('SIGKILL');
      await exit;
    }
    if (descendant && alive(descendant)) {
      process.kill(descendant, 'SIGKILL');
      for (let i = 0; i < 100 && alive(descendant); i++) await sleep(20);
    }
    if (profile) await rm(profile, { recursive: true, force: true });
  }
});
