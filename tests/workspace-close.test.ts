import { Mutations } from '../src/renderer/mutations';
import { reconcileOwnEdit } from '../src/renderer/seen';
import { removeConnection } from '../src/renderer/workspace';
import {
  forgetSidebarConnections,
  emptySidebarSession,
} from '../src/renderer/sidebar-organization';
import {
  WorkspaceTransferReloadError,
  workspaceError,
} from '../src/renderer/workspace-error';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { sourceFile, findNode, execute, callback } from './source-probe';
import { migrateViews } from '../src/renderer/table-view';
import { starterViews } from '../src/renderer/saved-views';
import { DEFAULT_READING } from '../src/shared/views';
import {
  backupWorkspace,
  backupConnections,
} from './fixtures/workspace-backup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { WorkspaceBackupPanel } from '../src/renderer/WorkspaceBackupPanel';
import { IssuePreview } from '../src/renderer/IssuePreview';
import { App, WorkspaceLoadRecovery } from '../src/renderer/App';
import { gate, rendererFixture } from './fixtures/workspace-close';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = () =>
  new JSDOM(
    '<!doctype html><body><button id="edit">Edit</button><div id="host"></div></body>',
    { pretendToBeVisual: true, url: 'https://fixture.example' },
  );

test('close pause captures accepted edits and rejects DOM, keyboard, direct, menu and async mutations', async () => {
  const d = dom();
  const h = rendererFixture(d.window.document);
  d.window.document.body.inert = false;
  const focus = d.window.document.querySelector('button')!;
  focus.focus();
  h.setWorkspace((value: any) => ({ ...value, theme: 'light' }));
  await h.api.flushWorkspace(1);
  assert.equal(h.writes.at(-1)?.theme, 'light');
  assert.equal(h.controller.paused, true);
  assert.equal(d.window.document.body.inert, true);
  let input = 0;
  focus.addEventListener('click', () => input++);
  d.window.addEventListener('keydown', () => input++);
  focus.click();
  d.window.dispatchEvent(
    new d.window.KeyboardEvent('keydown', {
      key: 'x',
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(input, 0);
  const wheel = new d.window.Event('wheel', { cancelable: true });
  d.window.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true);
  focus.blur();
  h.setWorkspace((value: any) => ({ ...value, theme: 'dark' }));
  await Promise.resolve().then(() =>
    h.setWorkspace((value: any) => ({ ...value, theme: 'dark' })),
  );
  for (const name of [
    'organize',
    'updateTab',
    'navigate',
    'restoreScroll',
    'onKey',
  ])
    h.route(name)({ preventDefault() {} });
  assert.equal(h.workspaceRef.current.theme, 'light');
  const calls = h.calls.length;
  await assert.rejects(
    h.save({ ...h.workspaceRef.current, theme: 'dark' }),
    /closing/,
  );
  await assert.rejects(
    h.api.saveWorkspace({ ...h.workspaceRef.current, theme: 'dark' }),
    /closing/,
  );
  for (const name of [
    'applyWorkspaceImport',
    'rollbackWorkspaceImport',
    'reloadWorkspace',
    'resetDemo',
    'connect',
    'disconnect',
    'update',
    'author',
    'rank',
    'updatePreferences',
  ])
    await assert.rejects(() => (h.api as any)[name](), /closing/);
  assert.equal(h.calls.length, calls);
  h.release(1);
  assert.equal(d.window.document.body.inert, false);
  assert.equal(d.window.document.activeElement, focus);
  focus.click();
  d.window.dispatchEvent(new d.window.KeyboardEvent('keydown', { key: 'x' }));
  assert.equal(input, 2);
  await h.api.saveWorkspace(h.workspaceRef.current);
  await h.api.update('fixture', 'CAN-1', {});
  const resumedWheel = new d.window.Event('wheel', { cancelable: true });
  d.window.dispatchEvent(resumedWheel);
  assert.equal(resumedWheel.defaultPrevented, false);
  h.setWorkspace((value: any) => ({ ...value, theme: 'dark' }));
  await h.api.flushWorkspace(2);
  assert.equal(h.writes.at(-1)?.theme, 'dark');
  h.release(2);
  d.window.close();
});

test('only the owning attempt restores original inert state; released or older handshakes cannot pause', async () => {
  for (const inert of [true, false]) {
    const d = dom();
    d.window.document.body.inert = inert;
    const h = rendererFixture(d.window.document);
    await h.api.flushWorkspace(1);
    await h.api.flushWorkspace(2);
    assert.throws(
      () => h.controller.pause(1, d.window.document, () => {}),
      /canceled/,
    );
    await assert.rejects(h.api.flushWorkspace(1), /canceled/);
    await h.api.saveWorkspace(h.workspaceRef.current, 2);
    h.release(1);
    await assert.rejects(h.api.update('fixture', 'CAN-1', {}), /closing/);
    assert.equal(h.controller.owner, 2);
    assert.equal(d.window.document.body.inert, true);
    h.release(2);
    assert.equal(d.window.document.body.inert, inert);
    const writes = h.writes.length;
    assert.throws(
      () => h.controller.pause(1, d.window.document, () => {}),
      /canceled/,
    );
    await assert.rejects(h.api.flushWorkspace(1), /canceled/);
    await assert.rejects(
      h.api.saveWorkspace(h.workspaceRef.current, 1),
      /canceled/,
    );
    h.release(4);
    await assert.rejects(h.api.flushWorkspace(4), /canceled/);
    assert.equal(h.writes.length, writes);
    assert.equal(h.controller.paused, false);
    await h.api.flushWorkspace(5);
    h.release(4);
    assert.equal(h.controller.owner, 5);
    h.release(5);
    assert.equal(d.window.document.body.inert, inert);
    d.window.close();
  }
});

test('snapshot waits for accepted asynchronous appearance commit; failed work releases for retry', async () => {
  for (const fail of [false, true]) {
    const d = dom();
    d.window.document.body.inert = false;
    const saving = gate();
    let first = true;
    const h = rendererFixture(d.window.document, async () => {
      if (first) {
        first = false;
        await saving.promise;
      }
    });
    const appearance = h.saveAppearance('light', 'default');
    const appearanceResult = fail
      ? assert.rejects(appearance, /disk failure/)
      : appearance;
    await tick();
    const flushing = h.api.flushWorkspace(1);
    const result = fail ? assert.rejects(flushing, /disk failure/) : flushing;
    await tick();
    assert.equal(h.controller.paused, true);
    assert.equal(h.writes.length, 0);
    if (fail) saving.reject(new Error('disk failure'));
    else saving.release();
    await appearanceResult;
    await result;
    if (!fail) assert.equal(h.writes.at(-1)?.theme, 'light');
    else assert.match(h.errors().workspace, /disk failure/);
    h.release(1);
    assert.equal(d.window.document.body.inert, false);
    await h.api.flushWorkspace(2);
    assert.equal(h.writes.at(-1)?.theme, fail ? 'system' : 'light');
    h.release(2);
    d.window.close();
  }
});

test('canceling a queued snapshot prevents its later write and stale completion cannot disturb a retry', async () => {
  const d = dom();
  d.window.document.body.inert = false;
  const saving = gate();
  let first = true;
  const h = rendererFixture(d.window.document, async () => {
    if (first) {
      first = false;
      await saving.promise;
    }
  });
  const appearance = h.saveAppearance('light', 'default');
  await tick();
  const abandoned = assert.rejects(h.api.flushWorkspace(1), /canceled/);
  await tick();
  h.release(1);
  assert.equal(h.controller.paused, false);
  const current = h.api.flushWorkspace(2);
  await tick();
  assert.equal(h.controller.owner, 2);
  saving.release();
  await appearance;
  await abandoned;
  await current;
  assert.equal(
    h.writes.length,
    2,
    'one accepted appearance save and one current snapshot',
  );
  assert.equal(h.writes.at(-1)?.theme, 'light');
  assert.deepEqual(
    h.errors(),
    {},
    'abandoned completion must not replace current error feedback',
  );
  h.release(1);
  assert.equal(h.controller.owner, 2);
  h.release(2);
  assert.equal(d.window.document.body.inert, false);
  d.window.close();
});

async function recoveryFixture() {
  const d = dom();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const frames: (() => void)[] = [];
  let reloads = 0,
    fail = true;
  const saved = '{"tabs":[{"id":"kept"}]}';
  const files = new Map([['workspace.json', saved]]);
  for (const [name, value] of Object.entries({
    window: Object.assign(d.window, {
      canopy: {
        reloadWorkspace: async () => {
          reloads++;
          if (fail)
            throw Error(
              "Error invoking remote method 'canopy:reloadWorkspace': Error: Storage remains unavailable",
            );
        },
      },
    }),
    document: d.window.document,
    HTMLElement: d.window.HTMLElement,
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  d.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = createRoot(d.window.document.querySelector('#host')!);
  function Recovery() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(WorkspaceLoadRecovery, {
      error: 'Could not read saved workspace.',
      open,
      onOpenChange: setOpen,
    });
  }
  const render = () =>
    act(async () => root.render(React.createElement(Recovery)));
  await render();
  const button = (text: string, dialog = true) =>
    [
      ...(d.window.document as Document).querySelectorAll<HTMLButtonElement>(
        dialog ? '[role=dialog] button' : '[role=alert] button',
      ),
    ].find((n) => n.textContent === text)!;
  return {
    d,
    files,
    saved,
    render,
    root,
    button,
    reloads: () => reloads,
    succeed: () => {
      fail = false;
    },
    click: (text: string, dialog = true) =>
      act(async () => button(text, dialog).click()),
    close: async () => {
      await act(async () => root.unmount());
      for (const fn of frames) fn();
      d.window.close();
      for (const [name, desc] of previous)
        if (desc) Object.defineProperty(globalThis, name, desc);
        else Reflect.deleteProperty(globalThis, name);
    },
  };
}

test('failed-load recovery renders disclosure, supports Keep open/Escape, reports failed reload and retries explicitly', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const f = await recoveryFixture();
  try {
    const observations: Record<string, string> = {};
    const dialog = () => f.d.window.document.querySelector('[role=dialog]');
    assert.match(
      dialog()!.textContent!,
      /Changes made since workspace loading failed have not been saved\. Reloading will discard those changes\. Your saved workspace will be kept\./,
    );
    observations.initial = dialog()!.outerHTML;
    assert.ok(f.button('Keep open'));
    await f.click('Keep open');
    assert.equal(dialog(), null);
    assert.equal(f.reloads(), 0);
    await f.click('Reload workspace', false);
    await act(async () =>
      f.d.window.dispatchEvent(
        new f.d.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        }),
      ),
    );
    assert.equal(dialog(), null);
    assert.equal(f.reloads(), 0);
    await f.click('Reload workspace', false);
    await f.click('Reload workspace');
    assert.equal(f.reloads(), 1);
    observations.reloadFailure = dialog()!.outerHTML;
    assert.match(
      dialog()!.textContent!,
      /Couldn’t reload workspace: Storage remains unavailable/,
    );
    assert.equal(f.files.get('workspace.json'), f.saved);
    await f.click('Keep open');
    await f.click('Reload workspace', false);
    f.succeed();
    await f.click('Reload workspace');
    assert.equal(f.reloads(), 2);
    assert.equal(f.files.get('workspace.json'), f.saved);
    await tick();
    assert.equal(
      errors.mock.calls.filter((call) => /act\(/.test(call.arguments.join(' ')))
        .length,
      0,
      'Recovery interactions must finish their React act scope',
    );
    if (process.env.CANOPY_CLOSE_EVIDENCE_DIR)
      await writeFile(
        join(process.env.CANOPY_CLOSE_EVIDENCE_DIR, 'rendered-recovery.json'),
        JSON.stringify(observations, null, 2) + '\n',
      );
  } finally {
    await f.close();
  }
});

test('a close canceled while preload waits for readiness cannot pause after registration', async () => {
  const d = dom();
  d.window.document.body.inert = false;
  const h = rendererFixture(d.window.document, async () => {}, false);
  const canceled = assert.rejects(h.api.flushWorkspace(1), /canceled/);
  h.release(1);
  h.register();
  await canceled;
  assert.equal(h.controller.paused, false);
  assert.equal(d.window.document.body.inert, false);
  assert.equal(h.writes.length, 0);
  await h.api.flushWorkspace(2);
  assert.equal(h.controller.owner, 2);
  h.release(2);
  d.window.close();
});

test('initial read or hydration failure clears loaded authority, preserves existing state and succeeds after explicit reload', async () => {
  const ast = sourceFile('src/renderer/App.tsx');
  const effect = findNode(
    ast,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'useEffect' &&
      node.getText().includes('window.canopy.demoTimeScale()'),
  );
  for (const failure of [
    'read',
    'hydrate',
    'unmounted',
    'unmounted-read',
    'report-refused',
    'empty-error',
    'report-pending',
  ]) {
    const d = dom();
    const h = rendererFixture(d.window.document);
    const retained = {
      ...structuredClone(backupWorkspace),
      theme: 'dark' as const,
    };
    h.workspaceRef.current = retained;
    h.context.workspaceLoaded.current = true;
    const reading = gate();
    let reportHandlers = 0;
    let error: string | null = null,
      ready = false,
      hydrated = false;
    const context = {
      ...h.context,
      document: d.window.document,
      demoTimeScale: { current: 1 },
      setDialog() {},
      setWorkspaceLoadError: (value: string | null) => {
        error = value;
      },
      setReady: (value: boolean) => {
        ready = value;
      },
      setDemoMode() {},
      setConnections() {},
      setWorkspace: h.setWorkspace,
      setHandoffHydrated: (value: boolean) => {
        hydrated = value;
      },
      EMPTY_WORKSPACE: { ...retained, tabs: [] },
      PLATFORM_SHORTCUTS: {},
      DEFAULT_READING,
      starterViews,
      migrateViews: (value: any) => {
        if (failure === 'hydrate') throw Error('hydration failed');
        return migrateViews(value);
      },
      window: {
        canopy: {
          connections: async () => backupConnections,
          workspaceInitialized: () => {
            const reported =
              failure === 'report-pending'
                ? new Promise<void>(() => {})
                : failure === 'report-refused' || failure === 'empty-error'
                  ? Promise.reject(Error('report refused'))
                  : Promise.resolve();
            const catchReport = reported.catch.bind(reported);
            void catchReport(() => {});
            reported.catch = ((...args: Parameters<typeof catchReport>) => {
              reportHandlers++;
              return catchReport(...args);
            }) as typeof reported.catch;
            return reported;
          },
          loadWorkspace: async () => {
            await reading.promise;
            return structuredClone(backupWorkspace);
          },
          demoMode: async () => false,
          demoTimeScale: async () => 1,
        },
      },
    };
    const cleanup = execute(effect.arguments[0].getText(), context)();
    assert.equal(
      h.context.workspaceLoaded.current,
      false,
      'initialization immediately invalidates previous loaded authority',
    );
    await assert.rejects(h.save(retained), /not loaded/);
    if (failure.startsWith('unmounted')) cleanup();
    if (
      [
        'read',
        'unmounted-read',
        'report-refused',
        'empty-error',
        'report-pending',
      ].includes(failure)
    )
      reading.reject(Error(failure === 'empty-error' ? '' : 'read failed'));
    else reading.release();
    await tick();
    assert.equal(h.context.workspaceLoaded.current, false);
    assert.equal(h.workspaceRef.current, retained);
    assert.equal(h.writes.length, 0);
    if (failure.startsWith('unmounted')) {
      assert.equal(error, null);
      assert.equal(ready, false);
    } else {
      assert.match(
        error!,
        failure === 'empty-error' ? /The workspace could not load/ : /failed/,
      );
      assert.equal(ready, true);
    }
    assert.equal(hydrated, false);
    if (['report-refused', 'empty-error', 'report-pending'].includes(failure))
      assert.equal(
        reportHandlers,
        1,
        'load failure report has an effective rejection handler',
      );
    cleanup();
    const next = {
      ...context,
      migrateViews,
      window: {
        canopy: {
          ...context.window.canopy,
          workspaceInitialized: async () => {},
          loadWorkspace: async () => structuredClone(backupWorkspace),
        },
      },
    };
    const cleanupRetry = execute(effect.arguments[0].getText(), next)();
    await tick();
    assert.equal(error, null);
    assert.equal(h.context.workspaceLoaded.current, true);
    assert.equal(hydrated, true);
    await h.api.flushWorkspace();
    assert.ok(h.writes.length > 0);
    assert.equal(h.writes.at(-1)?.theme, backupWorkspace.theme);
    cleanupRetry();
    d.window.close();
  }
});

test('real React commits edits accepted before pause and keeps the final ref stable through unrelated renders', async () => {
  const f = await recoveryFixture();
  const saving = gate();
  let hold = false;
  const h = rendererFixture(
    f.d.window.document,
    async () => {
      if (hold) await saving.promise;
    },
    false,
  );
  h.setWorkspace({
    ...h.workspaceRef.current,
    seenRoots: {
      'sample-jira:SAMPLE-1': {
        touchedAt: 1,
        issues: { 'SAMPLE-1': { seenAt: 1, fields: { Summary: 'Before' } } },
      },
    },
  });
  let confirmedEdit!: (
    connection: string,
    issue: any,
    fields: string[],
  ) => void;
  const ast = sourceFile(
    process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
  );
  const registration = findNode(
    ast,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'window.canopy.onWorkspaceFlush',
  );
  const refGuard = findNode(
    ast,
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) &&
      ts.isExpressionStatement(node.thenStatement) &&
      ts.isBinaryExpression(node.thenStatement.expression) &&
      node.thenStatement.expression.left.getText() === 'workspaceRef.current',
  );
  let update!: (value: any) => void,
    redraw!: () => void,
    appearance!: (theme: string, palette: string) => Promise<void>;
  function Component() {
    const [workspace, storeWorkspace] = React.useState(h.workspaceRef.current);
    const [, setCounter] = React.useState(0);
    redraw = () => setCounter((value) => value + 1);
    const context = {
      ...h.context,
      storeWorkspace,
      flushSync,
      useCallback: React.useCallback,
    };
    execute(`() => {${refGuard.getText()}}`, { ...context, workspace })();
    const constructor = findNode(
      ast,
      (node): node is ts.NewExpression =>
        ts.isNewExpression(node) && node.expression.getText() === 'Mutations',
    );
    confirmedEdit = execute(constructor.arguments![3].getText(), {
      ...context,
      reconcileOwnEdit,
    });
    update = execute(callback(ast, 'setWorkspace'), context);
    const saveWorkspace = execute(callback(ast, 'saveWorkspace'), context);
    const panel = findNode(
      ast,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === 'AppearanceDialog',
    );
    const saveAttribute = panel.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onSave',
    ) as ts.JsxAttribute;
    appearance = execute(
      (saveAttribute.initializer as ts.JsxExpression).expression!.getText(),
      {
        ...context,
        saveWorkspace,
        setWorkspace: update,
        appearanceSaving: { current: false },
        setAppearancePreview() {},
        setDialog() {},
      },
    );

    React.useLayoutEffect(() => {
      h.api.onWorkspaceFlush(
        execute(registration.arguments[0].getText(), {
          ...context,
          saveWorkspace,
        }),
        execute(registration.arguments[1].getText(), context),
      );
    }, []);
    return React.createElement('span', null, workspace.theme);
  }
  try {
    await act(async () => f.root.render(React.createElement(Component)));
    await act(async () => {
      update((current: any) => ({ ...current, theme: 'light' }));
      await h.api.flushWorkspace(1);
    });
    assert.equal(h.writes.at(-1)?.theme, 'light');
    const final = h.workspaceRef.current;
    await act(async () => {
      update((current: any) => ({ ...current, theme: 'dark' }));
      redraw();
    });
    assert.equal(
      h.workspaceRef.current,
      final,
      'a non-workspace render cannot replace the paused snapshot',
    );
    assert.equal(
      f.d.window.document.querySelector('#host')!.textContent,
      'light',
    );
    h.release(1);
    await act(async () =>
      update((current: any) => ({ ...current, theme: 'dark' })),
    );
    await h.api.flushWorkspace();
    assert.equal(h.writes.at(-1)?.theme, 'dark');
    hold = true;
    await act(async () => {
      const accepted = appearance('light', 'default');
      await tick();
      const closing = h.api.flushWorkspace(2);
      await tick();
      assert.equal(h.controller.paused, true);
      confirmedEdit(
        'sample-jira',
        {
          key: 'SAMPLE-1',
          summary: 'Confirmed',
          type: 'Task',
          priority: null,
          assignee: null,
          status: { name: 'Open', category: 'new' },
          links: [],
        },
        ['summary'],
      );
      const reconciled =
        h.workspaceRef.current.seenRoots!['sample-jira:SAMPLE-1'].issues[
          'SAMPLE-1'
        ].fields.Summary;
      redraw();
      saving.release();
      await accepted;
      await closing;
      assert.equal(
        reconciled,
        'Confirmed',
        'confirmed completion updates the paused ref before React commits',
      );
    });
    assert.equal(
      f.d.window.document.querySelector('#host')!.textContent,
      'light',
      'an accepted appearance save commits its React state while the snapshot waits',
    );
    assert.equal(h.writes.at(-1)?.theme, 'light');
    assert.equal(
      h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
        .fields.Summary,
      'Confirmed',
    );
    h.release(2);
  } finally {
    if (h.controller.owner !== undefined) h.release(h.controller.owner);
    await f.close();
  }
});

