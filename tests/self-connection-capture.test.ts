import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { validateWorkspace } from '../src/shared/workspace-validation';
import { execute, findNode, sourceFile } from './source-probe';

const source = readFileSync(
  new URL('../tools/smoke-pickers.mjs', import.meta.url),
  'utf8',
);
const prefix = 'Self-connection workspace capture: ';
const tab = (rootKey: string) => ({
  id: rootKey.toLowerCase(),
  connectionId: 'demo',
  rootKey,
});
const workspace = (keys: string[]) => ({
  activeTabId: keys[0]?.toLowerCase(),
  tabs: keys.map(tab),
  privatePayload: 'PRIVATE_WORKSPACE_PAYLOAD',
});

async function capture(
  load: () => unknown,
  roots: string[],
  options: {
    writerFailure?: boolean;
    domFailure?: boolean;
    selected?: string;
  } = {},
) {
  let loads = 0;
  let evaluations = 0;
  let queries = 0;
  let writes = 0;
  let passed: unknown;
  const messages: string[] = [];
  const stop = new Error('stop before fixture installation');
  const audit = runInNewContext(
    source
      .replace("import { expect } from '@playwright/test';", '')
      .replaceAll('export async function', 'async function') +
      '\ncaptureSelfConnectionWorkspace;',
    {
      window: {
        canopy: {
          flushWorkspace: async () => {},
          loadWorkspace: () => {
            loads += 1;
            return load();
          },
        },
      },
      document: {
        querySelectorAll: (selector: string) => {
          queries += 1;
          assert.equal(selector, '[role="tab"]');
          if (options.domFailure) throw new Error('private DOM failure');
          return roots.map((rootKey, index) => ({
            querySelector: (selector: string) => {
              assert.equal(selector, '.tab-label b');
              return { textContent: rootKey };
            },
            getAttribute: (name: string) => {
              assert.equal(name, 'aria-selected');
              return options.selected ?? (index === 0 ? 'true' : 'false');
            },
          }));
        },
      },
      console: {
        log: (message: string) => {
          writes += 1;
          if (options.writerFailure) throw new Error('private writer failure');
          messages.push(message);
        },
      },
    },
  );
  let error: unknown;
  try {
    passed = await audit({
      evaluate: (callback: () => unknown) => {
        evaluations += 1;
        return callback();
      },
    });
    throw stop;
  } catch (caught) {
    error = caught;
  }
  assert.equal(loads, 1);
  assert.equal(evaluations, 1);
  return { passed, messages, error, stop, queries, writes };
}

test('self-connection capture exposes stale persisted roots beside current DOM', async () => {
  const saved = workspace(['CAN-100', 'CAN-106']);
  saved.activeTabId = saved.tabs[1].id;
  const result = await capture(() => saved, ['CAN-100']);
  assert.equal(result.error, result.stop);
  assert.equal(result.passed, saved);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(JSON.parse(result.messages[0].slice(prefix.length)), {
    activeTabId: 'can-106',
    tabCount: 2,
    tabs: [tab('CAN-100'), tab('CAN-106')],
    renderedTabCount: 1,
    renderedTabs: [{ rootKey: 'CAN-100', selected: 'true' }],
  });
  assert.ok(!result.messages[0].includes(saved.privatePayload));
});

test('self-connection capture samples DOM when the original load resolves', async () => {
  const saved = workspace(['CAN-100', 'CAN-200']);
  const roots = ['CAN-106'];
  const result = await capture(async () => {
    await Promise.resolve();
    roots.splice(0, 1, 'CAN-100', 'CAN-200');
    return saved;
  }, roots);
  assert.equal(result.error, result.stop);
  assert.equal(result.passed, saved);
  const observation = JSON.parse(result.messages[0].slice(prefix.length));
  assert.deepEqual(observation.tabs, saved.tabs);
  assert.deepEqual(observation.renderedTabs, [
    { rootKey: 'CAN-100', selected: 'true' },
    { rootKey: 'CAN-200', selected: 'false' },
  ]);
});

