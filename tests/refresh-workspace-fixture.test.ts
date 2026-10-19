import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withScrollPositions } from '../src/renderer/scroll-position';
import { validateWorkspace } from '../src/shared/workspace-validation';
import {
  callback,
  declaration,
  execute,
  findNode,
  sourceFile,
} from './source-probe';

const renderer = sourceFile('src/renderer/App.tsx');
const smoke = sourceFile('tools/smoke-refresh.mjs');
const install = declaration(smoke, 'installDuplicateRefreshWorkspace')
  .getText()
  .replace('export ', '');
const main = sourceFile('src/main/app.ts');
const mainSave = findNode(
  main,
  (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.name.getText() === 'saveWorkspace',
).initializer.getText();
const trust = findNode(
  main,
  (node): node is ts.ArrowFunction =>
    ts.isArrowFunction(node) &&
    node.getText().includes('Untrusted application window.'),
).getText();
const effect = findNode(
  renderer,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.getText().includes('Couldn’t save workspace:'),
).arguments[0].getText();

async function model(options: Record<string, unknown> = {}) {
  const tabs = ['CAN-100', 'CAN-200', 'CAN-101'].map((rootKey) => ({
    id: rootKey,
    rootKey,
    connectionId: 'demo',
    summary: rootKey,
    expanded: [],
    hideDone: false,
    scrollTop: 0,
  }));
  const old = {
    tabs,
    closedTabs: [],
    activeTabId: 'CAN-200',
    theme: 'system',
    shortcuts: {},
    sidebarCollapsed: false,
  };
  const store = execute(
    `() => {
    let demoWorkspaceState = structuredClone(initial);
    return { save: ${mainSave}, load: () => demoWorkspaceState };
  }`,
    { initial: old, demoMode: true, structuredClone, validateWorkspace },
  )();
  const state = {
    get demoWorkspaceState(): typeof old {
      return store.load();
    },
    set demoWorkspaceState(value) {
      store.save(value);
    },
  };
  const webContents = { mainFrame: { url: 'file:///window.html' } };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const trusted = (handler: (...args: any[]) => any) =>
    execute(trust, {
      handler,
      window: { webContents },
      html: '/window.html',
      pathToFileURL,
    });
  const save = trusted(store.save);
  const load = trusted(() => structuredClone(state.demoWorkspaceState));
  const handlers = new Map<string, (...args: any[]) => any>([
    [
      'canopy:saveWorkspace',
      (event, value) => {
        if ('saveFailure' in options) throw options.saveFailure;
        return save(event, value);
      },
    ],
    [
      'canopy:loadWorkspace',
      (event) => {
        if ('loadFailure' in options) throw options.loadFailure;
        return load(event);
      },
    ],
  ]);
  const original = handlers.get('canopy:saveWorkspace');
  const owner: Record<string, unknown> = options.occupied
    ? { refreshWorkspaceFixture: {} }
    : {};
  if (!options.noDemo) owner.canopySmoke = {};
  if (options.missingHandler) handlers.delete('canopy:saveWorkspace');
  if (options.missingLoad) handlers.delete('canopy:loadWorkspace');
  if (options.noRoot)
    state.demoWorkspaceState = {
      ...old,
      tabs: [old.tabs[1]],
      activeTabId: old.tabs[1].id,
    };
  if (options.wrongConnection)
    state.demoWorkspaceState = {
      ...old,
      tabs: old.tabs.map((tab) => ({ ...tab, connectionId: 'other' })),
    };
  const ipcMain = {
    _invokeHandlers: handlers,
    removeHandler: (key: string) => handlers.delete(key),
    handle: (key: string, fn: (...args: any[]) => any) => {
      assert(!handlers.has(key));
      handlers.set(key, fn);
    },
  };
  let evaluations = 0,
    reloads = 0,
    timer!: () => void,
    release!: () => void;
  const pending = {
    current: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const window = {
    canopy: {
      saveWorkspace: (value: unknown) =>
        handlers.get('canopy:saveWorkspace')!(event, value),
      loadWorkspace: () => handlers.get('canopy:loadWorkspace')!(event),
    },
    setTimeout: (fn: () => void) => {
      timer = fn;
      return 1;
    },
    clearTimeout: () => {},
  };
  const context = {
    window,
    useCallback: (fn: unknown) => fn,
    demoResetting: { current: false },
    workspaceTransferBusy: { current: false },
    pendingWorkspaceSave: pending,
    scrollPositions: { current: new Map() },
    withScrollPositions,
  };
  const saveWorkspace = execute(callback(renderer, 'saveWorkspace'), context);
  execute(effect, {
    ...context,
    saveWorkspace,
    workspace: old,
    ready: true,
    workspaceLoaded: { current: true },
    workspaceSaveTimer: { current: null },
    setErrors: () => {
      if (!options.missingHandler && !('saveFailure' in options))
        assert.fail('Unexpected save error');
    },
  })();
  if (!options.timerDuringReload) timer();
  let rendered = old;
  const page = {
    reload: async () => {
      reloads++;
      if (options.timerDuringReload) timer();
      release();
      await pending.current;
      if ('reloadFailure' in options) throw options.reloadFailure;
      rendered = structuredClone(state.demoWorkspaceState);
      if (options.wrongTabs) rendered = old;
      if (options.wrongId) rendered.tabs[1].id = 'wrong-id';
      if (options.wrongLabels) rendered.tabs[1].rootKey = 'CAN-200';
      if (options.wrongActive) rendered.activeTabId = 'missing-active-tab';
      if (options.corruptPersistence) state.demoWorkspaceState = old;
    },
    evaluate: (fn: () => unknown) =>
      execute(`(${fn.toString()})`, { window })(),
    getByRole: () => ({ kind: 'tabs', nth: (index: number) => ({ index }) }),
    locator: () => ({ kind: 'labels' }),
  };
  const expect = (locator: any) => ({
    toHaveCount: async (count: number) =>
      assert.equal(rendered.tabs.length, count),
    toHaveText: async (labels: string[]) =>
      assert.deepEqual(
        rendered.tabs.map((t) => t.rootKey),
        labels,
      ),
    toHaveAttribute: async (key: string, value: string) =>
      assert.equal(
        key === 'data-tab-id'
          ? rendered.tabs[locator.index].id
          : String(
              options.bothSelected ||
                rendered.activeTabId === rendered.tabs[locator.index].id,
            ),
        value,
      ),
    toEqual: (value: unknown) => assert.deepEqual(locator, value),
  });
  const app = {
    evaluate: async (fn: (...args: any[]) => unknown) => {
      evaluations++;
      if (evaluations === 2 && 'cleanupFailure' in options)
        throw options.cleanupFailure;
      return execute(`(${fn.toString()})`, { globalThis: owner })({
        ipcMain,
        BrowserWindow: { getAllWindows: () => [{ webContents }] },
      });
    },
  };
  const run = (source = install) => execute(source, { expect })(app, page);
  return {
    run,
    state,
    old,
    handlers,
    original,
    owner,
    get reloads() {
      return reloads;
    },
    release,
    pending,
    window,
  };
}

test('actual capture/save/reload owns queued renderer writes and restores persistence', async () => {
  const m = await model();
  await m.run();
  assert.deepEqual(
    m.state.demoWorkspaceState.tabs.map((t) => [t.id, t.rootKey]),
    [
      ['CAN-100', 'CAN-100'],
      ['refresh-duplicate-CAN-100', 'CAN-100'],
    ],
  );
  assert.equal(m.state.demoWorkspaceState.activeTabId, 'CAN-100');
  assert.equal(m.handlers.get('canopy:saveWorkspace'), m.original);
  assert.equal(m.owner.refreshWorkspaceFixture, undefined);
  await m.window.canopy.saveWorkspace(m.old);
  assert.deepEqual(m.state.demoWorkspaceState, m.old);
});

test('actual debounce firing during reload cannot replace fixture tabs', async () => {
  const m = await model({ timerDuringReload: true });
  await m.run();
  assert.equal(m.state.demoWorkspaceState.tabs.length, 2);
  assert.equal(m.state.demoWorkspaceState.activeTabId, 'CAN-100');
  assert.equal(m.handlers.get('canopy:saveWorkspace'), m.original);
  assert.equal(m.owner.refreshWorkspaceFixture, undefined);
});

test('unprotected fixture is overwritten by the actual queued renderer saver', async () => {
  const m = await model();
  const first = m.old.tabs[0];
  await m.window.canopy.saveWorkspace({
    ...m.old,
    tabs: [first, { ...first, id: 'duplicate' }],
    activeTabId: first.id,
  });
  m.release();
  await m.pending.current;
  assert.deepEqual(m.state.demoWorkspaceState, m.old);
});

for (const failure of [new Error('raw primary'), undefined, 0]) {
  for (const phase of ['loadFailure', 'saveFailure', 'reloadFailure']) {
    test(`preserves ${phase} ${String(failure)} and restores handler`, async () => {
      const m = await model({ [phase]: failure });
      await assert.rejects(m.run(), (error) => error === failure);
      assert.equal(m.handlers.get('canopy:saveWorkspace'), m.original);
      assert.equal(m.owner.refreshWorkspaceFixture, undefined);
      assert.equal(m.reloads, phase === 'reloadFailure' ? 1 : 0);
      m.release();
      await m.pending.current.catch(() => {});
    });
  }
}
for (const option of [
  'noDemo',
  'missingHandler',
  'missingLoad',
  'noRoot',
  'wrongConnection',
  'occupied',
  'wrongTabs',
  'wrongLabels',
  'wrongId',
  'bothSelected',
  'wrongActive',
  'corruptPersistence',
]) {
  test(`refuses ${option}`, async () => {
    const m = await model({ [option]: true });
    const refusals: Record<string, RegExp> = {
      noDemo: /requires demo workspace handlers/,
      missingHandler: /requires demo workspace handlers/,
      missingLoad: /requires demo workspace handlers/,
      noRoot: /requires CAN-100/,
      wrongConnection: /requires CAN-100/,
      occupied: /already owns workspace saves/,
    };
    await assert.rejects(m.run(), refusals[option] ?? (() => true));
    if (option !== 'missingHandler')
      assert.equal(m.handlers.get('canopy:saveWorkspace'), m.original);
    if (option !== 'occupied')
      assert.equal(m.owner.refreshWorkspaceFixture, undefined);
    m.release();
    if (option !== 'missingHandler') await m.pending.current;
    else await m.pending.current.catch(() => {});
  });
}
test('cleanup failure preserves raw primary and otherwise fails the audit', async () => {
  const primary = new Error('primary');
  const cleanup = new Error('cleanup');
  for (const failed of [true, false]) {
    const m = await model({
      cleanupFailure: cleanup,
      ...(failed ? { reloadFailure: primary } : {}),
    });
    await assert.rejects(
      m.run(),
      (error) => error === (failed ? primary : cleanup),
    );
  }
});
