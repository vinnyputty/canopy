import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaration, execute, sourceFile } from './source-probe';

const source = sourceFile(new URL('../tools/demo-check.mjs', import.meta.url));

test('demo failure snapshot includes reset context, actual tree state and workspace evidence', async () => {
  const beforeReset = JSON.stringify({
    tree: [{ key: 'CAN-100', expanded: 'true' }],
  });
  const workspace = { tabs: [{ rootKey: 'CAN-100', expanded: ['CAN-100'] }] };
  const read = execute(declaration(source, 'demoFailureState').getText(), {
    sessionStorage: {
      getItem: (key: string) =>
        key === 'canopy-check-before-reset' ? beforeReset : 'editor',
    },
    performance: {
      getEntriesByType: () => [{ startTime: 0, duration: 120, type: 'reload' }],
    },
    globalThis: {
      canopyDemoCheckTrace: [
        { event: 'render', rootAction: 'Collapse CAN-100' },
      ],
    },
    window: { canopy: { loadWorkspace: async () => workspace } },
    document: {
      readyState: 'complete',
      activeElement: { getAttribute: () => 'Reset and replay' },
      querySelector: () => ({
        textContent: 'The tour stopped: Expand CAN-100 did not appear.',
      }),
      querySelectorAll: () => [
        {
          getAttribute: (key: string) =>
            key === 'data-tree-key' ? 'CAN-100' : 'true',
        },
      ],
    },
  });
  const state = await read();
  assert.equal(state.beforeReset, beforeReset);
  assert.deepEqual(state.tree, [{ key: 'CAN-100', expanded: 'true' }]);
  assert.deepEqual(state.workspace, workspace);
  assert.equal(state.trace[0].rootAction, 'Collapse CAN-100');
  assert.match(state.tour, /Expand CAN-100 did not appear/);
  assert.equal(state.navigation[0].type, 'reload');
});

test('demo hold records failed tour state and pauses synchronously when its target appears', () => {
  const storage = new Map([['canopy-check-hold', 'editor']]);
  let observe!: () => void;
  let disconnected = false;
  let ready = false;
  let paused = false;
  const global: { canopyDemoCheckTrace?: any[] } = {};
  const install = execute(declaration(source, 'installDemoHold').getText(), {
    globalThis: global,
    performance: { now: () => 100 },
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
        selector.includes('priority-editor')
          ? ready
            ? {}
            : null
          : selector.includes('role="status"')
            ? {
                textContent: 'The tour stopped: Expand CAN-100 did not appear.',
              }
            : { getAttribute: () => 'Collapse CAN-100' },
      querySelectorAll: () => [
        {
          textContent: 'Pause demo',
          click: () => {
            paused = true;
          },
        },
      ],
    },
  });
  install();
  observe();
  assert.equal(paused, false);
  assert.equal(storage.get('canopy-check-hold'), 'editor');
  assert.equal(
    global.canopyDemoCheckTrace![1].caption,
    'The tour stopped: Expand CAN-100 did not appear.',
  );
  ready = true;
  observe();
  assert.equal(
    paused,
    true,
    'pause occurs in the render callback, before any presentation timer',
  );
  assert.equal(disconnected, true);
  assert.equal(storage.has('canopy-check-hold'), false);
  assert.equal(global.canopyDemoCheckTrace!.at(-1).event, 'pause-click');
});

for (const fault of ['none', 'reject', 'hang']) {
  test(`demo diagnostics ${fault} preserve the original Resume assertion`, async () => {
    const primary = new Error('original Resume assertion');
    const logs: unknown[][] = [];
    const report = execute(declaration(source, 'reportDemoFailure').getText(), {
      demoFailureState: () => {},
      setTimeout,
      clearTimeout,
      console: { error: (...args: unknown[]) => logs.push(args) },
    });
    const state = {
      tour: 'The tour stopped: Expand CAN-100 did not appear.',
      hold: 'editor',
      workspace: { tabs: [{ expanded: ['CAN-100'] }] },
    };
    const reset = execute(declaration(source, 'resetAndHold').getText(), {
      expect: () => ({
        toBeVisible: async () => {
          throw primary;
        },
      }),
      reportDemoFailure: report,
      timingWindow: () => {
        throw new Error('Hold must not continue after failure');
      },
    });
    let evaluations = 0;
    const page = {
      evaluate: async () => {
        if (++evaluations === 1) return;
        if (fault === 'hang') return new Promise(() => {});
        if (fault === 'reject') throw new Error('page closed');
        return state;
      },
      getByRole: () => ({ click: async () => {} }),
    };
    const start = Date.now();
    await assert.rejects(reset(page, 'editor'), (error) => error === primary);
    assert.ok(Date.now() - start < 4000, 'diagnostic must be bounded');
    assert.equal(logs.length, 1);
    if (fault === 'none') {
      const evidence = JSON.parse(logs[0][1] as string);
      assert.equal(evidence.target, 'editor');
      assert.deepEqual(evidence.state, state);
    } else
      assert.match(
        String(logs[0][1]),
        fault === 'hang' ? /timed out/ : /page closed/,
      );
  });
}