test('queued snapshot cancellation is enforced before the renderer invokes storage', async () => {
  const d = dom(),
    h = rendererFixture(d.window.document);
  const ast = sourceFile('src/renderer/App.tsx'),
    queued = gate();
  let writes = 0;
  h.controller.pause(1, d.window.document, () => {});
  const save = execute(callback(ast, 'saveWorkspace'), {
    ...h.context,
    pendingWorkspaceSave: { current: queued.promise },
    window: {
      canopy: {
        saveWorkspace: async () => {
          writes++;
        },
      },
    },
  });
  const rejected = assert.rejects(
    save(h.workspaceRef.current, false, 1),
    /canceled/,
  );
  h.release(1);
  queued.release();
  await rejected;
  assert.equal(writes, 0);
  d.window.close();
});

test('production flush effect teardown releases input, refuses stale handlers and allows fresh registration', async () => {
  const d = dom();
  d.window.document.body.inert = false;
  const h = rendererFixture(d.window.document);
  await h.api.flushWorkspace(1);
  assert.equal(h.controller.paused, true);
  h.dispose();
  assert.equal(h.controller.paused, false);
  assert.equal(d.window.document.body.inert, false);
  const count = h.writes.length;
  await assert.rejects(h.api.flushWorkspace(2), /not ready/);
  assert.equal(h.writes.length, count);
  const oldCleanup = h.register();
  h.register();
  oldCleanup();
  await h.api.flushWorkspace(3);
  assert.equal(h.controller.owner, 3);
  h.dispose();
  assert.equal(h.controller.paused, false);
  await assert.rejects(h.api.flushWorkspace(4), /not ready/);
  d.window.close();
});

test('unsubscribed flush registration stops release notifications as well as saves', async () => {
  const d = dom(),
    h = rendererFixture(d.window.document),
    released: number[] = [];
  const unsubscribe = h.api.onWorkspaceFlush(
    async () => {},
    (attempt) => {
      released.push(attempt);
    },
  );
  unsubscribe();
  h.release(7);
  assert.deepEqual(released, []);
  await assert.rejects(h.api.flushWorkspace(8), /not ready/);
  assert.equal(h.writes.length, 0);
  d.window.close();
});

