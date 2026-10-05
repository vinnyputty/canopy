import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function ast(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}
const driver = ast('../tools/perf-desktop.mjs');
const lifecycle = ast('../tools/audit-lifecycle.mjs');
function declaration(source: ts.SourceFile, name: string) {
  return source.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
}
let sampleTry: ts.TryStatement | undefined;
const locals: ts.Node[] = [];
function visit(n: ts.Node) {
  if (
    ts.isTryStatement(n) &&
    n.finallyBlock?.getText(driver).includes('finishAudit')
  )
    sampleTry = n;
  if (
    ts.isVariableStatement(n) &&
    n.declarationList.declarations.some((d) =>
      ['primary', 'sampleFailures'].includes(d.name.getText(driver)),
    )
  )
    locals.push(n);
  ts.forEachChild(n, visit);
}
visit(driver);
assert.ok(sampleTry?.catchClause);
const functions = ['deadline', 'finishAudit'].map((name) => {
  const n = declaration(lifecycle, name);
  assert.ok(n);
  return n.getText(lifecycle).replace('export ', '');
});
const persistFinal = declaration(driver, 'persistFinal');
const declarations = driver.statements.filter(
  (n) =>
    ts.isVariableStatement(n) &&
    n.declarationList.declarations.some((d) =>
      ['persist', 'failures'].includes(d.name.getText(driver)),
    ),
);
// Run actual driver catch/finally and actual final statements with source-only
// sample triggers. The real lifecycle functions run against a fake owned scope;
// no Electron, filesystem destination, process observer or GUI is imported.
const body = `
${functions.join('\n')}
${declarations.map((n) => n.getText(driver)).join('\n')}
${persistFinal?.getText(driver) ?? ''}
return {
  async sample(injectedPrimary, failed = true) {
    const sample = { memory: [], diagnostics: [] };
    report.samples.push(sample);
    ${locals.map((n) => n.getText(driver)).join('\n')}
    let app, page, timer = 'memory-interval';
    try {
      if (failed) throw injectedPrimary;
      sample.outcome = 'complete';
    } ${sampleTry.catchClause.getText(driver)}
    finally ${sampleTry.finallyBlock!.getText(driver)}
    return sample;
  },
  async finalize() {
    ${driver.statements
      .slice(-2)
      .map((n) => n.getText(driver))
      .join('\n')}
  }
};`;
const compiled = ts.transpileModule(`(function () {${body}})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const held = () => new Promise<void>(() => {});
type Fault = 'reject' | 'hold';
function fixture(faultAt: number, fault: Fault, terminated = true) {
  const secondary = new Error('SECONDARY evidence write failed');
  const cleanup = new Error('CLEANUP uncertain ownership');
  const report = { samples: [] as { outcome?: string }[] };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const budgets: number[] = [];
  const events: string[] = [];
  let writes = 0;
  const context = {
    Error,
    AggregateError,
    report,
    output: '/broken/evidence.json',
    writeFile: async () => {
      events.push(`write${++writes}`);
      if (writes === faultAt) {
        if (fault === 'hold') return held();
        throw secondary;
      }
    },
    memory: async () => {},
    owner: {
      profile: '/not-launched/sample',
      shutdown: async () => {
        events.push('shutdown');
        return { terminated, errors: terminated ? [] : [cleanup] };
      },
    },
    profile: '/not-launched/sample',
    rm: async () => {
      events.push('removeProfile');
    },
    clearInterval: () => events.push('clearInterval'),
    setTimeout: (callback: () => void, ms: number) => {
      budgets.push(ms);
      const timer = setTimeout(callback, Math.min(10, ms));
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
      timers.delete(timer);
    },
  };
  const api = vm.runInNewContext(compiled, context) as {
    sample(primary?: unknown, failed?: boolean): Promise<unknown>;
    finalize(): Promise<void>;
  };
  return { api, secondary, cleanup, report, events, timers, budgets };
}
// Keep the old unbounded final-write control itself finite. This watchdog is
// separate from the actual deadline timers tracked above.
async function failure(operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => 'unexpected success',
        (error: unknown) => error,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('unbounded write'), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function aggregate(error: unknown, primary: unknown) {
  assert.ok(error instanceof AggregateError);
  assert.ok(Object.is(error.errors[0], primary));
  assert.ok(Object.is(error.cause, primary));
  return error;
}
function cleared(state: ReturnType<typeof fixture>) {
  assert.equal(state.timers.size, 0);
  assert.ok(state.budgets.length > 0);
  assert.ok(state.budgets.every((ms) => ms === 3000));
}

for (const fault of ['reject', 'hold'] as const) {
  test(`actual driver preserves the primary when post-cleanup persistence ${fault}s`, async () => {
    const state = fixture(3, fault);
    const primary = new Error('PRIMARY renderer load failure');
    const result = aggregate(await failure(state.api.sample(primary)), primary);
    if (fault === 'reject') assert.equal(result.errors.at(-1), state.secondary);
    else assert.match(String(result.errors.at(-1)), /timed out after 3000ms/);
    assert.deepEqual(state.events, [
      'clearInterval',
      'write1',
      'shutdown',
      'removeProfile',
      'write2',
      'write3',
    ]);
    cleared(state);
  });
  test(`actual final write ${fault} after successful samples is finite and exposed`, async () => {
    const state = fixture(4, fault);
    await state.api.sample(undefined, false);
    const error = await failure(state.api.finalize());
    assert.ok(error instanceof AggregateError);
    aggregate(error, error.errors[0]);
    assert.equal(error.errors.length, 1);
    if (fault === 'reject') assert.equal(error.errors[0], state.secondary);
    else assert.match(String(error.errors[0]), /timed out after 3000ms/);
    assert.equal(state.report.samples[0].outcome, 'complete');
    cleared(state);
  });
  test(`actual final write ${fault} retains failures after a successful cleanup/report round`, async () => {
    const state = fixture(4, fault);
    const primary = new Error('PRIMARY assertion failure');
    await state.api.sample(primary);
    const error = aggregate(await failure(state.api.finalize()), primary);
    assert.equal(error.errors.length, 2);
    cleared(state);
  });
}

for (const primary of [undefined, null, false, 0, '', NaN]) {
  test(`actual driver keeps raw falsy primary ${String(primary)} through write failures`, async () => {
    // Exercise both an earlier write and the final post-cleanup write. Neither
    // nullish replacement nor the unchanged helper may erase raw thrown values.
    for (const faultAt of [1, 3]) {
      const state = fixture(faultAt, 'reject');
      const error = aggregate(
        await failure(
          state.api.sample(primary).then(() => state.api.finalize()),
        ),
        primary,
      );
      assert.equal(error.errors[1], state.secondary);
      assert.equal(state.report.samples[0].outcome, 'failed');
      cleared(state);
    }
  });
}

test('actual driver retains earlier sample failures when a later successful sample cannot persist', async () => {
  const state = fixture(6, 'reject');
  const primary = new Error('PRIMARY earlier sample');
  await state.api.sample(primary);
  const error = aggregate(
    await failure(state.api.sample(undefined, false)),
    primary,
  );
  assert.equal(error.errors.at(-1), state.secondary);
  cleared(state);
});

test('actual driver preserves cleanup faults and uncertain profile retention before final write failure', async () => {
  const state = fixture(3, 'reject', false);
  const primary = new Error('PRIMARY load failure');
  const error = aggregate(await failure(state.api.sample(primary)), primary);
  assert.equal(error.errors[1], state.cleanup);
  assert.match(String(error.errors[2]), /Profile retained/);
  assert.equal(error.errors.at(-1), state.secondary);
  assert.ok(!state.events.includes('removeProfile'));
  cleared(state);
});

test('actual driver exposes cleanup failure first when no primary sample failed', async () => {
  const state = fixture(3, 'reject', false);
  const error = aggregate(
    await failure(state.api.sample(undefined, false)),
    state.cleanup,
  );
  assert.match(String(error.errors[1]), /Profile retained/);
  assert.equal(error.errors.at(-1), state.secondary);
  assert.equal(state.report.samples[0].outcome, 'cleanup-failed');
  assert.ok(!state.events.includes('removeProfile'));
  cleared(state);
});

test('actual driver exposes recovered initial persistence failure even with a completed native sample', async () => {
  const state = fixture(1, 'reject');
  await state.api.sample(undefined, false);
  aggregate(await failure(state.api.finalize()), state.secondary);
  cleared(state);
});

test('actual driver accepts all successful writes and clears every deadline timer', async () => {
  const state = fixture(0, 'reject');
  await state.api.sample(undefined, false);
  await state.api.finalize();
  assert.equal(state.events.filter((e) => e.startsWith('write')).length, 4);
  cleared(state);
});

test('actual finalization exposes both errors on Node CLI when the report destination is broken', () => {
  const script = `${compiled.replace(/^\(/, 'const api = (')}
api.sample(new Error('PRIMARY renderer load failure')).then(() => api.finalize());`;
  const setup = `
const report = {samples:[]}, output = '/broken/report', profile = '/not-launched';
const owner = {shutdown: async () => ({terminated:true,errors:[]})};
const memory = async () => {}, rm = async () => {};
let writes = 0;
const writeFile = async () => {if (++writes === 3) throw new Error('SECONDARY evidence write failed');};
`;
  const result = spawnSync(process.execPath, ['-e', setup + script], {
    encoding: 'utf8',
    timeout: 1000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AggregateError: Evidence persistence failed/);
  assert.match(result.stderr, /PRIMARY renderer load failure/);
  assert.match(result.stderr, /SECONDARY evidence write failed/);
});