test('self-connection capture preserves synchronous and rejected primary loads', async () => {
  for (const primary of [
    new Error('original load failure'),
    undefined,
    null,
    false,
    0,
    '',
  ]) {
    for (const rejected of [false, true]) {
      const result = await capture(
        () => {
          if (rejected) return Promise.reject(primary);
          throw primary;
        },
        ['CAN-100'],
        { writerFailure: true, domFailure: true },
      );
      assert.equal(result.error, primary);
      assert.equal(result.queries, 0);
      assert.equal(result.writes, 0);
      assert.deepEqual(result.messages, []);
    }
  }
});

test('self-connection capture preserves falsy load results', async () => {
  for (const saved of [undefined, null, false, 0, '']) {
    const result = await capture(() => saved, ['CAN-100']);
    assert.equal(result.error, result.stop);
    assert.equal(result.passed, saved);
    assert.equal(result.messages.length, 1);
  }
});

test('self-connection diagnostic DOM and output failures preserve the capture', async () => {
  for (const options of [{ domFailure: true }, { writerFailure: true }]) {
    const saved = workspace(['CAN-100']);
    const result = await capture(() => saved, ['CAN-100'], options);
    assert.equal(result.error, result.stop);
    assert.equal(result.passed, saved);
    assert.deepEqual(result.messages, []);
    assert.equal(result.queries, 1);
    assert.equal(result.writes, options.writerFailure ? 1 : 0);
  }
});

test('self-connection capture caps samples, strings and recentOutput message size', async () => {
  for (const [key, expected] of [
    ['"\\\u0000'.repeat(1000), '"\\?'.repeat(10) + '"\\'],
    ['\ud800'.repeat(1000), '\ufffd'.repeat(32)],
    ['\udc00'.repeat(1000), '\ufffd'.repeat(32)],
    ['\ud800😀\udc00'.repeat(1000), '\ufffd😀\ufffd'.repeat(8)],
    ['😀'.repeat(1000), '😀'.repeat(16)],
    ['A'.repeat(31) + '😀', 'A'.repeat(31) + '\ufffd'],
    ['\\'.repeat(1000), '\\'.repeat(32)],
  ]) {
    const saved = workspace(Array(100).fill(key));
    saved.activeTabId = key;
    for (const item of saved.tabs) {
      item.id = key;
      item.connectionId = key;
    }
    // Reading beyond the sample would turn this observation into a failure.
    Object.defineProperty(saved.tabs, 4, {
      get: () => {
        throw new Error('sample limit exceeded');
      },
    });
    const result = await capture(() => saved, Array(100).fill(key), {
      selected: key,
    });
    assert.equal(result.error, result.stop);
    assert.equal(result.passed, saved);
    assert.equal(result.queries, 1);
    assert.equal(result.writes, 1);
    assert.equal(result.messages.length, 1);
    const message = result.messages[0];
    assert.ok(message.startsWith(prefix));
    assert.ok(message.length <= 1935);
    const body = message.slice(prefix.length);
    assert.ok(body.length <= 1900);
    const observation = JSON.parse(body);
    assert.equal(observation.tabCount, 100);
    assert.equal(observation.renderedTabCount, 100);
    assert.equal(observation.tabs.length, 4);
    assert.equal(observation.renderedTabs.length, 4);
    assert.equal(observation.activeTabId, expected);
    for (const item of [...observation.tabs, ...observation.renderedTabs]) {
      for (const value of Object.values(item)) {
        assert.equal(value, expected);
        assert.equal((value as string).length, 32);
      }
    }
    assert.ok(!message.includes('PRIVATE_WORKSPACE_PAYLOAD'));
  }
});