test('production App recovery occupies the main content column and uses existing dialog styles with clean storage reasons', async () => {
  const previousGlobals = new Map(
    [
      'window',
      'document',
      'HTMLElement',
      'requestAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const f = await recoveryFixture();
  let flush!: (attempt?: number) => Promise<unknown>;
  let readFails = true;
  const raw =
    "Error invoking remote method 'canopy:loadWorkspace': Error: Could not read saved workspace.";
  const api = new Proxy(
    {
      connections: async () => [],
      loadWorkspace: async () => {
        if (readFails) throw Error(raw);
        return null;
      },
      saveWorkspace: async () => {
        throw Error(
          "Error invoking remote method 'canopy:saveWorkspace': Error: Could not write saved workspace.",
        );
      },
      demoMode: async () => false,
      demoTimeScale: async () => 1,
      launchDemo: async () => {
        throw Error('Demo could not open');
      },
      onWorkspaceFlush: (handler: typeof flush) => {
        flush = handler;
        return () => {};
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as any)[key]
          : String(key).startsWith('on')
            ? () => () => {}
            : async () => undefined,
    },
  );
  Object.assign(f.d.window, { canopy: api });
  try {
    const style = f.d.window.document.createElement('style');
    style.textContent = readFileSync('src/renderer/styles.css', 'utf8');
    f.d.window.document.head.append(style);
    await act(async () => f.root.render(React.createElement(App)));
    const banner = () =>
      [...f.d.window.document.querySelectorAll('.error-banner')].find(
        (node: any) =>
          node.textContent.includes('Your saved workspace has been kept.'),
      )! as Element;
    assert.equal(
      banner().parentElement!.tagName,
      'MAIN',
      'recovery must not be auto-placed into the sidebar grid column',
    );
    const dialog = f.d.window.document.querySelector('[role=dialog]')!;
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      await act(async () => {
        f.d.window.dispatchEvent(
          new f.d.window.KeyboardEvent('keydown', {
            key: 'k',
            bubbles: true,
            ...modifiers,
          }),
        );
      });
      assert.equal(
        f.d.window.document.querySelectorAll('[role=dialog]').length,
        1,
      );
      assert.equal(
        f.d.window.document.querySelectorAll('#dialog-title').length,
        1,
      );
      assert.equal(f.d.window.document.querySelector('[role=dialog]'), dialog);
    }
    const content = dialog.querySelector('.workspace-recovery-dialog')!;
    assert.ok(content);
    assert.equal(f.d.window.getComputedStyle(content).paddingTop, '15px');
    assert.match(dialog.textContent!, /Could not read saved workspace/);
    assert.doesNotMatch(dialog.textContent!, /Error invoking remote method/);
    const keep = [...dialog.querySelectorAll('button')].find(
      (node: any) => node.textContent === 'Keep open',
    )! as HTMLButtonElement;
    const reload = [...dialog.querySelectorAll('button')].find(
      (node: any) => node.textContent === 'Reload workspace',
    )!;
    assert.ok(keep.classList.contains('secondary'));
    assert.ok(reload.classList.contains('primary'));
    if (process.env.CANOPY_CLOSE_EVIDENCE_DIR)
      await writeFile(
        join(
          process.env.CANOPY_CLOSE_EVIDENCE_DIR,
          'rendered-recovery-dialog.html',
        ),
        f.d.window.document.querySelector('#host')!.innerHTML,
      );
    await act(async () => keep.click());
    assert.equal(
      f.d.window.document.querySelector('[role=dialog]'),
      null,
      'Keep open dismisses the only modal',
    );
    const hide = f.d.window.document.querySelector(
      '[aria-label="Hide sidebar"]',
    ) as HTMLButtonElement;
    await act(async () => hide.click());
    assert.ok(f.d.window.document.querySelector('.app.sidebar-is-collapsed'));
    assert.equal(
      banner().closest('main')!.parentElement!.classList.contains('app'),
      true,
    );
    await act(async () => {
      await flush();
    });
    const welcome = f.d.window.document.querySelector('.welcome-error')!;
    assert.match(welcome.textContent!, /Could not read saved workspace/);
    assert.ok(
      [...f.d.window.document.querySelectorAll('.error-banner')].some((node) =>
        /Workspace has not loaded/.test(node.textContent!),
      ),
    );
    assert.doesNotMatch(
      welcome.textContent!,
      /connection recovery|Error invoking remote method/,
    );
    assert.ok(
      f.d.window.document.querySelector('.welcome-help'),
      'the explicit help actions remain available',
    );
    readFails = false;
    await act(async () =>
      f.root.render(React.createElement(App, { key: 'reloaded' })),
    );
    assert.equal(
      f.d.window.document.querySelector('[role=dialog]'),
      null,
      'successful loading removes initialization recovery',
    );
    await act(async () => {
      await assert.rejects(flush(), /Could not write saved workspace/);
    });
    const savedError = [
      ...f.d.window.document.querySelectorAll('.error-banner'),
    ].find((node) => /Couldn’t save workspace/.test(node.textContent!))!;
    assert.match(
      savedError.textContent!,
      /Couldn’t save workspace: Could not write saved workspace/,
    );
    assert.doesNotMatch(
      savedError.textContent!,
      /Error invoking remote method|connection recovery/,
    );

    const demo = [...f.d.window.document.querySelectorAll('button')].find(
      (node) => node.textContent === 'Try demo',
    )!;
    await act(async () => demo.click());
    assert.match(
      f.d.window.document.querySelector('.welcome-error')!.textContent!,
      /Demo could not open/,
    );
    const currentSaveError = [
      ...f.d.window.document.querySelectorAll('.error-banner'),
    ].find((node) => /Couldn’t save workspace/.test(node.textContent!));
    assert.ok(
      currentSaveError,
      'The workspace save error stays in the document',
    );
    assert.match(
      currentSaveError.textContent!,
      /Couldn’t save workspace: Could not write saved workspace/,
    );
    assert.equal(currentSaveError.getAttribute('role'), 'alert');
    const dismiss = currentSaveError.querySelector(
      '[aria-label="Dismiss workspace save error"]',
    ) as HTMLButtonElement;
    assert.ok(dismiss, 'Welcome save error is dismissible');
    await act(async () => dismiss.click());
    assert.equal(
      f.d.window.document.querySelector(
        '[aria-label="Dismiss workspace save error"]',
      ),
      null,
    );
    const appError = f.d.window.document.querySelector('.welcome-error');
    assert.ok(
      appError,
      'dismissing a workspace error retains the unrelated app error',
    );
    assert.match(appError.textContent!, /Demo could not open/);
    if (process.env.CANOPY_CLOSE_EVIDENCE_DIR)
      await writeFile(
        join(
          process.env.CANOPY_CLOSE_EVIDENCE_DIR,
          'rendered-recovery-layout.html',
        ),
        f.d.window.document.querySelector('#host')!.innerHTML,
      );
  } finally {
    await f.close();
    for (const [name, descriptor] of previousGlobals)
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(globalThis, name),
        descriptor,
        `Restored ${name}`,
      );
  }
});

for (const method of ['loadWorkspace', 'saveWorkspace', 'reloadWorkspace'])
  test(`workspace reason formatting removes only the confirmed ${method} envelope`, () => {
    const prefix = `Error invoking remote method 'canopy:${method}': Error: `;
    for (const value of [
      prefix + 'Saved file is unreadable.',
      Error(prefix + 'Saved file is unreadable.'),
    ])
      assert.equal(workspaceError(value), 'Saved file is unreadable.');
    for (const value of [
      prefix,
      'Provider context: ' + prefix + 'reason',
      `Error invoking remote method 'canopy:${method}': TypeError: reason`,
      "Error invoking remote method 'canopy:author': Error: reason",
    ])
      assert.equal(workspaceError(value), value);
  });

for (const outcome of ['success', 'failure', 'keep-open'])
  test(`accepted Disconnect drains workspace cleanup through ${outcome}`, async () => {
    const d = dom(),
      h = rendererFixture(d.window.document);
    const source = sourceFile('src/renderer/App.tsx');
    const connectionsNode = findNode(
      source,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === 'Connections',
    );
    const attribute = (name: string) => {
      const value = connectionsNode.attributes.properties.find(
        (node) => ts.isJsxAttribute(node) && node.name.getText() === name,
      ) as ts.JsxAttribute;
      return (value.initializer as ts.JsxExpression).expression!.getText();
    };
    const pending = gate();
    let calls = 0;
    const initial = structuredClone(backupWorkspace);
    h.setWorkspace(initial);
    const removed = initial.tabs[0].connectionId;
    const connections = [{ id: removed }];
    let stored = initial;
    const clean = execute(attribute('setConnections'), {
      ...h.context,
      connections,
      workspace: initial,
      setConnections() {},
      forgetSidebarConnections,
      sidebarSessionRef: { current: emptySidebarSession() },
      setSidebarSession() {},
      cooldowns: { current: {} },
      setCooldownTimes() {},
      forgetTabs() {},
      removeConnection,
      storeWorkspace: (value: React.SetStateAction<typeof initial>) => {
        stored = typeof value === 'function' ? value(stored) : value;
        h.context.storeWorkspace(value);
      },
      setHistory() {},
    });
    const disconnect = execute(attribute('disconnect'), {
      ...h.context,
      window: {
        canopy: {
          disconnect: async () => {
            calls++;
            await pending.promise;
          },
        },
      },
    });
    try {
      const accepted = disconnect(removed, () => clean([]));
      const settled =
        outcome === 'failure'
          ? assert.rejects(accepted, /disconnect failed/)
          : accepted;
      const closing = h.api.flushWorkspace(1);
      const flushed =
        outcome === 'keep-open' ? assert.rejects(closing, /canceled/) : closing;
      await tick();
      assert.equal(h.writes.length, 0);
      await assert.rejects(
        disconnect(removed, () => {}),
        /Workspace is closing/,
      );
      assert.equal(calls, 1);
      if (outcome === 'keep-open') h.release(1);
      if (outcome === 'failure') pending.reject(Error('disconnect failed'));
      else pending.release();
      await settled;
      await flushed;
      if (outcome === 'failure') {
        assert.deepEqual(h.workspaceRef.current, initial);
        assert.deepEqual(h.writes.at(-1), initial);
        assert.equal(h.errors().workspace, undefined);
        h.release(1);
      } else {
        const expected = removeConnection(initial, removed);
        assert.deepEqual(h.workspaceRef.current, expected);
        assert.deepEqual(stored, expected);
        if (outcome === 'success') assert.deepEqual(h.writes.at(-1), expected);
        else {
          await h.api.flushWorkspace(2);
          assert.deepEqual(h.writes.at(-1), expected);
        }
      }
    } finally {
      h.dispose();
      d.window.close();
    }
  });

for (const outcome of ['success', 'keep-open'])
  test(`batched Disconnect preserves queued refresh through ${outcome} and final save`, async () => {
    const f = await recoveryFixture();
    const saving = gate();
    let hold = false;
    const h = rendererFixture(
      f.d.window.document,
      async () => {
        if (hold) await saving.promise;
      },
      false,
    );
    const ast = sourceFile('src/renderer/App.tsx');
    const refGuard = findNode(
      ast,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) &&
        ts.isExpressionStatement(node.thenStatement) &&
        ts.isBinaryExpression(node.thenStatement.expression) &&
        node.thenStatement.expression.left.getText() === 'workspaceRef.current',
    );
    const jsx = findNode(
      ast,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === 'Connections',
    );
    const attr = (name: string) =>
      (
        (
          jsx.attributes.properties.find(
            (p) => ts.isJsxAttribute(p) && p.name.getText() === name,
          ) as ts.JsxAttribute
        ).initializer as ts.JsxExpression
      ).expression!.getText();
    const initial = structuredClone(backupWorkspace);
    let update!: (value: any) => void,
      disconnect!: (id: string, complete: () => void) => Promise<void>,
      clean!: (next: any[]) => void,
      state = initial;
    const pending = gate();
    function Component() {
      const [workspace, storeWorkspace] = React.useState(initial);
      state = workspace;
      const context = {
        ...h.context,
        storeWorkspace,
        flushSync,
        useCallback: React.useCallback,
      };
      execute(`()=>{${refGuard.getText()}}`, { ...context, workspace })();
      update = execute(callback(ast, 'setWorkspace'), context);
      clean = execute(attr('setConnections'), {
        ...context,
        connections: [{ id: initial.tabs[0].connectionId }],
        workspace,
        setConnections() {},
        forgetSidebarConnections,
        sidebarSessionRef: { current: emptySidebarSession() },
        setSidebarSession() {},
        cooldowns: { current: {} },
        setCooldownTimes() {},
        forgetTabs() {},
        removeConnection,
        setHistory() {},
      });
      disconnect = execute(attr('disconnect'), {
        ...context,
        window: { canopy: { disconnect: () => pending.promise } },
      });
      const saveWorkspace = execute(callback(ast, 'saveWorkspace'), context);
      React.useLayoutEffect(() => {
        const registration = findNode(
          ast,
          (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            node.expression.getText() === 'window.canopy.onWorkspaceFlush',
        );
        h.api.onWorkspaceFlush(
          execute(registration.arguments[0].getText(), {
            ...context,
            saveWorkspace,
          }),
          execute(registration.arguments[1].getText(), context),
        );
      }, []);
      return null;
    }
    try {
      await act(async () => f.root.render(React.createElement(Component)));
      const operation = disconnect(initial.tabs[0].connectionId, () =>
        clean([]),
      );
      await act(async () => {
        update((current: any) => ({
          ...current,
          seenRoots: {
            ...current.seenRoots,
            'other:CAN-999': { touchedAt: 123, issues: {} },
          },
        }));
        pending.release();
        await operation;
      });
      assert.ok(
        state.seenRoots?.['other:CAN-999'],
        'Disconnect must preserve the queued refresh',
      );
      const expected = removeConnection(
        {
          ...initial,
          seenRoots: {
            ...initial.seenRoots,
            'other:CAN-999': { touchedAt: 123, issues: {} },
          },
        },
        initial.tabs[0].connectionId,
      );
      assert.deepEqual(state, expected);
      assert.deepEqual(h.workspaceRef.current, expected);
      hold = true;
      await act(async () => {
        const closing = h.api.flushWorkspace(1);
        const flushed =
          outcome === 'keep-open'
            ? assert.rejects(closing, /canceled/)
            : closing;
        await tick();
        if (outcome === 'keep-open') h.release(1);
        saving.release();
        await flushed;
      });
      if (outcome === 'keep-open') {
        await act(async () => {
          await h.api.flushWorkspace(2);
        });
      }
      assert.deepEqual(
        h.writes.at(-1),
        expected,
        'final close must retain refresh and disconnect cleanup',
      );
      assert.deepEqual(state, expected);
      if (h.controller.owner !== undefined) h.release(h.controller.owner);
    } finally {
      h.dispose();
      await f.close();
    }
  });

function providerFixture() {
  const d = dom();
  const h = rendererFixture(d.window.document);
  const initial = structuredClone(backupWorkspace);
  initial.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1'].fields = {
    Summary: 'Before',
  };
  h.setWorkspace(initial);
  const issue = {
    id: 'one',
    key: 'SAMPLE-1',
    summary: 'Before',
    type: 'Task',
    priority: { id: 'low', name: 'Low' },
    assignee: { id: 'old', name: 'Old' },
    status: { id: 'open', name: 'Open', category: 'new' as const },
    links: [],
  };
  const ast = sourceFile(
    process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
  );
  const constructor = findNode(
    ast,
    (node): node is ts.NewExpression =>
      ts.isNewExpression(node) && node.expression.getText() === 'Mutations',
  );
  const errors: string[] = [];
  let view: import('../src/renderer/mutations').MutationView;
  const mutations = new Mutations(
    h.api,
    (next) => {
      view = next;
    },
    (message) => errors.push(message),
    execute(constructor.arguments![3].getText(), {
      ...h.context,
      reconcileOwnEdit,
    }),
    undefined,
    undefined,
    undefined,
    execute(constructor.arguments![7].getText(), h.context),
  );
  const snapshot = (current: import('../src/shared/types').Issue = issue) => ({
    rootKey: issue.key,
    issues: [current],
    warnings: [],
    fetchedAt: 1,
  });
  mutations.receive(initial.tabs[0], snapshot(), 0);
  return {
    d,
    h,
    issue,
    snapshot,
    mutations,
    errors,
    view: () => view!,
    baseline: () =>
      h.workspaceRef.current.seenRoots!['sample-jira:SAMPLE-1'].issues[
        'SAMPLE-1'
      ].fields.Summary,
    saved: () =>
      h.writes.at(-1)?.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
        .fields.Summary,
    dispose: () => {
      h.dispose();
      d.window.close();
    },
  };
}

