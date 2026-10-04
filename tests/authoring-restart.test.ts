import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

let authoringAuditLifecycle: any;
before(async () => {
  ({ authoringAuditLifecycle } = await import(
    new URL('../tools/authoring-audit.mjs', import.meta.url).href
  ));
});

// Protocol doubles validate the adapter, not shared ownership/reaping or native GUI.
function protocol(reportError?: Error) {
  const calls: string[] = [];
  const child = { exitCode: 0, signalCode: null };
  let shutdown = { terminated: true, errors: [] as Error[] };
  let cleanup: any;
  const lifecycle = {
    AuditOwner: class {
      child = child;
      async launch(operation: () => Promise<unknown>) {
        calls.push('launch');
        return operation();
      }
      confirm(value: unknown) {
        assert.equal(value, child);
        calls.push('confirm');
      }
      async shutdown(close?: () => Promise<void>) {
        calls.push('shutdown');
        await close?.();
        return shutdown;
      }
    },
    deadline: async (operation: () => Promise<unknown>, ms: number) => {
      assert.equal(ms, 30_000);
      return operation();
    },
    finishAudit: async (value: unknown) => {
      cleanup = value;
    },
  };
  const records: any[] = [];
  const audit = authoringAuditLifecycle(lifecycle)({
    profile: 'disposable',
    executable: 'fixture',
    report: (value: string) => {
      records.push(JSON.parse(value));
      if (reportError) throw reportError;
    },
  });
  const app = {
    process: () => child,
    close: async () => {
      calls.push('close');
    },
  };
  return {
    audit,
    app,
    calls,
    records,
    failShutdown: (errors: Error[], terminated = false) => {
      shutdown = { terminated, errors };
    },
    cleanup: () => cleanup,
  };
}

