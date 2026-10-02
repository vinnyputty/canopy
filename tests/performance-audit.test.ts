import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual audit preload around a transport-only IPC substitute.
// This imports no Electron runtime and never launches a desktop process.
function preload() {
  const source = readFileSync(
    new URL('fixtures/performance-preload.ts', import.meta.url),
    'utf8',
  );
  let api: {
    events: () => { events: Record<string, unknown>[]; active: number };
    arm: (roots: string[]) => number;
  };
  const deliveries: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const ipc = {
    invoke: async (..._args: unknown[]) =>
      new Promise((resolve, reject) => deliveries.push({ resolve, reject })),
    on: () => {},
  };
  const context = {
    performance,
    require: (name: string) =>
      name === 'electron'
        ? {
            ipcRenderer: ipc,
            contextBridge: {
              exposeInMainWorld: (_name: string, value: typeof api) => {
                api = value;
              },
            },
          }
        : {},
    exports: {},
    Set,
    Map,
    Error,
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    context,
  );
  return { api: api!, ipc, deliveries };
}

test('actual audit IPC assigns unique baseline request IDs and isolates a manual three-root generation from automatic polling', async () => {
  const state = preload(),
    roots = ['wide', 'tiered', 'deep'];
  const generation = state.api.arm(roots);
  const manual = roots.map((root) =>
    state.ipc.invoke('canopy:tree', 'fixture', root),
  );
  assert.throws(() => state.api.arm(roots), /idle IPC/);
  state.deliveries.forEach((delivery) =>
    delivery.resolve({ issues: [{}], incomplete: false }),
  );
  await Promise.all(manual);
  const poll = state.ipc.invoke('canopy:tree', 'fixture', 'wide');
  assert.equal(state.api.events().active, 1);
  state.deliveries.at(-1)!.resolve({ issues: [{}], incomplete: false });
  await poll;
  const delivered = state.api
    .events()
    .events.filter((e) => e.event === 'ipc-delivery');
  assert.equal(new Set(delivered.map((e) => e.requestId)).size, 4);
  assert.deepEqual(
    Array.from(delivered.slice(0, 3), (e) => e.manualGeneration),
    [generation, generation, generation],
  );
  assert.equal(delivered[3].manualGeneration, undefined);
  assert.equal(state.api.events().active, 0);
});

function completion(events: Record<string, unknown>[], generation: number) {
  const source = readFileSync(
    new URL('../tools/perf-desktop.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'driver.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let fn: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'complete')
      fn = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(fn);
  const renderer = async (
    callback: (args: unknown) => unknown,
    args: unknown,
  ) =>
    vm.runInNewContext(`(${callback.toString()})(args)`, {
      args,
      window: { canopyPerfAudit: { events: () => ({ events }) } },
    });
  const expect = {
    poll: (callback: () => Promise<unknown>) => ({
      toBe: async (value: unknown) => assert.equal(await callback(), value),
    }),
  };
  const complete = vm.runInNewContext(`(${fn.getText(ast)})`, {
    renderer,
    page: { evaluate: renderer },
    expect,
    LOAD_MS: 180000,
  });
  return complete([{ root: 'wide', issues: 1 }], 0, generation);
}

test('actual driver rejects an automatic full delivery as proof of an incomplete manual refresh', async () => {
  const state = preload(),
    generation = state.api.arm(['wide']);
  const manual = state.ipc.invoke('canopy:tree', 'fixture', 'wide', 'manual');
  state.deliveries[0].resolve({ issues: [{}], incomplete: true });
  await manual;
  const poll = state.ipc.invoke('canopy:tree', 'fixture', 'wide', 'automatic');
  state.deliveries[1].resolve({ issues: [{}], incomplete: false });
  await poll;
  await assert.rejects(completion(state.api.events().events, generation));
});

test('actual driver accepts the exact completed manual request even while the next automatic read remains active', async () => {
  const state = preload(),
    generation = state.api.arm(['wide']);
  const manual = state.ipc.invoke('canopy:tree', 'fixture', 'wide', 'manual');
  state.deliveries[0].resolve({ issues: [{}], incomplete: false });
  await manual;
  const next = state.ipc.invoke('canopy:tree', 'fixture', 'wide', 'next');
  assert.equal(state.api.events().active, 1);
  await completion(state.api.events().events, generation);
  state.deliveries[1].reject(new Error('Offline'));
  await assert.rejects(next, /Offline/);
});

test('reviewed lifecycle preserves the primary failure and retains an unverified launch profile with finite diagnostics', async () => {
  const { AuditOwner, deadline, finishAudit } = await import(
    new URL('../tools/audit-lifecycle.mjs', import.meta.url).href
  );
  const owner = new AuditOwner({
    profile: '/tmp/not-launched-canopy-90',
    executable: process.execPath,
  });
  owner.unknownLaunch = true;
  let removed = false,
    written = false;
  const primary = new Error('Renderer crashed');
  await assert.rejects(
    finishAudit({
      owner,
      primary,
      diagnostics: [
        { label: 'hung diagnostic', run: () => new Promise(() => {}) },
      ],
      operationMs: 10,
      removeProfile: async () => {
        removed = true;
      },
      writeEvidence: async () => {
        written = true;
      },
    }),
    (error: unknown) =>
      error instanceof AggregateError && error.errors[0] === primary,
  );
  assert.equal(removed, false);
  assert.equal(written, true);
  await assert.rejects(
    deadline(() => new Promise(() => {}), 10, 'test deadline'),
    /timed out/,
  );
});