for (const failure of [false, true])
  test(`close drains already queued issue updates and cleans up: failure=${failure}`, async () => {
    const f = providerFixture(),
      first = gate(),
      second = gate();
    let calls = 0;
    f.h.forward(async (name, ...args) => {
      assert.equal(name, 'canopy:update');
      calls++;
      await (calls === 1 ? first : second).promise;
      if (failure && calls === 1) throw Error('provider refused');
      return { ...f.issue, summary: (args[2] as any).summary };
    });
    const a = f.mutations.update('sample-jira', f.issue.key, {
      summary: 'First',
    });
    const b = f.mutations.update('sample-jira', f.issue.key, {
      summary: 'Confirmed',
    });
    await tick();
    let finished = false;
    const closing = f.h.api.flushWorkspace(10).then(() => {
      finished = true;
    });
    await tick();
    assert.equal(finished, false);
    assert.equal(calls, 1);
    first.release();
    assert.equal(await a, !failure);
    await tick();
    assert.equal(
      calls,
      2,
      'queued accepted write must reach provider during close',
    );
    assert.equal(finished, false);
    assert.equal(f.h.writes.length, 0);
    second.release();
    assert.equal(await b, true);
    await closing;
    assert.equal(f.saved(), 'Confirmed');
    assert.equal(f.view().saving.size, 0);
    assert.equal((f.mutations as any).queues.size, 0);
    assert.equal(f.errors.length, failure ? 1 : 0);
    f.h.release(10);
    const later = f.mutations.update('sample-jira', f.issue.key, {
      summary: 'Later',
    });
    assert.equal(await later, true);
    await f.h.save(f.h.workspaceRef.current);
    assert.equal(f.saved(), 'Later');
    f.dispose();
  });

for (const phase of [
  'tree',
  'priorities',
  'transitions',
  'validateAssignee',
] as const)
  for (const failure of [false, true])
    test(`close drains Undo through ${phase}: failure=${failure}`, async () => {
      const f = providerFixture(),
        validation = gate(),
        provider = gate();
      let undo = false,
        updates = 0;
      const field =
        phase === 'priorities'
          ? 'priorityId'
          : phase === 'transitions'
            ? 'transitionId'
            : phase === 'validateAssignee'
              ? 'assigneeId'
              : 'summary';
      const changed = {
        ...f.issue,
        summary: 'Edited',
        priority: { id: 'high', name: 'High' },
        assignee: { id: 'new', name: 'New' },
        status: { id: 'done', name: 'Done', category: 'done' as const },
      };
      f.h.forward(async (name) => {
        if (name === 'canopy:update') {
          updates++;
          if (undo) await provider.promise;
          return undo ? f.issue : changed;
        }
        if (name === `canopy:${phase}`) {
          await validation.promise;
          if (failure) throw Error('validation refused');
        }
        if (name === 'canopy:tree') return f.snapshot(changed);
        if (name === 'canopy:priorities') return [f.issue.priority];
        if (name === 'canopy:transitions')
          return [{ id: 'back', name: 'Back', to: f.issue.status }];
        if (name === 'canopy:validateAssignee') return f.issue.assignee;
        throw Error(name);
      });
      const options = {
        priorities: [changed.priority],
        assignees: [changed.assignee],
        transitions: [
          {
            id: 'finish',
            name: 'Finish',
            requiresFields: false,
            to: changed.status,
          },
        ],
      };
      await f.mutations.update(
        'sample-jira',
        f.issue.key,
        {
          [field]:
            field === 'summary'
              ? 'Edited'
              : field === 'priorityId'
                ? 'high'
                : field === 'assigneeId'
                  ? 'new'
                  : 'finish',
        },
        options,
      );
      undo = true;
      const editing = f.mutations.undo();
      await tick();
      assert.equal(
        f.view().saving.size,
        0,
        'Undo is validating before enqueue',
      );
      let finished = false;
      const closing = f.h.api.flushWorkspace(10).then(() => {
        finished = true;
      });
      await tick();
      assert.equal(finished, false);
      assert.equal(f.h.writes.length, 0);
      validation.release();
      await tick();
      if (!failure) {
        assert.equal(
          updates,
          2,
          'validated Undo may write during its admitted close pause',
        );
        assert.equal(finished, false);
      }
      provider.release();
      assert.equal(await editing, !failure);
      await closing;
      assert.equal(f.view().saving.size, 0);
      assert.equal(f.view().undoBusy, false);
      assert.equal((f.mutations as any).queues.size, 0);
      if (phase === 'tree')
        assert.equal(f.saved(), failure ? 'Edited' : 'Before');
      else {
        const name =
          phase === 'priorities'
            ? 'Priority'
            : phase === 'transitions'
              ? 'Status'
              : 'Assignee';
        const expected =
          phase === 'priorities'
            ? failure
              ? 'High'
              : 'Low'
            : phase === 'transitions'
              ? failure
                ? 'Done'
                : 'Open'
              : failure
                ? 'New'
                : 'Old';
        assert.equal(
          f.h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues[
            'SAMPLE-1'
          ].fields[name],
          expected,
        );
      }
      assert.equal(f.errors.length, failure ? 1 : 0);
      f.h.release(10);
      await f.h.api.flushWorkspace(11);
      f.h.release(11);
      f.dispose();
    });

for (const failure of [false, true])
  test(`provider drain preserves cancel, stale release and later saves: failure=${failure}`, async () => {
    const f = providerFixture(),
      provider = gate();
    f.h.forward(async () => {
      await provider.promise;
      if (failure) throw Error('provider refused');
      return { ...f.issue, summary: 'Confirmed' };
    });
    const editing = f.mutations.update('sample-jira', f.issue.key, {
      summary: 'Confirmed',
    });
    await tick();
    const abandoned = assert.rejects(f.h.api.flushWorkspace(10), /canceled/);
    await tick();
    f.h.release(9);
    assert.equal(f.h.controller.owner, 10);
    f.h.release(10);
    assert.equal(f.h.controller.blocked, false);
    f.h.setWorkspace((value: any) => ({ ...value, theme: 'light' }));
    let finished = false;
    const retry = f.h.api.flushWorkspace(11).then(() => {
      finished = true;
    });
    await tick();
    f.h.release(10);
    assert.equal(f.h.controller.owner, 11);
    assert.equal(finished, false);
    provider.release();
    assert.equal(await editing, !failure);
    await abandoned;
    await retry;
    assert.equal(
      f.h.writes.length,
      1,
      'canceled drain must not save under a new owner',
    );
    assert.equal(f.saved(), failure ? 'Before' : 'Confirmed');
    assert.equal(f.h.writes[0].theme, 'light');
    assert.equal(f.view().saving.size, 0);
    f.h.release(11);
    await f.h.save(f.h.workspaceRef.current);
    assert.equal(
      f.h.writes.length,
      2,
      'normal saving resumes after owning release',
    );
    f.dispose();
  });

for (const transfer of [false, true])
  for (const failure of [false, true])
    test(`admitted confirmed provider edit reconciles close snapshot: transfer=${transfer}, failure=${failure}`, async () => {
      const d = dom();
      const writing = gate(),
        provider = gate();
      let hold = false;
      const h = rendererFixture(d.window.document, async () => {
        if (hold) await writing.promise;
      });
      const initial = structuredClone(backupWorkspace);
      initial.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1'].fields = {
        Summary: 'Before',
      };
      h.setWorkspace(initial);
      const issue = {
        id: 'one',
        key: 'SAMPLE-1',
        summary: 'Confirmed',
        type: 'Task',
        priority: null,
        assignee: null,
        status: { id: 'open', name: 'Open', category: 'new' as const },
        links: [],
      };
      h.forward(async (name) => {
        assert.equal(name, 'canopy:update');
        await provider.promise;
        if (failure) throw Error('provider refused');
        return issue;
      });
      const ast = sourceFile(
        process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
      );
      const constructor = findNode(
        ast,
        (node): node is ts.NewExpression =>
          ts.isNewExpression(node) && node.expression.getText() === 'Mutations',
      );
      const confirmed = execute(constructor.arguments![3].getText(), {
        ...h.context,
        reconcileOwnEdit,
        setWorkspace: h.setWorkspace,
      });
      const mutations = new Mutations(
        h.api,
        () => {},
        () => {},
        confirmed,
        undefined,
        undefined,
        undefined,
        execute(constructor.arguments![7].getText(), h.context),
      );
      mutations.receive(
        initial.tabs[0],
        {
          rootKey: issue.key,
          issues: [{ ...issue, summary: 'Before' }],
          warnings: [],
          fetchedAt: 1,
        },
        0,
      );
      const editing = mutations.update('sample-jira', issue.key, {
        summary: 'Confirmed',
      });
      await tick();
      if (transfer) {
        h.controller.beginTransfer(d.window.document);
        h.context.workspaceTransferBusy.current = true;
        h.context.workspaceTransferCommitted.current = true;
      }
      let finished = false;
      const closing = h.api.flushWorkspace(10).then(() => {
        finished = true;
      });
      await tick();
      assert.equal(
        finished,
        false,
        'close must await admitted provider completion',
      );
      assert.equal(
        h.writes.length,
        0,
        'final snapshot must follow provider completion',
      );
      assert.equal(
        await mutations.update('sample-jira', issue.key, { summary: 'late' }),
        false,
      );
      h.setWorkspace((value: any) => ({ ...value, theme: 'light' }));
      assert.equal(h.workspaceRef.current.theme, initial.theme);
      provider.release();
      await editing;
      assert.equal(
        h.workspaceRef.current.seenRoots!['sample-jira:SAMPLE-1'].issues[
          'SAMPLE-1'
        ].fields.Summary,
        failure ? 'Before' : 'Confirmed',
      );
      writing.release();
      await closing;
      if (transfer)
        assert.equal(
          h.writes.length,
          0,
          'confirmed completion cannot write outgoing transfer state',
        );
      else
        assert.equal(
          h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
            .fields.Summary,
          failure ? 'Before' : 'Confirmed',
        );
      h.release(9);
      assert.equal(h.controller.paused, true);
      h.release(10);
      assert.equal(h.controller.blocked, transfer);
      hold = false;
      if (!transfer) {
        await h.api.flushWorkspace();
        assert.equal(
          h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
            .fields.Summary,
          failure ? 'Before' : 'Confirmed',
        );
      }
      h.dispose();
      d.window.close();
    });

test('transfer barrier refuses direct navigation, organization and scroll mutations', () => {
  const d = dom(),
    h = rendererFixture(d.window.document);
  const ast = sourceFile(
    process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
  );
  const tab = { ...backupWorkspace.tabs[0], scrollTop: 100 };
  h.setWorkspace({
    ...h.workspaceRef.current,
    tabs: [tab],
    activeTabId: tab.id,
  });
  const viewport = { scrollTop: 0 };
  let inbox = true,
    organizations = 0,
    saves = 0;
  let timer!: () => void;
  const context = {
    ...h.context,
    setWorkspace: h.setWorkspace,
    scrollRef: { current: viewport },
    snapshot: {},
    activeTab: tab,
    pendingScrollRestore: { current: null },
    setInboxOpen: (value: boolean) => {
      inbox = value;
    },
    setHistory() {},
    historyRef: { current: {} },
    visit: () => ({}),
    sameRoot: () => true,
    activateTab: (value: any) => value,
    sidebarSessionRef: { current: {} },
    connectionsRef: { current: [] },
    organizeSidebar: () => {
      organizations++;
      return { workspace: h.workspaceRef.current, session: {} };
    },
    setSidebarSession() {},
    saveWorkspace: async () => {
      saves++;
    },
    clearTimeout() {},
    setTimeout: (callback: () => void) => {
      timer = callback;
      return 1;
    },
  };
  const scroll = findNode(
    ast,
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'onScroll' &&
      node
        .initializer!.getText()
        .includes('workspaceRef.current = withScrollPositions'),
  );
  const onScroll = execute(
    (scroll.initializer as ts.JsxExpression).expression!.getText(),
    context,
  );
  // An autosave timer admitted before transfer must also refuse after admission.
  onScroll({ currentTarget: { scrollTop: 42 } });
  assert.equal(h.context.scrollPositions.current.get(tab.id), 42);
  h.controller.beginTransfer(d.window.document);
  execute(callback(ast, 'organize'), context)({ type: 'undo' });
  assert.equal(organizations, 0);
  execute(callback(ast, 'navigate'), context)(tab, true);
  assert.equal(inbox, true);
  execute(callback(ast, 'updateTab'), context)(tab.id, { scrollTop: 300 });
  assert.equal(h.context.scrollPositions.current.get(tab.id), 42);
  execute(callback(ast, 'restoreScroll'), context)(tab);
  assert.equal(viewport.scrollTop, 0);
  onScroll({ currentTarget: { scrollTop: 300 } });
  assert.equal(h.context.scrollPositions.current.get(tab.id), 42);
  timer();
  assert.equal(saves, 0);
  h.controller.endTransfer();
  execute(callback(ast, 'navigate'), context)(tab, true);
  assert.equal(inbox, false);
  h.dispose();
  d.window.close();
});