const auditSource = ts.createSourceFile(
  'smoke-pickers.mjs',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const restoration = findNode(
  auditSource,
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === 'restoreSelfConnectionWorkspace',
)
  .getText()
  .replace('export ', '');
const auditing = findNode(
  auditSource,
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === 'auditSelfConnections',
);
const auditTry = auditing.body!.statements.find(ts.isTryStatement)!;
const auditRestoration = auditTry
  .getText()
  .replace(auditTry.tryBlock.getText(), '{ await auditBody(); }');
const mainSource = sourceFile(new URL('../src/main/app.ts', import.meta.url));
const mainSave = findNode(
  mainSource,
  (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.name.getText() === 'saveWorkspace',
).initializer.getText();
const trust = findNode(
  mainSource,
  (node): node is ts.ArrowFunction =>
    ts.isArrowFunction(node) &&
    node.getText().includes('Untrusted application window.'),
).getText();

function restoreModel(options: Record<string, unknown> = {}) {
  const saved = {
    ...workspace(['CAN-100', 'CAN-106']),
    theme: 'system',
    shortcuts: {},
    sidebarCollapsed: false,
    tabs: ['CAN-100', 'CAN-106'].map((rootKey, index) => ({
      ...tab(rootKey),
      id: `captured-${index}`,
      summary: rootKey,
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    })),
  };
  saved.activeTabId = options.missingActive
    ? 'missing-active-tab'
    : saved.tabs[options.firstActive ? 0 : 1].id;
  const fixture = {
    ...saved,
    tabs: [{ ...saved.tabs[0], id: 'fixture' }],
    activeTabId: 'fixture',
  };
  const store = execute(
    `() => {
    let demoWorkspaceState = structuredClone(initial);
    return { save: ${mainSave}, load: () => structuredClone(demoWorkspaceState) };
  }`,
    { initial: fixture, demoMode: true, structuredClone, validateWorkspace },
  )();
  const html = fileURLToPath(new URL('window.html', import.meta.url));
  const contents = { mainFrame: { url: pathToFileURL(html).href } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const trusted = (handler: (...args: any[]) => unknown) =>
    execute(trust, {
      handler,
      window: { webContents: contents },
      html,
      pathToFileURL,
    });
  const originalSave = trusted((value: unknown) => {
    if ('saveFailure' in options) throw options.saveFailure;
    store.save(value);
  });
  const originals = new Map<string, (...args: any[]) => any>([
    ['canopy:saveWorkspace', originalSave],
    ['canopy:loadWorkspace', trusted(store.load)],
    ['canopy:connections', () => 'original connections'],
  ]);
  const handlers = new Map<string, (...args: any[]) => any>(
    [...originals].map(([key]) => [key, () => undefined]),
  );
  const owner: Record<string, any> = {
    canopySmoke: {
      remoteUpdate: async (key: string, patch: unknown) => {
        assert.equal(key, 'CAN-100');
        assert.deepEqual(patch, { assigneeId: 'alex' });
        if ('setupFailure' in options) throw options.setupFailure;
      },
    },
    selfConnectionAudit: { handlers: originals },
  };
  const ipcMain = {
    removeHandler: (key: string) => handlers.delete(key),
    handle: (key: string, handler: (...args: any[]) => any) => {
      assert(!handlers.has(key));
      handlers.set(key, handler);
    },
  };
  let evaluations = 0,
    reloads = 0,
    rendered = structuredClone(fixture);
  const window = {
    canopy: {
      saveWorkspace: (value: unknown) =>
        handlers.get('canopy:saveWorkspace')!(event, value),
      flushWorkspace: async () => {},
      loadWorkspace: () => handlers.get('canopy:loadWorkspace')!(event),
    },
  };
  const page = {
    evaluate: (callback: (...args: any[]) => unknown, value: unknown) =>
      execute(`(${callback})`, { window })(value),
    reload: async () => {
      reloads++;
      // A pending renderer save must still write the captured snapshot here.
      await window.canopy.saveWorkspace(fixture);
      if ('reloadFailure' in options) throw options.reloadFailure;
      rendered = await window.canopy.loadWorkspace();
      assert.deepEqual(
        rendered,
        saved,
        'Save guard must own persistence through reload',
      );
      if (options.wrongOrder) rendered.tabs.reverse();
      if (options.wrongId) rendered.tabs[0].id = 'foreign-tab';
      if (options.wrongRoot) rendered.tabs[0].rootKey = 'CAN-200';
      if (options.wrongCount) rendered.tabs.pop();
      if (options.wrongSelection) rendered.activeTabId = rendered.tabs[0].id;
      if (options.corruptPersistence) store.save(fixture);
    },
    getByRole: (role: string, args?: { name: string }) => ({
      role,
      name: args?.name,
      nth: (index: number) => ({ index }),
    }),
    locator: (selector: string) => {
      assert.equal(selector, '[role=tab] .tab-label b');
      return {};
    },
  };
  const expect = (value: any) => ({
    toHaveCount: async (count: number) =>
      assert.equal(rendered.tabs.length, count),
    toHaveText: async (roots: string[]) =>
      assert.deepEqual(
        rendered.tabs.map((t) => t.rootKey),
        roots,
      ),
    toHaveAttribute: async (key: string, expected: string) =>
      assert.equal(
        key === 'data-tab-id'
          ? rendered.tabs[value.index].id
          : String(
              options.bothSelected ||
                rendered.tabs[value.index].id === rendered.activeTabId,
            ),
        expected,
      ),
    toBeDefined: () => assert.notEqual(value, undefined),
    toBeVisible: async () => {
      const active = rendered.tabs.find((t) => t.id === rendered.activeTabId);
      assert.equal(value.role, 'tree');
      assert.equal(
        value.name,
        `${options.wrongTree ? 'CAN-100' : active?.rootKey} issue tree`,
      );
    },
    toEqual: (expected: unknown) => assert.deepEqual(value, expected),
  });
  const app = {
    evaluate: (callback: (...args: any[]) => unknown, value: unknown) => {
      evaluations++;
      if (evaluations === 3 && 'cleanupFailure' in options)
        throw options.cleanupFailure;
      return execute(`(${callback})`, { globalThis: owner })(
        { ipcMain },
        value,
      );
    },
  };
  const run = () =>
    execute(
      `async () => { ${restoration}; let failed = false; ${auditRestoration} }`,
      {
        app,
        page,
        workspace: saved,
        expect,
        auditBody: () => {
          if ('bodyFailure' in options) throw options.bodyFailure;
        },
      },
    )();
  return {
    run,
    saved,
    fixture,
    store,
    originals,
    handlers,
    originalSave,
    owner,
    event,
    get reloads() {
      return reloads;
    },
  };
}

for (const firstActive of [false, true])
  test(`restores the persisted snapshot with ${firstActive ? 'first' : 'non-first CAN-106'} active`, async () => {
    const m = restoreModel({ firstActive });
    await m.run();
    assert.deepEqual(m.store.load(), m.saved);
    assert.equal(m.handlers.get('canopy:saveWorkspace'), m.originalSave);
    for (const [key, handler] of m.originals)
      assert.equal(m.handlers.get(key), handler);
    assert.equal(m.owner.selfConnectionAudit, undefined);
    await m.originalSave(m.event, m.fixture);
    assert.deepEqual(m.store.load(), m.fixture);
    assert.throws(
      () => m.originalSave({ ...m.event, sender: {} }, m.saved),
      /Untrusted application window/,
    );
    assert.throws(
      () =>
        m.originalSave(
          { ...m.event, senderFrame: { ...m.event.senderFrame } },
          m.saved,
        ),
      /Untrusted application window/,
    );
  });

for (const option of [
  'missingActive',
  'wrongCount',
  'wrongOrder',
  'wrongId',
  'wrongRoot',
  'wrongSelection',
  'bothSelected',
  'wrongTree',
  'corruptPersistence',
])
  test(`restoration refuses ${option} and releases save ownership`, async () => {
    const m = restoreModel({ [option]: true });
    await assert.rejects(m.run(), { code: 'ERR_ASSERTION' });
    assert.equal(m.handlers.get('canopy:saveWorkspace'), m.originalSave);
    assert.equal(m.owner.selfConnectionAudit, undefined);
  });

for (const primary of [
  new Error('raw restoration failure'),
  undefined,
  null,
  false,
  0,
  '',
]) {
  for (const phase of ['saveFailure', 'reloadFailure', 'setupFailure'])
    test(`preserves raw ${phase} ${String(primary)} and restores handlers`, async () => {
      const m = restoreModel({ [phase]: primary });
      await assert.rejects(m.run(), (error) => error === primary);
      assert.equal(m.handlers.get('canopy:saveWorkspace'), m.originalSave);
      assert.equal(m.owner.selfConnectionAudit, undefined);
      assert.equal(m.reloads, phase === 'saveFailure' ? 0 : 1);
    });
  test(`primary audit failure ${String(primary)} survives restoration failure`, async () => {
    const m = restoreModel({
      bodyFailure: primary,
      reloadFailure: new Error('secondary restoration'),
    });
    await assert.rejects(m.run(), (error) => error === primary);
    assert.equal(m.handlers.get('canopy:saveWorkspace'), m.originalSave);
    assert.equal(m.owner.selfConnectionAudit, undefined);
  });
  test(`primary restoration failure ${String(primary)} survives cleanup failure`, async () => {
    const m = restoreModel({
      reloadFailure: primary,
      cleanupFailure: new Error('secondary cleanup'),
    });
    await assert.rejects(m.run(), (error) => error === primary);
  });
}

test('cleanup failure refuses an otherwise successful restoration', async () => {
  const cleanupFailure = new Error('cleanup failed');
  const m = restoreModel({ cleanupFailure });
  await assert.rejects(m.run(), (error) => error === cleanupFailure);
});

const renderer = readFileSync(
  new URL('../src/renderer/App.tsx', import.meta.url),
  'utf8',
);
const saveStart = renderer.indexOf(
  '    (value: Workspace, transferFlush = false) => {',
);
const saveEnd = renderer.indexOf('\n    [],', saveStart);
const flushStart =
  renderer.indexOf('window.canopy.onWorkspaceFlush(') +
  'window.canopy.onWorkspaceFlush('.length;
const flushEnd = renderer.indexOf('\n    });', flushStart) + '\n    }'.length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lifecycle(
  options: {
    flushFailure?: unknown;
    failFlush?: boolean;
    failFlushAt?: number;
    completeAudit?: boolean;
    lateReloadSave?: boolean;
    saveFailure?: boolean;
    reloadFailure?: boolean;
    remoteFailure?: boolean;
    assertionFailure?: boolean;
    installFailure?: boolean;
    auditFailure?: unknown;
  } = {},
) {
  const saved = {
    ...workspace(['CAN-100', 'CAN-106']),
    activeTabId: 'can-106',
    tabs: [
      { ...tab('CAN-100'), view: { filters: { assignee: 'alex' } } },
      { ...tab('CAN-106'), view: { hideDone: true, scrollTop: 124 } },
    ],
    rootViews: { second: { hideDone: true, scrollTop: 124 } },
  };
  let persisted: unknown = workspace(['CAN-100']);
  let rendered = saved;
  let gate: ReturnType<typeof deferred> | undefined;
  let hydrated:
    | {
        held: ReturnType<typeof deferred>;
        started: ReturnType<typeof deferred>;
      }
    | undefined;
  let reloads = 0;
  let flushes = 0;
  let resets = 0;
  let timerCancelled = false;
  const failure = new Error('cleanup failure');
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const originalSave = (_event: unknown, value: unknown) => {
    if (options.saveFailure) throw failure;
    persisted = structuredClone(value);
  };
  handlers.set('canopy:saveWorkspace', originalSave);
  handlers.set('canopy:loadWorkspace', () => structuredClone(persisted));
  for (const channel of [
    'connections',
    'connect',
    'currentUser',
    'tree',
    'cachedUsers',
    'assignees',
    'validateAssignee',
    'update',
  ]) {
    handlers.set(`canopy:${channel}`, () => {});
  }
  const originals = new Map(handlers);
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(`canopy:${name}`)!(null, ...args);
  const refs = {
    workspaceLoaded: { current: true },
    workspaceRef: { current: rendered },
    workspaceTransferBusy: { current: false },
    workspaceTransferCommitted: { current: false },
    workspaceSaveTimer: { current: 42 as number | null },
  };
  const context = {
    ...refs,
    demoResetting: { current: false },
    pendingWorkspaceSave: { current: Promise.resolve() },
    scrollPositions: { current: {} },
    withScrollPositions: (value: unknown) => value,
    setErrors: () => {},
    window: {
      clearTimeout: () => {
        timerCancelled = true;
      },
      canopy: {
        loadWorkspace: () => call('loadWorkspace'),
        saveWorkspace: async (value: unknown) => {
          const pending = gate;
          gate = undefined;
          if (pending === hydrated?.held) hydrated?.started.resolve();
          if (pending) await pending.promise;
          return call('saveWorkspace', value);
        },
        flushWorkspace: async () => {
          flushes += 1;
          if (options.failFlush || options.failFlushAt === flushes)
            throw options.flushFailure;
          await flush();
        },
      },
    },
    document: {
      querySelectorAll: () =>
        rendered.tabs.map((item) => ({
          querySelector: () => ({ textContent: item.rootKey }),
          getAttribute: () =>
            item.id === rendered.activeTabId ? 'true' : 'false',
        })),
    },
    console: { log: () => {} },
  };
  // Run the renderer's actual queue and flush callbacks against the IPC fixture.
  const save = runInNewContext(
    renderer
      .slice(saveStart, saveEnd)
      .trim()
      .replace(/,$/, '')
      .replace('(value: Workspace,', '(value,'),
    context,
  );
  const flush = runInNewContext(
    renderer
      .slice(flushStart, flushEnd)
      .replace('let saved: Workspace;', 'let saved;'),
    { ...context, saveWorkspace: save },
  );
  const main = {
    canopySmoke: {
      tree: () => ({
        issues: [
          { key: 'CAN-100', assignee: { id: 'alex', name: 'Alex Morgan' } },
        ],
      }),
      validateAssignee: () => ({}),
      update: () => ({}),
      remoteUpdate: () => {
        resets += 1;
        if (options.remoteFailure) throw failure;
      },
    },
  };
  let installFailure = options.installFailure;
  const ipcMain = {
    _invokeHandlers: handlers,
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
      if (installFailure && channel === 'canopy:currentUser') {
        installFailure = false;
        throw options.auditFailure;
      }
    },
  };
  const functions = runInNewContext(
    source
      .replace("import { expect } from '@playwright/test';", '')
      .replaceAll('export async function', 'async function') +
      '\nexpect.poll = callback => ({toBe: async value => { if (await callback() !== value) throw Error(\"poll mismatch\"); }});\n({captureSelfConnectionWorkspace, restoreSelfConnectionWorkspace, auditSelfConnections});',
    {
      expect: (locator: { role: string; name?: string; index?: number }) => ({
        toBeDefined: () => assert.notEqual(locator, undefined),
        toHaveText: async (roots: string[]) =>
          assert.deepEqual(
            rendered.tabs.map((item) => item.rootKey),
            Array.from(roots),
          ),
        toHaveAttribute: async (key: string, value: string) =>
          assert.equal(
            key === 'data-tab-id'
              ? rendered.tabs[locator.index!].id
              : String(
                  rendered.tabs[locator.index!].id === rendered.activeTabId,
                ),
            value,
          ),
        toHaveCount: async (count: number) => {
          assert.equal(rendered.tabs.length, count);
          if (options.assertionFailure) throw failure;
        },
        toBeDisabled: async () => {},
        toBeEnabled: async () => {},
        toBeHidden: async () => {},
        toContainText: async () => {},
        toEqual: (value: unknown) =>
          assert.deepEqual(
            JSON.parse(JSON.stringify(locator)),
            JSON.parse(JSON.stringify(value)),
          ),
        toBeVisible: async () => {
          const active = rendered.tabs.find(
            (item) => item.id === rendered.activeTabId,
          )!;
          assert.equal(locator.name, `${active.rootKey} issue tree`);
        },
      }),
    },
  );
  let connection = 'demo';
  const locator = (role: string, args?: { name?: string }): any => ({
    role,
    ...args,
    fill: async () => {},
    press: async () => {},
    nth: (index: number) => ({
      index,
      click: () => {
        connection = index ? 'other' : 'demo';
      },
    }),
    click: () => {
      if (!options.completeAudit) throw options.auditFailure;
      if (args?.name === 'Verify and save Jira') {
        call('connect');
        void call('currentUser', 'demo');
      }
      if (args?.name === 'Assign to me') {
        const account = connection === 'other' ? 'sam' : 'jordan';
        call('validateAssignee', connection, 'CAN-100', account, true);
        call('update', connection, 'CAN-100', { assigneeId: account });
      }
    },
  });
  const page = {
    getByLabel: (name: string) => locator('label', { name }),
    getByPlaceholder: (name: string) => locator('placeholder', { name }),
    evaluate: (callback: (...args: any[]) => unknown, value?: unknown) =>
      runInNewContext(`(${callback.toString()})(value)`, { ...context, value }),
    reload: async () => {
      reloads += 1;
      if (options.reloadFailure) throw failure;
      // An old renderer write during navigation must not overwrite the capture.
      if (options.lateReloadSave !== false)
        await context.window.canopy.saveWorkspace(workspace(['FIXTURE']));
      rendered = call('loadWorkspace') as typeof saved;
      refs.workspaceRef.current = rendered;
      if (hydrated) gate = hydrated.held;
    },
    getByRole: locator,
    locator: () => ({}),
  };
  const mainContext = createContext({ ...main, ipcMain });
  const app = {
    evaluate: (callback: (...args: any[]) => unknown, value?: unknown) => {
      mainContext.value = value;
      return runInContext(
        `(${callback.toString()})({ipcMain}, value)`,
        mainContext,
      );
    },
  };
  return {
    saved,
    render: (value: typeof saved) => {
      rendered = value;
      refs.workspaceRef.current = value;
    },
    holdReloadSave: () => {
      hydrated = { held: deferred(), started: deferred() };
      return hydrated;
    },
    page,
    app,
    functions,
    handlers,
    originals,
    failure,
    persisted: () => persisted,
    rendered: () => rendered,
    stats: () => ({ reloads, flushes, resets, timerCancelled }),
    fixture: () => {
      mainContext.selfConnectionAudit = { handlers: new Map(originals) };
      handlers.set('canopy:saveWorkspace', () => {});
      rendered = { ...saved, ...workspace(['FIXTURE']) } as typeof saved;
      refs.workspaceRef.current = rendered;
    },
    hold: () => {
      gate = deferred();
      return gate;
    },
    save,
    auditPresent: () => Boolean(mainContext.selfConnectionAudit),
  };
}

test('settled capture waits for queued writes and preserves current active root and view state', async () => {
  const h = lifecycle();
  h.originals.get('canopy:saveWorkspace')!(null, h.saved);
  const current = {
    ...h.saved,
    activeTabId: 'can-100',
    tabs: h.saved.tabs.slice(0, 1),
  };
  h.render(current);
  const held = h.hold();
  const oldSave = h.save(h.saved);
  await Promise.resolve();
  let finished = false;
  const capturing = h.functions
    .captureSelfConnectionWorkspace(h.page)
    .then((value: unknown) => {
      finished = true;
      return value;
    });
  await Promise.resolve();
  assert.equal(finished, false);
  held.resolve();
  await oldSave;
  assert.deepEqual(await capturing, current);
  assert.deepEqual(h.persisted(), current);
  assert.equal(h.stats().timerCancelled, true);
});

test('restoration drains pending fixture saves and protects the complete workspace during reload', async () => {
  const h = lifecycle();
  h.fixture();
  const fixtureSave = h.handlers.get('canopy:saveWorkspace');
  const hydrated = h.holdReloadSave();
  const held = h.hold();
  const pending = h.save(workspace(['FIXTURE']));
  await Promise.resolve();
  const restoring = h.functions.restoreSelfConnectionWorkspace(
    h.app,
    h.page,
    h.saved,
  );
  await Promise.resolve();
  assert.equal(h.handlers.get('canopy:saveWorkspace'), fixtureSave);
  assert.equal(h.stats().reloads, 0);
  held.resolve();
  await pending;
  await hydrated.started.promise;
  assert.notEqual(
    h.handlers.get('canopy:saveWorkspace'),
    h.originals.get('canopy:saveWorkspace'),
  );
  assert.equal(h.auditPresent(), true);
  hydrated.held.resolve();
  await restoring;
  assert.deepEqual(h.persisted(), h.saved);
  assert.deepEqual(h.rendered(), h.saved);
  assert.equal(h.stats().flushes, 2);
  assert.equal(h.stats().resets, 1);
  assert.deepEqual(h.handlers, h.originals);
  assert.equal(h.auditPresent(), false);
});

test('capture refuses a failed flush without loading or installing the fixture', async () => {
  for (const primary of [
    new Error('flush failed'),
    undefined,
    null,
    false,
    0,
    '',
  ]) {
    const h = lifecycle({ failFlush: true, flushFailure: primary });
    let rejected = false;
    try {
      await h.functions.auditSelfConnections(h.app, h.page);
    } catch (error) {
      rejected = true;
      assert.equal(error, primary);
    }
    assert.equal(rejected, true);
    assert.deepEqual(h.handlers, h.originals);
    assert.equal(h.stats().reloads, 0);
    assert.equal(h.auditPresent(), false);
  }
});

test('restoration releases every handler after flush, save, reload, assertion or fixture-reset failures', async () => {
  for (const options of [
    { failFlush: true, flushFailure: null },
    { failFlushAt: 1, flushFailure: null },
    { failFlushAt: 1, flushFailure: null, remoteFailure: true },
    { failFlushAt: 2, flushFailure: null },
    { saveFailure: true },
    { reloadFailure: true },
    { assertionFailure: true },
    { remoteFailure: true },
  ]) {
    const h = lifecycle(options);
    h.fixture();
    let rejected = false;
    try {
      await h.functions.restoreSelfConnectionWorkspace(h.app, h.page, h.saved);
    } catch (error) {
      rejected = true;
      assert.equal(
        error,
        options.failFlush || options.failFlushAt ? null : h.failure,
      );
    }
    assert.equal(rejected, true);
    assert.deepEqual(h.handlers, h.originals);
    assert.equal(h.auditPresent(), false);
    if (options.failFlush || options.remoteFailure) {
      assert.deepEqual(h.persisted(), h.saved);
      assert.deepEqual(h.rendered(), h.saved);
    }
  }
});

test('audit preserves raw assertion and partial-installation failures across failed cleanup', async () => {
  for (const primary of [
    new Error('audit failed'),
    undefined,
    null,
    false,
    0,
    '',
  ]) {
    for (const installFailure of [false, true]) {
      const h = lifecycle({
        auditFailure: primary,
        installFailure,
        remoteFailure: true,
      });
      let rejected = false;
      try {
        await h.functions.auditSelfConnections(h.app, h.page);
      } catch (error) {
        rejected = true;
        assert.equal(error, primary);
      }
      assert.equal(rejected, true);
      assert.deepEqual(h.handlers, h.originals);
      assert.equal(h.auditPresent(), false);
    }
  }
});

test('a completed audit reports restoration failure and restores the original handlers', async () => {
  const h = lifecycle({ completeAudit: true, remoteFailure: true });
  await assert.rejects(
    h.functions.auditSelfConnections(h.app, h.page),
    (error: unknown) => error === h.failure,
  );
  assert.deepEqual(h.handlers, h.originals);
  assert.equal(h.auditPresent(), false);
});

test('restoration explicitly persists the capture when navigation has no late renderer save', async () => {
  const h = lifecycle({ lateReloadSave: false });
  h.fixture();
  await h.functions.restoreSelfConnectionWorkspace(h.app, h.page, h.saved);
  assert.deepEqual(h.persisted(), h.saved);
  assert.deepEqual(h.rendered(), h.saved);
  assert.deepEqual(h.handlers, h.originals);
});

test('a completed audit restores the full workspace and returns successfully', async () => {
  const h = lifecycle({ completeAudit: true });
  await h.functions.auditSelfConnections(h.app, h.page);
  assert.deepEqual(h.persisted(), h.saved);
  assert.deepEqual(h.rendered(), h.saved);
  assert.deepEqual(h.handlers, h.originals);
  assert.equal(h.auditPresent(), false);
});

test('restoration also completes when fixture installation never created handler state', async () => {
  const h = lifecycle({ lateReloadSave: false });
  await h.functions.restoreSelfConnectionWorkspace(h.app, h.page, h.saved);
  assert.deepEqual(h.persisted(), h.saved);
  assert.deepEqual(h.rendered(), h.saved);
  assert.deepEqual(h.handlers, h.originals);
  assert.equal(h.auditPresent(), false);
});
