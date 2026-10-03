import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