for (const failure of [false, true])
  test(`preload issue mutation admission expires after settlement: failure=${failure}`, async () => {
    const f = providerFixture();
    let retained!: Pick<
      import('../src/shared/types').CanopyAPI,
      'update' | 'rank'
    >;
    f.h.forward(async () => f.issue);
    const run = f.h.api.withIssueMutations(async (writes) => {
      retained = writes;
      await writes.update('sample-jira', f.issue.key, {});
      if (failure) throw Error('operation failed');
      return true;
    });
    if (failure) await assert.rejects(run, /operation failed/);
    else assert.equal(await run, true);
    await assert.rejects(
      retained.update('sample-jira', f.issue.key, {}),
      /finished/,
    );
    await assert.rejects(
      retained.rank('sample-jira', f.issue.key, 'other'),
      /finished/,
    );
    await f.h.api.flushWorkspace(10);
    await assert.rejects(
      f.h.api.withIssueMutations(async () => true),
      /closing/,
    );
    await assert.rejects(
      f.h.api.update('sample-jira', f.issue.key, {}),
      /closing/,
    );
    f.h.release(10);
    await assert.rejects(
      f.h.api.applyWorkspaceImport('fixture', async () => {
        throw Error('abort transfer');
      }),
      /abort transfer/,
    );
    assert.equal(await f.h.api.withIssueMutations(async () => true), true);
    await f.h.api.applyWorkspaceImport('fixture');
    await assert.rejects(
      f.h.api.withIssueMutations(async () => true),
      /transfer/,
    );
    f.dispose();
  });

for (const operation of ['rank', 'transitionPath'] as const)
  for (const failure of [false, true])
    test(`close drains admitted ${operation}: failure=${failure}`, async () => {
      const f = providerFixture(),
        provider = gate();
      f.mutations.receive(
        backupWorkspace.tabs[0],
        {
          ...f.snapshot(),
          issues: [
            { ...f.issue, parentKey: 'ROOT' },
            { ...f.issue, key: 'SAMPLE-2', parentKey: 'ROOT' },
          ],
          ranking: { state: 'supported', issueKeys: [f.issue.key, 'SAMPLE-2'] },
        },
        0,
      );
      const done = { id: 'done', name: 'Done', category: 'done' as const };
      const intermediate = {
        id: 'progress',
        name: 'In Progress',
        category: 'indeterminate' as const,
      };
      let writes = 0,
        reads = 0;
      let current: import('../src/shared/types').Issue = f.issue;
      f.h.forward(async (name, ...args) => {
        if (name === 'canopy:transitions')
          return [
            { id: 'start', to: intermediate },
            { id: 'finish', to: done },
          ];
        if (name === 'canopy:rank') {
          await provider.promise;
          return;
        }
        if (!(args[2] as any).transitionId) {
          reads++;
          return current;
        }
        writes++;
        if (writes === 1)
          return (current = { ...f.issue, status: intermediate });
        await provider.promise;
        return (current = { ...f.issue, status: done });
      });
      const editing =
        operation === 'rank'
          ? f.mutations.rank('sample-jira', f.issue.key, 'SAMPLE-2')
          : f.mutations.transitionPath(
              'sample-jira',
              f.issue.key,
              f.issue.status,
              {
                destination: done,
                steps: [
                  { id: 'start', to: intermediate },
                  { id: 'finish', to: done },
                ],
              },
            );
      await tick();
      if (operation === 'transitionPath') {
        assert.equal(
          writes,
          2,
          'second transition write must be held before close',
        );
        assert.equal(current.status.id, 'progress');
        assert.equal(reads, 1);
      }
      let finished = false;
      const closing = f.h.api.flushWorkspace(10).then(() => {
        finished = true;
      });
      await tick();
      assert.equal(finished, false);
      assert.equal(f.h.writes.length, 0);
      if (failure) provider.reject(Error('provider refused'));
      else provider.release();
      assert.equal(await editing, operation === 'transitionPath' || !failure);
      await closing;
      assert.equal(f.view().saving.size, 0);
      assert.equal((f.mutations as any).queues.size, 0);
      if (operation === 'transitionPath')
        assert.equal(
          f.mutations.confirmedSnapshot(backupWorkspace.tabs[0].id)!.issues[0]
            .status.id,
          failure ? 'progress' : 'done',
        );
      if (operation === 'transitionPath') {
        assert.equal(writes, 2);
        assert.equal(
          reads,
          failure ? 2 : 1,
          'failed second write must recover confirmed status',
        );
        assert.equal(
          f.h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues[
            'SAMPLE-1'
          ].fields.Status,
          failure ? 'In Progress' : 'Done',
        );
      }
      assert.deepEqual(f.h.writes.at(-1), f.h.workspaceRef.current);
      f.h.release(10);
      f.dispose();
    });

