import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { declaration, execute, findNode, sourceFile } from './source-probe';

const source = sourceFile(
  process.env.CANOPY_DEMO_SOURCE ??
    new URL('../tools/demo-check.mjs', import.meta.url),
);
const installSource = declaration(source, 'installDemoHold').getText();

for (const timing of [
  'combined-render',
  'status-before-button',
  'button-before-status',
]) {
  test(`starting-tour observer closes the pause window: ${timing}`, () => {
    const storage = new Map([['canopy-check-hold', 'start']]);
    let observe!: () => void;
    let ready = false;
    let button = false;
    let step = 0;
    let paused = false;
    let disconnected = false;
    const context = {
      globalThis: {},
      performance: { now: () => 0 },
      sessionStorage: {
        getItem: (key: string) => storage.get(key),
        removeItem: (key: string) => storage.delete(key),
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          observe = callback;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
      document: {
        querySelector: (selector: string) =>
          selector === '.demo-tour-progress'
            ? ready
              ? { textContent: step === 0 ? 'Starting tour' : 'Step 1 of 7' }
              : null
            : null,
        querySelectorAll: () =>
          button
            ? [
                {
                  textContent: 'Pause demo',
                  click: () => {
                    paused = true;
                  },
                },
              ]
            : [],
      },
    };
    execute(installSource, context)();
    if (timing === 'status-before-button') {
      ready = true;
      observe();
      assert.equal(paused, false);
    }
    if (timing === 'button-before-status') {
      button = true;
      observe();
      assert.equal(paused, false);
    }
    ready = true;
    button = true;
    observe();
    // Simulate arbitrarily delayed harness assertions after the starting render.
    if (!paused) step++;
    assert.equal(
      step,
      0,
      'starting render must remain held before harness assertions',
    );
    assert.equal(paused, true);
    assert.equal(disconnected, true);
    assert.equal(storage.has('canopy-check-hold'), false);
  });
}

test('actual initial harness assertions start from held step zero under a slow UI action window', async () => {
  const block = findNode(
    source,
    (node): node is ts.TryStatement =>
      ts.isTryStatement(node) &&
      node.tryBlock.statements[0]?.getText().includes('const { page } = first'),
  );
  const end = block.tryBlock.statements.findIndex((statement) =>
    statement.getText().includes("getByText('Step 1 of 7 · Paused')"),
  );
  assert.ok(end > 0);
  const prefix = block.tryBlock.statements
    .slice(0, end + 1)
    .map((statement) => statement.getText())
    .join('\n');
  const storage = new Map<string, string>();
  let init: (() => void) | undefined;
  let observe: (() => void) | undefined;
  let step = 0;
  let paused = false;
  const document = {
    querySelector: (selector: string) =>
      selector === '.demo-tour-progress'
        ? { textContent: step === 0 ? 'Starting tour' : 'Step 1 of 7' }
        : null,
    querySelectorAll: (selector: string) =>
      selector === 'button'
        ? [
            {
              textContent: 'Pause demo',
              click: () => {
                paused = true;
              },
            },
          ]
        : [],
  };
  const browser = {
    document,
    globalThis: {},
    performance: { now: () => 100 },
    sessionStorage: {
      setItem: (key: string, value: string) => storage.set(key, value),
      getItem: (key: string) => storage.get(key),
      removeItem: (key: string) => storage.delete(key),
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        observe = callback;
      }
      observe() {}
      disconnect() {
        observe = undefined;
      }
    },
  };
  const install = execute(installSource, browser);
  const role = (name: string) => ({
    name,
    click: async () => {
      if (name === 'Reset and replay') {
        step = 0;
        paused = false;
        init?.();
        observe?.();
      }
      if (name === 'Pause demo') {
        // At test speed, earlier assertions/action scheduling can use the first
        // presentation window. The old manual Pause therefore stops step one.
        if (!paused) step = 1;
        paused = true;
      }
      if (name === 'Next demo step') step++;
    },
    evaluate: async (callback: (bar: { value: number }) => number) =>
      callback({ value: 0 }),
  });
  const page = {
    addInitScript: async (callback: () => void) => {
      init = callback;
    },
    evaluate: async (_callback: unknown, target?: string) => {
      if (target) storage.set('canopy-check-hold', target);
      else return 0.1;
    },
    getByRole: (_: string, options: { name: string }) => role(options.name),
    getByText: (text: string) => ({ text }),
    locator: () => ({}),
    waitForTimeout: async () => {},
  };
  const expect = (value: any) => ({
    toBe: (expected: unknown) => assert.equal(value, expected),
    toHaveText: async () => {},
    toHaveClass: async () => {},
    toBeVisible: async () => {
      if (value.text === 'Starting tour · Paused')
        assert.equal(paused && step === 0, true);
      if (value.text === 'Step 1 of 7 · Paused')
        assert.equal(
          paused && step === 1,
          true,
          `Next started from wrong held step; actual Step ${step}`,
        );
    },
  });
  const reset = execute(declaration(source, 'resetAndHold').getText(), {
    expect,
    reportDemoFailure: async () => {},
    timingWindow: () => 500,
  });
  await execute(`async function() { ${prefix} }`, {
    first: { page },
    expect,
    installDemoHold: install,
    resetAndHold: reset,
    timeScale: 0.1,
    timingWindow: () => 180,
  })();
  assert.equal(step, 1);
  assert.equal(paused, true);
});

for (const fault of ['none', 'reject', 'hang']) {
  test(`initial Next assertion diagnostics preserve primary failure: ${fault}`, async () => {
    const block = findNode(
      source,
      (node): node is ts.TryStatement =>
        ts.isTryStatement(node) &&
        node.tryBlock.statements[0]
          ?.getText()
          .includes('const { page } = first'),
    );
    assert.ok(block.catchClause, 'initial assertions need failure evidence');
    const primary = new Error('Step 1 expected, actual Step 2');
    const logs: unknown[][] = [];
    const page = {
      evaluate: async () => {
        if (fault === 'reject') throw new Error('diagnostic page closed');
        if (fault === 'hang') return new Promise(() => {});
        return { tour: 'Step 2 of 7 · Paused', trace: [] };
      },
    };
    const report = execute(declaration(source, 'reportDemoFailure').getText(), {
      demoFailureState: () => {},
      setTimeout,
      clearTimeout,
      console: { error: (...args: unknown[]) => logs.push(args) },
    });
    const handler = execute(
      `async function(error) ${block.catchClause.block.getText()}`,
      {
        first: { page },
        reportDemoFailure: report,
      },
    );
    const started = Date.now();
    await assert.rejects(handler(primary), (error) => error === primary);
    assert.ok(Date.now() - started < 4000);
    assert.equal(logs.length, 1);
    if (fault === 'none') {
      const record = JSON.parse(logs[0][1] as string);
      assert.equal(record.target, 'tour-assertion');
      assert.equal(record.state.tour, 'Step 2 of 7 · Paused');
    } else
      assert.match(
        String(logs[0][1]),
        fault === 'hang' ? /timed out/ : /page closed/,
      );
  });
}