test('authoring audit refuses absent shared primitives before native launch or profile creation', async () => {
  assert.throws(() => authoringAuditLifecycle(), /platform-qualified/);
  assert.throws(() => authoringAuditLifecycle({}), /platform-qualified/);
  const source = readFileSync(
    new URL('../tools/smoke-authoring.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'smoke-authoring.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'auditAuthoring',
  )!;
  let profiles = 0;
  const audit = runInNewContext(
    `(${declaration.getText(ast).replace(/^export /, '')})`,
    {
      authoringAuditLifecycle,
      mkdtemp: () => {
        profiles++;
        throw new Error('must not create a profile');
      },
    },
  );
  await assert.rejects(audit('fixture', 'fixture', {}), /platform-qualified/);
  assert.equal(profiles, 0);
});

test('authoring restart requires owned absence and refuses a failed close without relaunching', async () => {
  for (const terminated of [false, true]) {
    const fixture = protocol();
    await fixture.audit.launch('initial', async () => fixture.app);
    const closeFailure = new Error('owned close timeout');
    fixture.failShutdown([closeFailure], terminated);
    await assert.rejects(
      fixture.audit.closeForRestart(fixture.app),
      /restart refused/,
    );
    await assert.rejects(
      fixture.audit.launch('restart', async () => fixture.app),
      /not closed/,
    );
    await fixture.audit.finish({
      app: fixture.app,
      primary: closeFailure,
      removeProfile: async () => {},
    });
    assert.equal(
      fixture.cleanup().close,
      undefined,
      'do not repeat the timed-out close',
    );
    assert.equal(fixture.cleanup().primary, closeFailure);
    assert.equal(fixture.calls.filter((call) => call === 'launch').length, 1);
    assert.equal(fixture.calls.filter((call) => call === 'close').length, 1);
  }
});

test('authoring audit creates a fresh owner only after clean restart shutdown and retains primary reload error for shared cleanup', async () => {
  const fixture = protocol();
  await fixture.audit.launch('initial', async () => fixture.app);
  await fixture.audit.closeForRestart(fixture.app);
  await fixture.audit.launch('restart', async () => fixture.app);
  const primary = new Error('page.reload: Timeout 30000ms exceeded.');
  await assert.rejects(
    fixture.audit.run('restart:fixture-reload', async () => {
      throw primary;
    }),
    (error) => error === primary,
  );
  fixture.audit.failure(primary);
  const removeProfile = async () => {};
  await fixture.audit.finish({ app: fixture.app, primary, removeProfile });
  const cleanup = fixture.cleanup();
  assert.equal(cleanup.primary, primary);
  assert.equal(cleanup.removeProfile, removeProfile);
  assert.ok(
    cleanup.owner,
    'shared owner, not a raw PID, controls profile deletion',
  );
  assert.ok(cleanup.close);
  assert.deepEqual(cleanup.diagnostics, []);
  assert.equal(fixture.calls.filter((call) => call === 'confirm').length, 2);
  assert.equal(fixture.records.at(-1).status, 'primary');
  assert.equal(fixture.records.at(-1).stage, 'restart:fixture-reload');
});

test('authoring progress reporting faults remain secondary to the actual operation failure', async () => {
  const reportError = new Error('progress output failed');
  const fixture = protocol(reportError);
  await fixture.audit.launch('initial', async () => fixture.app);
  const primary = new Error('reload timed out');
  await assert.rejects(
    fixture.audit.run('restart:fixture-reload', async () => {
      throw primary;
    }),
    (error) => error === primary,
  );
  fixture.audit.failure(primary);
  await fixture.audit.finish({
    app: fixture.app,
    primary,
    removeProfile: async () => {},
  });
  const cleanup = fixture.cleanup();
  assert.equal(cleanup.primary, primary);
  assert.ok(cleanup.diagnostics.length);
  for (const diagnostic of cleanup.diagnostics)
    await assert.rejects(diagnostic.run(), (error) => error === reportError);
});

test('actual adapter surfaces a real Node22 execFile timeout before cleanup and retains the ChildProcess close evidence', async () => {
  const fixture = protocol();
  await fixture.audit.launch('initial', async () => fixture.app);
  const execute = promisify(execFile);
  // This child starts no descendants. Node owns its direct timeout termination.
  const operation = execute(
    process.execPath,
    [
      '-e',
      "process.stderr.write('owned-node-started'); setInterval(() => {}, 1000)",
    ],
    { timeout: 250 },
  );
  const child = operation.child;
  let closed = false;
  const close = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  let primary: unknown;
  try {
    await fixture.audit.run('restart:node-control', () => operation);
    assert.fail('the owned child must time out');
  } catch (error) {
    primary = error;
    fixture.audit.failure(error);
  }
  await close;
  assert.equal(closed, true);
  assert.equal(child.killed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(fixture.records.at(-1).status, 'primary');
  await fixture.audit.finish({
    app: fixture.app,
    primary,
    removeProfile: async () => {},
  });
  assert.equal(fixture.cleanup().primary, primary);
});

test('actual authoring GitHub IPC installer resets fixture requests after restart and preserves deferred/write/hierarchy callbacks', async () => {
  const source = readFileSync(
    new URL('../tools/smoke-authoring.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'smoke-authoring.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === 'installGithubHandlers'
    ) {
      function find(inner: ts.Node) {
        if (
          ts.isCallExpression(inner) &&
          inner.expression.getText(ast) === 'evaluate'
        )
          callback = inner.arguments[0];
        ts.forEachChild(inner, find);
      }
      ts.forEachChild(node, find);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  const handlers = new Map<string, (...args: any[]) => any>();
  const context: any = {
    setTimeout,
    ipcMain: {
      removeHandler: (key: string) => handlers.delete(key),
      handle: (key: string, handler: any) => handlers.set(key, handler),
    },
  };
  const install = () =>
    runInNewContext(`(${callback!.getText(ast)})({ ipcMain })`, context);
  const invoke = (name: string, ...args: any[]) =>
    handlers.get(`canopy:${name}`)!(null, ...args);
  install();
  context.authoringSmoke.mode = 'deferred';
  const old = invoke('author', 'first', 'team/a#1', {
    kind: 'comment',
    value: 'old',
  });
  assert.equal(context.authoringSmoke.requests.length, 1);
  context.authoringSmoke.release();
  assert.equal((await old).state, 'saved');
  assert.equal(invoke('preview', 'first', 'team/a#1').comments[0].body, 'old');
  context.authoringSmoke.mode = 'partial';
  const partial = await invoke('author', 'first', 'team/a#1', {
    kind: 'child',
    summary: 'Child',
    description: '',
  });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.key, 'team/a#4');
  install();
  assert.equal(context.authoringSmoke.requests.length, 0);
  assert.equal(context.authoringSmoke.creates, 0);
  const plan = invoke('previewParent', 'first', 'team/a#1', 'team/a#10');
  assert.equal(plan.previousParent, 'team/a#9');
  assert.equal(
    (await invoke('author', 'first', 'team/a#1', { kind: 'parent', plan }))
      .state,
    'saved',
  );
  assert.equal(context.authoringSmoke.parent, 'team/a#10');
});

async function sharedLifecycle() {
  return import(new URL('../tools/audit-lifecycle.mjs', import.meta.url).href);
}

function authoringFunction() {
  const source = readFileSync(
    new URL('../tools/smoke-authoring.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'smoke-authoring.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'auditAuthoring',
  )!;
  return declaration.getText(ast).replace(/^export /, '');
}

test('actual authoring caller preserves every raw primary through shared cleanup and reporting faults', async () => {
  const shared = await sharedLifecycle();
  for (const value of [
    undefined,
    null,
    0,
    false,
    '',
    new Error('raw primary'),
  ]) {
    for (const secondaryFault of [false, true]) {
      const effects: string[] = [];
      const child = { exitCode: 0, signalCode: null };
      class ControlledOwner {
        child = child;
        async launch(operation: () => Promise<unknown>) {
          return operation();
        }
        confirm(actual: unknown) {
          assert.equal(actual, child);
        }
        async shutdown(close?: () => Promise<void>) {
          await close?.();
          return {
            terminated: true,
            errors: secondaryFault ? [new Error('close fault')] : [],
          };
        }
      }
      const page = {
        on: () => {},
        getByRole: () => ({
          waitFor: async () => {
            throw value;
          },
        }),
      };
      const app = {
        process: () => child,
        firstWindow: async () => page,
        close: async () => {
          effects.push('close');
        },
      };
      const actual = runInNewContext(`(${authoringFunction()})`, {
        authoringAuditLifecycle,
        mkdtemp: async () => 'controlled-profile',
        join: (...parts: string[]) => parts.join('/'),
        tmpdir: () => 'controlled-temp',
        electron: { launch: async () => app },
        rm: async () => {
          effects.push('remove');
          if (secondaryFault) throw new Error('filesystem fault');
        },
        console: { log: (message: string) => effects.push(message) },
      });
      // The extracted function is the actual tracked smoke, with controlled
      // effects and the exact shared deadline/finishAudit exports.
      const lifecycle = {
        ...shared,
        AuditOwner: ControlledOwner,
      };
      let rejected = false;
      try {
        await actual('unused', 'unused', {}, lifecycle);
      } catch (error) {
        rejected = true;
        if (secondaryFault) {
          assert.equal((error as AggregateError).cause, value);
          assert.equal((error as AggregateError).errors[0], value);
        } else assert.equal(error, value);
      }
      assert.equal(rejected, true, `caught ${String(value)} must reject`);
      assert.ok(effects.includes('close') && effects.includes('remove'));
      assert.ok(
        !effects.some((message) =>
          message.startsWith('Rich authoring acceptance passed'),
        ),
      );
    }
  }
});

test('shared adapter treats healthy omitted or undefined primary as success and logging faults as secondary', async () => {
  const shared = await sharedLifecycle();
  for (const explicit of [false, true]) {
    const fixture = protocol();
    const audit = authoringAuditLifecycle({
      ...shared,
      AuditOwner: class {
        child = fixture.app.process();
        async launch(operation: () => Promise<unknown>) {
          return operation();
        }
        confirm(actual: unknown) {
          assert.equal(actual, this.child);
        }
        async shutdown(close?: () => Promise<void>) {
          await close?.();
          return { terminated: true, errors: [] };
        }
      },
    })({ profile: 'controlled', executable: 'unused', report: () => {} });
    const app = await audit.launch('initial', async () => fixture.app);
    let removed = false;
    await audit.finish({
      app,
      ...(explicit ? { primary: undefined } : {}),
      removeProfile: async () => {
        removed = true;
      },
    });
    assert.equal(removed, true);
  }
  const value = undefined;
  const fixture = protocol();
  const audit = authoringAuditLifecycle({
    ...shared,
    AuditOwner: class {
      child = fixture.app.process();
      async launch(operation: () => Promise<unknown>) {
        return operation();
      }
      confirm() {}
      async shutdown() {
        return { terminated: true, errors: [] };
      }
    },
  })({
    profile: 'controlled',
    executable: 'unused',
    report: () => {
      throw new Error('logging fault');
    },
  });
  const app = await audit.launch('initial', async () => fixture.app);
  let caught = false;
  try {
    await audit.run('nullsafe', () => {
      throw value;
    });
  } catch (error) {
    caught = true;
    assert.equal(error, value);
  }
  assert.equal(caught, true);
  audit.failure(value);
  await assert.rejects(
    audit.finish({
      app,
      primary: value,
      primaryFailed: true,
      removeProfile: async () => {},
    }),
    (error: any) =>
      error.cause === value &&
      error.errors[0] === value &&
      error.errors.length > 1,
  );
});

for (const mode of ['normal', 'reject', 'hang', 'failed-launch'] as const) {
  test(`actual authoring adapter and shared owner control a real Node ${mode} scope`, async () => {
    const shared = await sharedLifecycle();
    const { default: childProcess } = await import('node:child_process');
    const { mkdtemp, rm, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { disposeProcess, withCleanup } =
      await import('./fixtures/owned-process.js');
    const profile = await mkdtemp(join(tmpdir(), 'canopy-authoring-node-'));
    let child: import('node:child_process').ChildProcess | undefined;
    const primary = new Error('controlled launch rejection');
    const audit = authoringAuditLifecycle({
      ...shared,
      AuditOwner: class extends shared.AuditOwner {
        constructor(options: any) {
          super({
            ...options,
            graceMs: 100,
            killMs: process.platform === 'win32' ? 60000 : 5000,
          });
        }
      },
    })({ profile, executable: process.execPath, report: () => {} });
    const app = {
      process: () => child,
      close: async () => {
        if (mode === 'reject') throw new Error('controlled close rejection');
        if (mode === 'hang') return new Promise<void>(() => {});
        const closed = once(child!, 'close');
        child!.send('close');
        await closed;
      },
    };
    await withCleanup(
      async () => {
        const launch = audit.launch('initial', async () => {
          child = childProcess.spawn(
            process.execPath,
            [
              '-e',
              "process.on('message', () => process.exit(0)); process.send('ready'); setTimeout(() => process.exit(72), 15000).unref();",
            ],
            {
              detached: process.platform !== 'win32',
              env: { ...process.env, CANOPY_USER_DATA: profile },
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            },
          );
          await shared.deadline(
            () => once(child!, 'message'),
            3000,
            'Node controller readiness',
          );
          if (mode === 'failed-launch') throw primary;
          return app;
        });
        if (mode === 'failed-launch')
          await assert.rejects(launch, (error) => error === primary);
        else assert.equal(await launch, app);
        const finish = audit.finish({
          app,
          primary,
          primaryFailed: mode === 'failed-launch',
          removeProfile: async () => {
            assert.ok(child!.exitCode !== null || child!.signalCode !== null);
            await rm(profile, { recursive: true, force: true });
          },
        });
        if (mode === 'normal') await finish;
        else
          await assert.rejects(finish, (error: any) =>
            mode === 'failed-launch'
              ? error === primary
              : error instanceof AggregateError,
          );
        await assert.rejects(access(profile));
      },
      () => disposeProcess(child),
      () => rm(profile, { recursive: true, force: true }),
    );
  });
}

// Execute the actual restart statements, launch closure and catch/finally. Only
// Electron/page boundaries and fixture installation are controlled here; this
// proves sequencing and failure propagation, not Chromium or native rendering.
function restartReadiness() {
  const source = readFileSync(
    new URL('../tools/smoke-authoring.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'smoke-authoring.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'auditAuthoring',
  ) as ts.FunctionDeclaration;
  const statements = declaration.body!.statements;
  const launch = statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => item.name.getText(ast) === 'launch',
      ),
  )!;
  const attempt = statements.find(ts.isTryStatement)!;
  const body = attempt.tryBlock.statements;
  const first = body.findIndex(
    (node) => node.getText(ast) === "await launch('restart');",
  );
  const last = body.findIndex((node) =>
    node.getText(ast).includes("audit.run('restart:fixture-reload'"),
  );
  assert.ok(first >= 0 && last > first);
  const fixture = protocol();
  const calls: string[] = [];
  let resolveLoad!: () => void;
  let rejectLoad!: (error: unknown) => void;
  const loaded = new Promise<void>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  let reachedLoad!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reachedLoad = resolve;
  });
  const page = {
    on: () => {},
    waitForLoadState: (state: string, options: { timeout: number }) => {
      assert.equal(state, 'load');
      assert.equal(options.timeout, 30_000);
      calls.push('load');
      reachedLoad();
      return loaded;
    },
    reload: async (options: { timeout: number }) => {
      assert.equal(options.timeout, 30_000);
      calls.push('reload');
    },
  };
  const app = { ...fixture.app, firstWindow: async () => page };
  const run = runInNewContext(
    `(async () => {
    let app, page, primary, primaryFailed = false;
    const errors = [];
    ${launch.getText(ast)}
    try { ${body
      .slice(first, last + 1)
      .map((node) => node.getText(ast))
      .join('\n')} }
    catch ${attempt.catchClause!.getText(ast).replace(/^catch /, '')}
    finally ${attempt.finallyBlock!.getText(ast)}
  })`,
    {
      audit: fixture.audit,
      electron: { launch: async () => app },
      appPath: 'sample',
      executablePath: 'fixture',
      env: {},
      installGithubHandlers: async () => {
        calls.push('install');
      },
      userData: 'disposable',
      rm: async () => {},
    },
  );
  return { run, calls, waiting, resolveLoad, rejectLoad, fixture };
}

test('actual restart holds fixture installation and reload until initial full load completes', async () => {
  const h = restartReadiness();
  const result = h.run();
  await h.waiting;
  assert.deepEqual(h.calls, ['load']);
  h.resolveLoad();
  await result;
  assert.deepEqual(h.calls, ['load', 'install', 'reload']);
  assert.equal(h.fixture.cleanup().primaryFailed, false);
  assert.equal(h.fixture.calls.filter((call) => call === 'confirm').length, 1);
});

test('actual restart proceeds when initial full load is already complete', async () => {
  const h = restartReadiness();
  h.resolveLoad();
  await h.run();
  assert.deepEqual(h.calls, ['load', 'install', 'reload']);
});

for (const primary of [
  new Error('initial navigation failed'),
  undefined,
  null,
  false,
  0,
  '',
]) {
  test(`actual restart retains initial-load rejection (${String(primary)}) without installing fixtures or reloading`, async () => {
    const h = restartReadiness();
    const result = h.run();
    await h.waiting;
    h.rejectLoad(primary);
    await result;
    assert.deepEqual(h.calls, ['load']);
    assert.equal(h.fixture.cleanup().primary, primary);
    assert.equal(h.fixture.cleanup().primaryFailed, true);
    assert.equal(h.fixture.records.at(-1).status, 'primary');
    assert.equal(h.fixture.records.at(-1).stage, 'restart:initial-load');
    assert.equal(typeof h.fixture.cleanup().close, 'function');
  });
}