for (const lifetime of ['current', 'closed', 'unmounted', 'retargeted'])
  for (const failure of [false, true])
    test(`close drains preview label reconciliation and tolerated failure: lifetime=${lifetime}, failure=${failure}`, async (t) => {
      const warnings = t.mock.method(console, 'error', () => {});
      let dataWrites = 0;
      const useState = React.useState;
      t.mock.method(React, 'useState', ((initial: unknown) => {
        const [value, setValue] = useState(initial);
        return [
          value,
          (next: any) => {
            if (next?.issue) dataWrites++;
            setValue(next);
          },
        ];
      }) as typeof React.useState);
      const f = providerFixture(),
        provider = gate();
      let ui: Awaited<ReturnType<typeof recoveryFixture>> | undefined;
      t.after(async () => {
        const host = ui?.d.window.document.querySelector('#host');
        let pending: number | undefined, paused: boolean | undefined;
        try {
          await act(async () => provider.release());
          if (f.h.controller.owner !== undefined)
            f.h.release(f.h.controller.owner);
          pending = (f.h.controller as any).pending.size;
          paused = f.h.controller.paused;
        } finally {
          try {
            await ui?.close();
          } finally {
            f.dispose();
          }
        }
        assert.equal(
          pending,
          0,
          'preview provider work settled before disposal',
        );
        assert.equal(paused, false, 'preview close released before disposal');
        assert.equal(
          host?.textContent,
          '',
          'preview root unmounted during teardown',
        );
        assert.equal(
          warnings.mock.calls.some((call) =>
            /act\(.*(?:without await|overlapping)|overlapping act|not wrapped in act/.test(
              call.arguments.join(' '),
            ),
          ),
          false,
          'preview lifecycle has no unawaited or overlapping act scopes',
        );
      });
      f.h.forward(async () => {
        await provider.promise;
        if (failure) throw Error('label refused');
        return { ...f.issue, labels: [{ id: 'bug', name: 'bug' }] };
      });
      const ast = sourceFile(
        process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
      );
      const preview = findNode(
        ast,
        (node): node is ts.JsxSelfClosingElement =>
          ts.isJsxSelfClosingElement(node) &&
          node.tagName.getText() === 'IssuePreview',
      );
      const attr = (name: string) => {
        const prop = preview.attributes.properties.find(
          (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name,
        ) as ts.JsxAttribute;
        return (prop.initializer as ts.JsxExpression).expression!.getText();
      };
      const onChanged = execute(attr('onChanged'), {
        mutations: f.mutations,
        previewRoute: { connectionId: 'sample-jira' },
        allRefreshTabs: [],
      });
      const editLabels = execute(attr('editLabels'), {
        mutations: f.mutations,
      });
      const trackMutation = execute(attr('trackMutation'), f.h.context);
      ui = await recoveryFixture();
      const previewUI = ui;
      Object.assign(previewUI.d.window.canopy, f.h.api, {
        preview: async (_connection: string, key: string) => ({
          issue: { ...f.issue, key, labels: [] },
          description: '',
          comments: [],
          totalComments: 0,
        }),
        labels: async () => [{ id: 'bug', name: 'bug' }],
      });
      let issueKey = f.issue.key;
      function Preview() {
        const [open, setOpen] = React.useState(true);
        return open
          ? React.createElement(IssuePreview, {
              connectionId: 'sample-jira',
              provider: 'github',
              connectionName: 'Fixture',
              issueKey,
              relationshipsLoading: false,
              width: 400,
              onWidth() {},
              onClose() {
                setOpen(false);
              },
              onChanged,
              editLabels,
              trackMutation,
              onAuthoringChanged() {},
              onPreview() {},
              onJump() {},
              onOpenExternal() {},
              onCopyKeySummary() {},
              onWorkBrief() {},
              onOpenComment() {},
              onRelationships() {},
              onMarkSeen() {},
            })
          : null;
      }
      const render = () =>
        act(async () => previewUI.root.render(React.createElement(Preview)));
      await render();
      const host = previewUI.d.window.document.querySelector('#host')!;
      const button = (text: string) =>
        [...host.querySelectorAll('button')].find(
          (node) => node.textContent === text,
        )!;
      await act(async () => button('Edit labels').click());
      await act(async () =>
        (
          host.querySelector('input[type=checkbox]') as HTMLInputElement
        ).click(),
      );
      assert.match(host.textContent!, /Saving labels/);
      if (lifetime === 'closed')
        await act(async () =>
          (
            host.querySelector(
              '[title="Close preview (Escape)"]',
            ) as HTMLButtonElement
          ).click(),
        );
      if (lifetime === 'closed')
        assert.equal(
          host.textContent,
          '',
          'Close commits unmount before provider release',
        );
      if (lifetime === 'unmounted')
        await act(async () => previewUI.root.render(null));
      if (lifetime === 'retargeted') {
        issueKey = 'OTHER-2';
        await render();
      }
      let finished = false;
      const closing = f.h.api.flushWorkspace(10).then(() => {
        finished = true;
      });
      await tick();
      assert.equal(finished, false);
      assert.equal(f.h.writes.length, 0);
      const writesBeforeResponse = dataWrites;
      assert.ok(
        writesBeforeResponse > 0,
        'state instrumentation observes real preview updates',
      );
      await act(async () => provider.release());
      assert.equal(
        dataWrites - writesBeforeResponse,
        lifetime === 'current' ? 1 : 0,
        'stale provider completion must not call the preview state setter',
      );
      await assert.doesNotReject(
        closing,
        'a refused label edit must still allow workspace persistence',
      );
      if (lifetime === 'current') {
        assert.equal(
          host.textContent!.includes('Labels were not saved'),
          failure,
        );
        assert.equal(
          (host.querySelector('input[type=checkbox]') as HTMLInputElement)
            .checked,
          !failure,
        );
      } else if (lifetime === 'retargeted') {
        assert.match(host.textContent!, /OTHER-2/);
        assert.doesNotMatch(
          host.textContent!,
          /Labels saved|Labels were not saved/,
        );
        await act(async () => button('Edit labels').click());
        assert.equal(
          (host.querySelector('input[type=checkbox]') as HTMLInputElement)
            .checked,
          false,
        );
      } else assert.equal(host.textContent, '');
      const labels =
        f.h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
          .fields.Labels;
      assert.deepEqual(labels, failure ? undefined : ['bug']);
      f.h.release(10);
    });

test('a retained admitted issue writer refuses writes after transfer admission', async () => {
  const f = providerFixture(),
    transfer = gate();
  const pending = f.h.api.withIssueMutations(async (writes) => {
    await transfer.promise;
    await assert.rejects(
      writes.update('sample-jira', f.issue.key, {}),
      /transfer/,
    );
    await assert.rejects(
      writes.rank('sample-jira', f.issue.key, 'other'),
      /transfer/,
    );
    return true;
  });
  await f.h.api.applyWorkspaceImport('fixture');
  transfer.release();
  assert.equal(await pending, true);
  assert.equal(f.h.calls.includes('canopy:update'), false);
  assert.equal(f.h.calls.includes('canopy:rank'), false);
  f.dispose();
});

test('real preload receives explicit flush provenance and ordinary save false', async () => {
  const d = dom(),
    h = rendererFixture(d.window.document);
  await h.save(h.workspaceRef.current);
  assert.equal(h.saveArguments.length, 1);
  assert.equal(h.saveArguments[0][1], false);
  await h.api.flushWorkspace(20);
  assert.equal(h.saveArguments.length, 2);
  assert.equal(h.saveArguments[1][1], true);
  h.release(20);
  await h.save(h.workspaceRef.current);
  assert.equal(h.saveArguments.at(-1)![1], false);
  h.dispose();
  d.window.close();
});

for (const kind of ['apply', 'undo'])
  for (const failure of [false, true])
    test(`transfer drains admitted two-step status path before preload barrier: ${kind}, failure=${failure}`, async () => {
      const f = providerFixture(),
        lookup = gate(),
        transfer = gate();
      const progress = {
        id: 'progress',
        name: 'In Progress',
        category: 'indeterminate' as const,
      };
      const done = { id: 'done', name: 'Done', category: 'done' as const };
      let current: import('../src/shared/types').Issue = f.issue;
      let lookups = 0,
        transfers = 0,
        reads = 0;
      f.h.forward(async (name, ...args) => {
        if (name === 'canopy:transitions') {
          if (++lookups === 2) await lookup.promise;
          return [
            { id: 'start', to: progress },
            { id: 'finish', to: done },
          ];
        }
        if (name === 'canopy:update') {
          const patch = args[2] as any;
          if (!patch.transitionId) {
            reads++;
            return current;
          }
          current = {
            ...current,
            status: patch.transitionId === 'start' ? progress : done,
          };
          return current;
        }
        transfers++;
        assert.equal(
          name,
          kind === 'apply'
            ? 'canopy:applyWorkspaceImport'
            : 'canopy:rollbackWorkspaceImport',
        );
        await transfer.promise;
        if (failure) throw Error('transfer refused');
        return f.h.workspaceRef.current;
      });
      const editing = f.mutations.transitionPath(
        'sample-jira',
        f.issue.key,
        f.issue.status,
        {
          destination: done,
          steps: [
            { id: 'start', to: progress },
            { id: 'finish', to: done },
          ],
        },
      );
      await tick();
      assert.equal(current.status.id, 'progress');
      assert.equal(lookups, 2);
      const ast = sourceFile(
        process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
      );
      const panel = findNode(
        ast,
        (n): n is ts.JsxSelfClosingElement =>
          ts.isJsxSelfClosingElement(n) &&
          n.tagName.getText() === 'WorkspaceBackupPanel',
      );
      const attr = panel.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onApply',
      ) as ts.JsxAttribute;
      const onApply = execute(
        (attr.initializer as ts.JsxExpression).expression!.getText(),
        {
          ...f.h.context,
          saveWorkspace: f.h.save,
          setWorkspaceTransferActive() {},
        },
      );
      const applying = onApply(
        (before: () => Promise<void>, drain: () => Promise<void>) =>
          kind === 'apply'
            ? f.h.api.applyWorkspaceImport('accepted', before, drain)
            : f.h.api.rollbackWorkspaceImport(before, drain),
      );
      const observed = failure
        ? assert.rejects(applying, /transfer refused/)
        : applying;
      assert.equal(f.h.controller.blocked, true);
      assert.equal(
        await f.mutations.update('sample-jira', f.issue.key, {
          summary: 'late',
        }),
        false,
      );
      await tick();
      await assert.rejects(
        f.h.api.saveWorkspace(f.h.workspaceRef.current),
        /transfer/,
      );
      await assert.rejects(
        f.h.api.update('sample-jira', f.issue.key, {}),
        /transfer/,
      );
      assert.equal(transfers, 0);
      assert.equal(
        f.h.writes.length,
        0,
        'snapshot must wait for admitted provider work',
      );
      let closed = false;
      const closing = f.h.api.flushWorkspace(30).then(() => {
        closed = true;
      });
      await tick();
      assert.equal(closed, false);
      lookup.release();
      assert.equal(
        await editing,
        true,
        'admitted second write must survive transfer admission and close',
      );
      await tick();
      assert.equal(current.status.id, 'done');
      assert.equal(reads, 1);
      assert.equal(transfers, 1);
      assert.equal(
        closed,
        false,
        'close waits for the held transfer operation',
      );
      assert.equal(
        f.h.writes[0].seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1']
          .fields.Status,
        'Done',
      );
      transfer.release();
      await observed;
      await closing;
      assert.equal(f.h.controller.blocked, true);
      assert.equal(f.view().saving.size, 0);
      assert.equal((f.mutations as any).queues.size, 0);
      if (failure)
        assert.equal(
          f.h.writes.at(-1)!.seenRoots!['sample-jira:SAMPLE-1'].issues[
            'SAMPLE-1'
          ].fields.Status,
          'Done',
        );
      f.h.release(30);
      assert.equal(f.h.controller.blocked, !failure);
      if (failure) {
        assert.equal(
          await f.mutations.update('sample-jira', f.issue.key, {}),
          true,
        );
        await f.h.save(f.h.workspaceRef.current);
      }
      f.dispose();
    });

for (const method of ['update', 'rank', 'transitionPath', 'undo'] as const)
  test(`close admission refusal preserves mutation false/error contract: ${method}`, async () => {
    const f = providerFixture();
    await f.h.api.flushWorkspace(40);
    let calls = 0;
    f.h.forward(async () => {
      calls++;
      return f.issue;
    });
    const result =
      method === 'update'
        ? f.mutations.update('sample-jira', f.issue.key, { summary: 'late' })
        : method === 'rank'
          ? f.mutations.rank('sample-jira', f.issue.key, 'other')
          : method === 'undo'
            ? f.mutations.undo()
            : f.mutations.transitionPath(
                'sample-jira',
                f.issue.key,
                f.issue.status,
                { destination: f.issue.status, steps: [] },
              );
    assert.equal(await result, false);
    assert.match(f.errors.at(-1)!, /closing/);
    assert.equal(calls, 0);
    assert.equal(f.view().saving.size, 0);
    assert.equal((f.mutations as any).queues.size, 0);
    f.h.release(40);
    assert.equal(
      await f.mutations.update('sample-jira', f.issue.key, {}),
      true,
    );
    f.dispose();
  });

test('assignee validation completing during close restores picker after admission refusal', async () => {
  const f = providerFixture(),
    validation = gate();
  const tab = backupWorkspace.tabs[0];
  let cleared = 0;
  let editor: any = {
    tabId: tab.id,
    connectionId: tab.connectionId,
    key: f.issue.key,
    field: 'assignee',
  };
  const rejected: string[] = [];
  const update = execute(
    callback(
      sourceFile(
        process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
      ),
      'updateIssue',
    ),
    {
      useCallback: (fn: unknown) => fn,
      activeTab: tab,
      workspaceClose: f.h.context.workspaceClose,
      activeIdRef: { current: tab.id },
      editSession: { current: 1 },
      setEditor: (fn: (value: unknown) => unknown) => {
        editor = fn(editor);
        if (editor === null) cleared++;
      },
      mutations: f.mutations,
      pickers: {
        validate: async () => {
          await validation.promise;
          return true;
        },
        values: {},
        rejected: (_connection: string, _key: string, field: string) =>
          rejected.push(field),
      },
    },
  );
  const editing = update(f.issue.key, { assigneeId: 'new' });
  await f.h.api.flushWorkspace(50);
  validation.release();
  await assert.doesNotReject(editing);
  assert.deepEqual(rejected, ['assignee']);
  assert.equal(cleared, 0, 'refused admission must preserve the open picker');
  assert.deepEqual(editor, {
    tabId: tab.id,
    connectionId: tab.connectionId,
    key: f.issue.key,
    field: 'assignee',
  });
  assert.match(f.errors.at(-1)!, /closing/);
  f.h.release(50);
  f.dispose();
});

for (const mode of ['deferred', 'navigation-refused', 'canceled', 'expired'])
  test(`handoff retains delivery through blocked navigation: ${mode}`, async () => {
    const f = await recoveryFixture();
    let receive!: (state: any) => void;
    let now = Date.now();
    const delivery = {
      session: 'session',
      id: 'delivery',
      expiresAt: now + 60_000,
      intent: { kind: 'view', view: 'triage' },
    };
    const acks: unknown[] = [];
    let attempts = 0,
      navigated = 0,
      rejected = 0,
      canceled = 0;
    let blocked = true,
      deferred = mode !== 'navigation-refused';
    Object.assign(f.d.window.canopy, {
      onHandoff: (fn: typeof receive) => {
        receive = fn;
        return () => {};
      },
      handoffReady: async () => ({ session: 'session', delivery }),
      handoffAck: async (...args: unknown[]) => {
        acks.push(args);
      },
      handoffCancel: async () => {
        canceled++;
      },
    });
    const declaration = findNode(
      sourceFile(
        process.env.CANOPY_HANDOFF_SOURCE ?? 'src/renderer/work-handoff.ts',
      ),
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.getText() === 'useWorkHandoff',
    );
    const hook = execute(
      `() => { ${declaration.getText().replace(/^export /, '')}; return useWorkHandoff; }`,
      {
        useRef: React.useRef,
        useState: React.useState,
        useEffect: React.useEffect,
        window: f.d.window,
        crypto: { randomUUID: () => 'owner' },
        Date: { now: () => now },
      },
    )();
    function Component() {
      hook(
        true,
        () => {
          attempts++;
          if (blocked) return false;
          navigated++;
        },
        () => rejected++,
        deferred,
      );
      return null;
    }
    try {
      await act(async () => f.root.render(React.createElement(Component)));
      assert.equal(navigated, 0);
      assert.equal(attempts, mode === 'navigation-refused' ? 1 : 0);
      assert.deepEqual(acks, [], 'blocked delivery cannot acknowledge opened');
      if (mode === 'canceled')
        await act(async () =>
          receive({ session: 'session', canceledId: delivery.id }),
        );
      if (mode === 'expired') now = delivery.expiresAt + 1;
      blocked = false;
      deferred = false;
      await act(async () => f.root.render(React.createElement(Component)));
      if (mode === 'canceled') {
        assert.equal(navigated, 0);
        assert.deepEqual(acks, []);
      } else {
        assert.equal(navigated, mode === 'expired' ? 0 : 1);
        assert.equal(rejected, mode === 'expired' ? 1 : 0);
        assert.deepEqual(acks, [
          ['session', 'delivery', mode === 'expired' ? 'rejected' : 'opened'],
        ]);
      }
    } finally {
      await f.close();
    }
    assert.equal(canceled, 1);
  });

for (const kind of ['apply', 'undo'])
  test(`failed provider drain releases preload transfer admission and renderer ownership: ${kind}`, async () => {
    const d = dom();
    d.window.document.body.inert = false;
    const h = rendererFixture(d.window.document),
      prior = gate();
    const editing = h.controller.track(async () => {
      await prior.promise;
    });
    const rejectedEdit = assert.rejects(editing, /provider failed/);
    const ast = sourceFile(
      process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
    );
    const panel = findNode(
      ast,
      (n): n is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(n) &&
        n.tagName.getText() === 'WorkspaceBackupPanel',
    );
    const attr = panel.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onApply',
    ) as ts.JsxAttribute;
    const applying = execute(
      (attr.initializer as ts.JsxExpression).expression!.getText(),
      {
        ...h.context,
        saveWorkspace: h.save,
        setWorkspaceTransferActive() {},
      },
    )((before: () => Promise<void>, drain: () => Promise<void>) =>
      kind === 'apply'
        ? h.api.applyWorkspaceImport('accepted', before, drain)
        : h.api.rollbackWorkspaceImport(before, drain),
    );
    const rejectedApply = assert.rejects(applying, /provider failed/);
    assert.equal(h.controller.blocked, true);
    await assert.rejects(h.api.update('sample', 'ONE', {}), /transfer/);
    prior.reject(Error('provider failed'));
    await rejectedEdit;
    await rejectedApply;
    assert.equal(h.controller.blocked, false);
    assert.equal(d.window.document.body.inert, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls.includes('canopy:applyWorkspaceImport'), false);
    assert.equal(h.calls.includes('canopy:rollbackWorkspaceImport'), false);
    await assert.doesNotReject(() =>
      h.api.withIssueMutations(async (writes) => {
        await writes.update('sample', 'ONE', {});
        return true;
      }),
    );
    await assert.doesNotReject(() => h.save(h.workspaceRef.current));
    assert.equal(h.writes.length, 1);
    h.dispose();
    d.window.close();
  });

for (const mode of ['absent', 'existing', 'pending', 'main-settled'])
  test(`handoff retries absent registration after close release and preserves session: mode=${mode}`, async () => {
    const existing = mode === 'existing';
    let mainClosing = mode === 'main-settled';
    const held = gate();
    const f = await recoveryFixture();
    let deferred = existing ? false : true;
    let calls = 0,
      canceled = 0,
      rejected = 0;
    const acks: unknown[] = [];
    let receive!: (state: any) => void;
    Object.assign(f.d.window.canopy, {
      onHandoff: (fn: typeof receive) => {
        receive = fn;
        return () => {};
      },
      handoffReady: async () => {
        calls++;
        if (mode === 'pending' && calls === 1) {
          await held.promise;
          return { session: '', closeSettled: false };
        }
        if (deferred || mainClosing)
          return { session: '', closeSettled: false };
        return { session: 'valid' };
      },
      handoffCancel: async () => {
        canceled++;
      },
      handoffAck: async (...args: unknown[]) => {
        acks.push(args);
      },
    });
    const declaration = findNode(
      sourceFile(
        process.env.CANOPY_HANDOFF_SOURCE ?? 'src/renderer/work-handoff.ts',
      ),
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.getText() === 'useWorkHandoff',
    );
    const hook = execute(
      `() => { ${declaration.getText().replace(/^export /, '')}; return useWorkHandoff; }`,
      {
        useRef: React.useRef,
        useState: React.useState,
        useEffect: React.useEffect,
        window: f.d.window,
        crypto: { randomUUID: () => 'owner' },
      },
    )();
    function Component() {
      hook(
        true,
        () => {},
        () => {
          rejected++;
        },
        deferred,
      );
      return null;
    }
    const render = () =>
      act(async () => f.root.render(React.createElement(Component)));
    try {
      await render();
      if (existing) {
        deferred = true;
        await render();
      }
      assert.equal(calls, 1);
      deferred = false;
      await render();
      if (mode === 'pending') {
        assert.equal(calls, 1);
        await act(async () => held.release());
      }
      if (mode === 'main-settled') {
        assert.equal(calls, 2, 'early input release retry is refused by main');
        mainClosing = false;
        await act(async () => receive({ session: '', closeSettled: true }));
      }
      assert.equal(rejected, 0, 'close deferral is not a failed command');
      assert.equal(calls, existing ? 1 : mode === 'main-settled' ? 3 : 2);
      const registered = calls;
      await act(async () => receive({ session: '', closeSettled: true }));
      assert.equal(
        calls,
        registered,
        'settled notification preserves an existing session',
      );
      assert.equal(canceled, 0);
      await act(async () =>
        receive({
          session: 'valid',
          delivery: {
            session: 'valid',
            id: 'delivery',
            expiresAt: Date.now() + 1000,
            intent: { kind: 'view', view: 'triage' },
          },
        }),
      );
      assert.deepEqual(acks, [['valid', 'delivery', 'opened']]);
      assert.equal(
        rejected,
        0,
        'successful retry leaves no command failure feedback',
      );
    } finally {
      await f.close();
    }
    assert.equal(canceled, 1);
    const disposedCalls = calls;
    receive({ session: '', closeSettled: true });
    await tick();
    assert.equal(
      calls,
      disposedCalls,
      'disposed hook ignores late settled notifications',
    );
  });

for (const committed of [false, true])
  test(`backup panel scopes recovery instruction to transfer outcome: committed=${committed}`, async () => {
    const f = await recoveryFixture();
    Object.assign(f.d.window.canopy, {
      canUndoWorkspaceImport: async () => true,
    });
    try {
      await act(async () =>
        f.root.render(
          React.createElement(WorkspaceBackupPanel, {
            connections: [],
            flush: async () => {},
            onApply: async () => {
              throw committed
                ? new WorkspaceTransferReloadError(
                    'Workspace transferred, but reload failed. Restart Canopy before editing.',
                  )
                : Error('transfer refused');
            },
          }),
        ),
      );
      const undo = [...f.d.window.document.querySelectorAll('button')].find(
        (node) => node.textContent === 'Undo last import',
      )!;
      await act(async () => undo.click());
      const text =
        f.d.window.document.querySelector('[role=alert]')!.textContent!;
      assert.equal(
        text.includes('Existing workspace remains intact'),
        !committed,
      );
      assert.equal(text.includes('Preview again'), !committed);
      assert.equal(text.includes('Restart Canopy before editing'), committed);
    } finally {
      await f.close();
    }
  });

const childCleanupRecords: {
  host: Element;
  previousWindow: unknown;
  previousDocument: unknown;
  renderer?: ReturnType<typeof rendererFixture>;
  ownerBeforeDispose?: number;
  pendingBeforeDispose?: number;
}[] = [];
for (const phase of ['validation', 'provider'])
  for (const outcome of ['success', 'failure', 'timeout-release'])
    test(`close drains admitted child creation through ${phase}: ${outcome}`, async (t) => {
      const previousWindow = globalThis.window,
        previousDocument = globalThis.document;
      const ui = await recoveryFixture();
      let acquired: ReturnType<typeof rendererFixture> | undefined;
      const held = gate();
      let closing: Promise<unknown> | undefined;
      t.after(async () => {
        try {
          await act(async () => held.release());
          if (acquired?.controller.owner !== undefined)
            acquired.release(acquired.controller.owner);
          await closing?.catch(() => {});
        } finally {
          record.ownerBeforeDispose = acquired?.controller.owner;
          record.pendingBeforeDispose = acquired
            ? (acquired.controller as any).pending.size
            : undefined;
          try {
            acquired?.dispose();
          } finally {
            await ui.close();
          }
        }
      });
      const record = {
        host: ui.d.window.document.querySelector('#host')!,
        previousWindow,
        previousDocument,
        renderer: undefined as ReturnType<typeof rendererFixture> | undefined,
        ownerBeforeDispose: undefined as number | undefined,
        pendingBeforeDispose: undefined as number | undefined,
      };
      childCleanupRecords.push(record);
      const h = (acquired = rendererFixture(ui.d.window.document));
      record.renderer = h;
      const initial = structuredClone(backupWorkspace);
      initial.tabs[0].expanded = [];
      h.setWorkspace(initial);
      const parent = {
        id: '1',
        key: 'SAMPLE-1',
        summary: 'Parent',
        type: 'Task',
        status: { id: 'open', name: 'Open', category: 'new' as const },
        priority: null,
        assignee: null,
        links: [],
      };
      const child = {
        ...parent,
        id: '2',
        key: 'SAMPLE-2',
        parentKey: parent.key,
      };
      let validations = 0,
        writes = 0,
        inserted = 0;
      h.forward(async (name) => {
        if (name !== 'canopy:createChild') throw Error(name);
        validations++;
        if (phase === 'validation') await held.promise;
        if (outcome === 'failure' && phase === 'validation')
          throw Error('validation refused');
        writes++;
        if (phase === 'provider') await held.promise;
        if (outcome === 'failure') throw Error('provider refused');
        return child;
      });
      const ast = sourceFile(
        process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
      );
      const dialog = findNode(
        ast,
        (n): n is ts.JsxSelfClosingElement =>
          ts.isJsxSelfClosingElement(n) &&
          n.tagName.getText() === 'CreateChildDialog',
      );
      const attr = (name: string) => {
        const prop = dialog.attributes.properties.find(
          (p) => ts.isJsxAttribute(p) && p.name.getText() === name,
        ) as ts.JsxAttribute;
        return (prop.initializer as ts.JsxExpression).expression!.getText();
      };
      const onCreated = execute(attr('onCreated'), {
        ...h.context,
        storeWorkspace: (_update: unknown) => {},
        childParent: {
          connectionId: 'sample-jira',
          tabId: backupWorkspace.tabs[0].id,
          issue: parent,
        },
        mutations: { insertCreated: () => inserted++ },
        setReveal() {},
        setChildParent() {},
      });
      let error = '',
        saving = false;
      const submit = execute(
        callback(sourceFile('src/renderer/CreateChildDialog.tsx'), 'submit'),
        {
          submitting: { current: false },
          createdUnknown: false,
          fields: {},
          summary: 'New child',
          description: '',
          assignee: null,
          priorityId: '',
          typeId: 'task',
          connectionId: 'sample-jira',
          parent,
          window: { canopy: h.api },
          trackMutation: execute(attr('trackMutation'), h.context),
          onCreated,
          setError: (value: string) => {
            error = value;
          },
          setSaving: (value: boolean) => {
            saving = value;
          },
          setCreatedUnknown() {},
        },
      );
      const creating = submit({ preventDefault() {} });
      await tick();
      assert.equal(validations, 1);
      assert.equal(saving, true);
      h.setWorkspace((current: any) => ({ ...current, theme: 'light' }));
      let finished = false;
      closing = h.api.flushWorkspace(70).then(() => {
        finished = true;
      });
      void closing.catch(() => {});
      await tick();
      assert.equal(finished, false);
      assert.equal(h.writes.length, 0);
      await assert.rejects(
        h.controller.track(async () => {}),
        /closing/,
      );
      await assert.rejects(
        h.api.createChild('sample-jira', parent.key, {
          typeId: 'task',
          summary: 'late',
        }),
        /closing/,
      );
      h.setWorkspace((current: any) => ({ ...current, theme: 'dark' }));
      if (outcome === 'timeout-release') h.release(70);
      await act(async () => held.release());
      await creating;
      assert.equal(saving, false);
      if (outcome === 'timeout-release') {
        await assert.rejects(closing, /canceled/);
        closing = undefined;
        assert.equal(h.writes.length, 0);
        await h.api.flushWorkspace(71);
      } else
        await assert.doesNotReject(
          closing,
          'failed child request must still allow closing',
        );
      const saved = h.writes.at(-1)!;
      assert.equal(saved.theme, 'light');
      assert.equal(inserted, outcome === 'failure' ? 0 : 1);
      assert.equal(
        writes,
        outcome === 'failure' && phase === 'validation' ? 0 : 1,
      );
      assert.equal(
        saved.tabs[0].selectedKey,
        outcome === 'failure' ? backupWorkspace.tabs[0].selectedKey : child.key,
      );
      assert.equal(
        saved.tabs[0].expanded.includes(parent.key),
        outcome === 'failure'
          ? initial.tabs[0].expanded.includes(parent.key)
          : true,
      );
      assert.equal((h.controller as any).pending.size, 0);
      if (outcome === 'failure') assert.match(error, /refused/);
    });

test('child acquisition cleanup sentinel', async () => {
  assert.equal(childCleanupRecords.length, 6);
  for (const record of childCleanupRecords) {
    assert.equal(
      record.host.textContent,
      '',
      'UI root unmounted even after renderer setup or teardown failure',
    );
    assert.equal(
      globalThis.window === record.previousWindow,
      true,
      'window restored',
    );
    assert.equal(
      globalThis.document === record.previousDocument,
      true,
      'document restored',
    );
    if (record.renderer) {
      assert.equal(
        record.ownerBeforeDispose,
        undefined,
        'close released before renderer disposal',
      );
      assert.equal(
        record.pendingBeforeDispose,
        0,
        'provider settled before renderer disposal',
      );
      assert.equal(
        record.renderer.controller.owner,
        undefined,
        'close ownership released',
      );
      assert.equal(
        (record.renderer.controller as any).pending.size,
        0,
        'held provider settled',
      );
      await assert.rejects(
        record.renderer.api.flushWorkspace(),
        /not ready to save/,
        'renderer flush subscription disposed',
      );
    }
  }
});

test('admitted child completion preserves queued workspace state in the React snapshot', () => {
  const ast = sourceFile(
    process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
  );
  const dialog = findNode(
    ast,
    (n): n is ts.JsxSelfClosingElement =>
      ts.isJsxSelfClosingElement(n) &&
      n.tagName.getText() === 'CreateChildDialog',
  );
  const prop = dialog.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onCreated',
  ) as ts.JsxAttribute;
  const workspaceRef = { current: structuredClone(backupWorkspace) };
  let state = structuredClone(backupWorkspace);
  state.tabs[0].expanded = [];
  workspaceRef.current.tabs[0].expanded = [];
  const queue: ((current: typeof state) => typeof state)[] = [
    (current) => ({
      ...current,
      theme: 'light',
      tabs: current.tabs.map((tab) => ({ ...tab, scrollTop: 333 })),
    }),
  ];
  const created = execute(
    (prop.initializer as ts.JsxExpression).expression!.getText(),
    {
      workspaceRef,
      storeWorkspace: (update: (current: typeof state) => typeof state) =>
        queue.push(update),
      childParent: {
        connectionId: 'sample-jira',
        tabId: state.tabs[0].id,
        issue: { key: 'SAMPLE-1' },
      },
      mutations: { insertCreated() {} },
      setReveal() {},
      setChildParent() {},
    },
  );
  created({ key: 'SAMPLE-2' });
  for (const update of queue) state = update(state);
  assert.equal(state.theme, 'light');
  assert.equal(state.tabs[0].scrollTop, 333);
  assert.equal(state.tabs[0].selectedKey, 'SAMPLE-2');
  assert.equal(state.tabs[0].expanded.includes('SAMPLE-1'), true);
  assert.equal(workspaceRef.current.tabs[0].selectedKey, 'SAMPLE-2');
});

for (const firstFails of [false, true])
  test(`reopened preview label writes serialize and persist the latest baseline: failure=${firstFails}`, async (t) => {
    const f = providerFixture();
    let ui: Awaited<ReturnType<typeof recoveryFixture>> | undefined;
    const first = gate(),
      second = gate();
    let closing: Promise<unknown> | undefined;
    t.after(async () => {
      try {
        await act(async () => {
          first.release();
          second.release();
        });
        await closing?.catch(() => {});
        if (f.h.controller.owner !== undefined)
          f.h.release(f.h.controller.owner);
      } finally {
        try {
          await ui?.close();
        } finally {
          f.dispose();
        }
      }
    });
    const applied: string[][] = [];
    f.h.forward(async (name, ...args) => {
      assert.equal(name, 'canopy:update');
      const labels = (args[2] as { labels: string[] }).labels;
      applied.push(labels);
      if (applied.length === 1) {
        await first.promise;
        if (firstFails) throw Error('first labels refused');
      } else await second.promise;
      return { ...f.issue, labels: labels.map((name) => ({ id: name, name })) };
    });
    const ast = sourceFile(
      process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
    );
    const preview = findNode(
      ast,
      (n): n is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'IssuePreview',
    );
    const prop = (name: string) => {
      const attr = preview.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText() === name,
      ) as ts.JsxAttribute;
      return (attr.initializer as ts.JsxExpression).expression!.getText();
    };
    const context = {
      ...f.h.context,
      mutations: f.mutations,
      previewRoute: { connectionId: 'sample-jira' },
      allRefreshTabs: [],
    };
    const editLabels = execute(prop('editLabels'), context);
    const onChanged = execute(prop('onChanged'), context);
    const trackMutation = execute(prop('trackMutation'), context);
    ui = await recoveryFixture();
    Object.assign(ui.d.window.canopy, f.h.api, {
      preview: async () => ({
        issue: { ...f.issue, labels: [] },
        description: '',
        comments: [],
        totalComments: 0,
      }),
      labels: async () => ['bug', 'urgent'].map((name) => ({ id: name, name })),
    });
    let reopen!: () => void;
    function Preview() {
      const [open, setOpen] = React.useState(true);
      reopen = () => setOpen(true);
      return open
        ? React.createElement(IssuePreview, {
            connectionId: 'sample-jira',
            provider: 'github',
            connectionName: 'Fixture',
            issueKey: f.issue.key,
            relationshipsLoading: false,
            width: 400,
            onWidth() {},
            onClose: () => setOpen(false),
            onChanged,
            editLabels,
            trackMutation,
            onAuthoringChanged() {},
            onPreview() {},
            onJump() {},
            onOpenExternal() {},
            onCopyKeySummary() {},
            onWorkBrief() {},
            onOpenComment() {},
            onRelationships() {},
            onMarkSeen() {},
          })
        : null;
    }
    await act(async () => ui!.root.render(React.createElement(Preview)));
    const host = ui.d.window.document.querySelector('#host') as HTMLElement;
    const click = async (label: string) =>
      act(async () => {
        const button = [...host.querySelectorAll('button')].find(
          (b) => b.textContent === label,
        )!;
        assert.ok(button, label);
        button.click();
      });
    const toggle = async (index: number) =>
      act(async () =>
        host
          .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
          [index].click(),
      );
    await click('Edit labels');
    await toggle(0);
    assert.deepEqual(applied, [['bug']]);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[title="Close preview (Escape)"]')!
        .click(),
    );
    assert.equal(host.textContent, '');
    await act(async () => reopen());
    await click('Edit labels');
    await toggle(1);
    assert.match(host.textContent!, /Saving labels/);
    assert.deepEqual(
      applied,
      [['bug']],
      'second provider write cannot overtake first response',
    );
    let finished = false;
    closing = f.h.api.flushWorkspace(81).then(() => {
      finished = true;
    });
    await tick();
    await assert.rejects(
      f.mutations.editLabels('sample-jira', f.issue.key, 'late', true, []),
      /closing/,
    );
    assert.equal(finished, false);
    await act(async () => second.release());
    assert.deepEqual(
      applied,
      [['bug']],
      'a ready second response cannot overtake the held first response',
    );
    assert.equal(finished, false);
    await act(async () => first.release());
    assert.deepEqual(
      applied,
      [['bug'], firstFails ? ['urgent'] : ['bug', 'urgent']],
      'already admitted second write drains while close is paused',
    );
    await assert.doesNotReject(closing);
    const saved = f.h.writes.at(-1)!;
    assert.deepEqual(
      saved.seenRoots!['sample-jira:SAMPLE-1'].issues['SAMPLE-1'].fields.Labels,
      firstFails ? ['urgent'] : ['bug', 'urgent'],
    );
    assert.deepEqual(
      f
        .view()
        .confirmedSnapshots[backupWorkspace.tabs[0].id].issues[0].labels?.map(
          (l) => l.name,
        ),
      firstFails ? ['urgent'] : ['bug', 'urgent'],
    );
    assert.equal(
      (f.mutations as any).queues.size,
      0,
      'queue tail removed after success or failure',
    );
    assert.equal((f.mutations as any).confirmedLabels.size, 0);
    assert.equal((f.h.controller as any).pending.size, 0);
  });

for (const disposed of [false, true])
  test(`unexpected handoff registration failure feedback respects disposal: disposed=${disposed}`, async () => {
    const f = await recoveryFixture(),
      pending = gate();
    let rejected = 0,
      receive!: (state: any) => void,
      calls = 0;
    Object.assign(f.d.window.canopy, {
      onHandoff: (fn: typeof receive) => {
        receive = fn;
        return () => {};
      },
      handoffReady: async () => {
        calls++;
        await pending.promise;
        throw Error('unexpected IPC failure');
      },
    });
    const declaration = findNode(
      sourceFile(
        process.env.CANOPY_HANDOFF_SOURCE ?? 'src/renderer/work-handoff.ts',
      ),
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.getText() === 'useWorkHandoff',
    );
    const hook = execute(
      `() => { ${declaration.getText().replace(/^export /, '')}; return useWorkHandoff; }`,
      {
        useRef: React.useRef,
        useState: React.useState,
        useEffect: React.useEffect,
        window: f.d.window,
        crypto: { randomUUID: () => 'owner' },
      },
    )();
    function Component() {
      hook(
        true,
        () => {},
        () => {
          rejected++;
        },
      );
      return null;
    }
    let closed = false;
    try {
      await act(async () => f.root.render(React.createElement(Component)));
      assert.equal(calls, 1);
      if (disposed) {
        await f.close();
        closed = true;
      }
      await act(async () => pending.release());
      assert.equal(
        rejected,
        disposed ? 0 : 1,
        'real failure is visible only to its live hook',
      );
      if (disposed) {
        receive({ session: '', closeSettled: true });
        await tick();
        assert.equal(
          calls,
          1,
          'late settled event cannot revive disposed hook',
        );
      }
    } finally {
      pending.release();
      if (!closed) await f.close();
    }
  });

test('Welcome workspace save banner dismisses only the save error', async () => {
  const f = await recoveryFixture();
  try {
    const ast = sourceFile(
      process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
    );
    const welcome = ast
      .getText()
      .indexOf('        {!activeTab && !activeSavedView');
    assert.ok(welcome > 0);
    const banner = findNode(
      ast,
      (node): node is ts.JsxElement =>
        ts.isJsxElement(node) &&
        node.getStart() > welcome &&
        node.openingElement.tagName.getText() === 'div' &&
        node.openingElement.attributes.getText().includes('error-banner'),
    );
    const renderBanner = execute(
      `(errors, setErrors) => (${banner.getText()})`,
      {
        __jsx: React.createElement,
        AlertCircle: () => null,
        X: () => null,
      },
    );
    function View() {
      const [errors, setErrors] = React.useState({
        workspace: 'Couldn’t save workspace: disk refused',
        app: 'Demo could not open',
      });
      return React.createElement(
        'main',
        null,
        errors.workspace ? renderBanner(errors, setErrors) : null,
        React.createElement('p', { role: 'alert' }, errors.app),
      );
    }
    await act(async () => f.root.render(React.createElement(View)));
    const host = f.d.window.document.querySelector('#host')!;
    const alert = host.querySelector('.error-banner')!;
    assert.equal(alert.getAttribute('role'), 'alert');
    assert.match(alert.textContent!, /Couldn’t save workspace: disk refused/);
    const dismiss = alert.querySelector(
      '[aria-label="Dismiss workspace save error"]',
    ) as HTMLButtonElement;
    assert.ok(dismiss, 'Welcome error exposes its existing dismiss action');
    await act(async () => dismiss.click());
    assert.equal(
      host.querySelector('.error-banner'),
      null,
      'save error dismissed',
    );
    assert.equal(
      host.querySelector('[role=alert]')!.textContent,
      'Demo could not open',
      'unrelated app error retained',
    );
  } finally {
    await f.close();
  }
});

for (const barrier of ['close', 'transfer'])
  test(`label intent admission refusal leaves no queue state and permits recovery: ${barrier}`, async (t) => {
    const f = providerFixture();
    t.after(() => {
      if (f.h.controller.owner !== undefined) f.h.release(f.h.controller.owner);
      f.h.controller.endTransfer();
      f.dispose();
    });
    let calls = 0;
    f.h.forward(async (_name, _connection, key, patch) => {
      calls++;
      return {
        ...f.issue,
        key,
        labels: (patch as { labels: string[] }).labels.map((name) => ({
          id: name,
          name,
        })),
      };
    });
    if (barrier === 'close') await f.h.api.flushWorkspace(82);
    else f.h.controller.beginTransfer(f.d.window.document);
    await assert.rejects(
      f.mutations.editLabels('sample-jira', f.issue.key, 'bug', true, []),
      new RegExp(barrier === 'close' ? 'closing' : 'transfer'),
    );
    assert.equal(calls, 0);
    assert.equal((f.mutations as any).queues.size, 0);
    assert.equal((f.mutations as any).confirmedLabels.size, 0);
    if (barrier === 'close') {
      f.h.release(81);
      await assert.rejects(
        f.mutations.editLabels('sample-jira', f.issue.key, 'bug', true, []),
        /closing/,
      );
      f.h.release(82);
    } else f.h.controller.endTransfer();
    await f.mutations.editLabels(
      'sample-jira',
      f.issue.key,
      'urgent',
      true,
      [],
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      f
        .view()
        .confirmedSnapshots[backupWorkspace.tabs[0].id].issues[0].labels?.map(
          (label) => label.name,
        ),
      ['urgent'],
    );
    assert.equal((f.mutations as any).queues.size, 0);
    assert.equal((f.mutations as any).confirmedLabels.size, 0);
  });

for (const timing of ['overlap', 'settled'])
  for (const owned of [false, true])
    for (const firstFails of [false, true])
      for (const mode of ['normal', 'late-preview', 'second-failure'])
        if (
          mode === 'normal' ||
          (!owned &&
            !firstFails &&
            (mode !== 'late-preview' || timing === 'settled'))
        )
          test(`stale reopened preview preserves confirmed labels after queue drain: timing=${timing}, owned=${owned}, failure=${firstFails}, mode=${mode}`, async (t) => {
            const f = providerFixture();
            if (!owned) f.mutations.forget(backupWorkspace.tabs[0].id);
            let ui: Awaited<ReturnType<typeof recoveryFixture>> | undefined;
            const first = gate(),
              second = gate(),
              previewRead = gate();
            let closing: Promise<unknown> | undefined;
            t.after(async () => {
              try {
                await act(async () => {
                  first.release();
                  second.release();
                  previewRead.release();
                });
                await closing?.catch(() => {});
                if (f.h.controller.owner !== undefined)
                  f.h.release(f.h.controller.owner);
              } finally {
                try {
                  await ui?.close();
                } finally {
                  f.dispose();
                }
              }
            });
            const applied: string[][] = [];
            f.h.forward(async (name, ...args) => {
              assert.equal(name, 'canopy:update');
              const labels = (args[2] as { labels: string[] }).labels;
              applied.push(labels);
              if (applied.length === 1) {
                await first.promise;
                if (firstFails) throw Error('first labels refused');
              } else {
                await second.promise;
                if (mode === 'second-failure')
                  throw Error('second labels refused');
              }
              return {
                ...f.issue,
                labels: labels.map((name) => ({ id: name, name })),
              };
            });
            const ast = sourceFile(
              process.env.CANOPY_CLOSE_RENDERER_SOURCE ??
                'src/renderer/App.tsx',
            );
            const preview = findNode(
              ast,
              (n): n is ts.JsxSelfClosingElement =>
                ts.isJsxSelfClosingElement(n) &&
                n.tagName.getText() === 'IssuePreview',
            );
            const prop = (name: string) => {
              const attr = preview.attributes.properties.find(
                (p) => ts.isJsxAttribute(p) && p.name.getText() === name,
              ) as ts.JsxAttribute;
              return (
                attr.initializer as ts.JsxExpression
              ).expression!.getText();
            };
            const context = {
              ...f.h.context,
              mutations: f.mutations,
              previewRoute: { connectionId: 'sample-jira' },
              allRefreshTabs: [],
            };
            const editLabels = execute(prop('editLabels'), context);
            const subscribeLabels = execute(prop('subscribeLabels'), context);
            const onChanged = execute(prop('onChanged'), context);
            const trackMutation = execute(prop('trackMutation'), context);
            ui = await recoveryFixture();
            let previewReads = 0;
            Object.assign(ui.d.window.canopy, f.h.api, {
              preview: async () => {
                previewReads++;
                if (mode === 'late-preview' && previewReads === 2)
                  await previewRead.promise;
                return {
                  issue: { ...f.issue, labels: [] },
                  description: '',
                  comments: [],
                  totalComments: 0,
                };
              },
              labels: async () =>
                ['bug', 'urgent'].map((name) => ({ id: name, name })),
            });
            let reopen!: () => void;
            function Preview() {
              const [open, setOpen] = React.useState(true);
              reopen = () => setOpen(true);
              return open
                ? React.createElement(IssuePreview, {
                    connectionId: 'sample-jira',
                    provider: 'github',
                    connectionName: 'Fixture',
                    issueKey: f.issue.key,
                    relationshipsLoading: false,
                    width: 400,
                    onWidth() {},
                    onClose: () => setOpen(false),
                    onChanged,
                    editLabels,
                    subscribeLabels,
                    trackMutation,
                    onAuthoringChanged() {},
                    onPreview() {},
                    onJump() {},
                    onOpenExternal() {},
                    onCopyKeySummary() {},
                    onWorkBrief() {},
                    onOpenComment() {},
                    onRelationships() {},
                    onMarkSeen() {},
                  })
                : null;
            }
            await act(async () =>
              ui!.root.render(React.createElement(Preview)),
            );
            const host = ui.d.window.document.querySelector(
              '#host',
            ) as HTMLElement;
            const click = async (label: string) =>
              act(async () => {
                const button = [...host.querySelectorAll('button')].find(
                  (b) => b.textContent === label,
                )!;
                assert.ok(button, label);
                button.click();
              });
            const toggle = async (index: number) =>
              act(async () =>
                host
                  .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
                  [index].click(),
              );
            await click('Edit labels');
            await toggle(0);
            assert.deepEqual(applied, [['bug']]);
            await act(async () =>
              host
                .querySelector<HTMLButtonElement>(
                  '[title="Close preview (Escape)"]',
                )!
                .click(),
            );
            assert.equal(host.textContent, '');
            await act(async () => reopen());
            if (mode === 'late-preview') {
              await act(async () => first.release());
              await act(async () => previewRead.release());
            }
            await click('Edit labels');
            // Preview fetched [] while the original write was still pending.
            if (timing === 'settled') {
              await act(async () => first.release());
              await tick();
              assert.equal((f.mutations as any).queues.size, 0);
              assert.equal((f.mutations as any).confirmedLabels.size, 0);
            }
            await toggle(1);
            if (timing === 'overlap') {
              assert.deepEqual(applied, [['bug']]);
              await act(async () => first.release());
            }
            assert.equal(
              host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]
                .checked,
              true,
              'Pending intent stays visible while another preview confirms',
            );
            await act(async () => second.release());
            if (mode === 'second-failure') {
              assert.equal(
                host.querySelectorAll<HTMLInputElement>(
                  'input[type=checkbox]',
                )[0].checked,
                true,
                'Rollback keeps the successful label from the detached preview',
              );
              assert.equal(
                host.querySelectorAll<HTMLInputElement>(
                  'input[type=checkbox]',
                )[1].checked,
                false,
              );
              assert.match(host.textContent!, /Labels were not saved/);
            }
            assert.deepEqual(
              applied,
              [['bug'], firstFails ? ['urgent'] : ['bug', 'urgent']],
              'a stale open preview must preserve the confirmed first label after queue cleanup',
            );
          });
