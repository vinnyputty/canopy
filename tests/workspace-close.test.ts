import { removeConnection } from '../src/renderer/workspace';
import {
  forgetSidebarConnections,
  emptySidebarSession,
} from '../src/renderer/sidebar-organization';
import { workspaceError } from '../src/renderer/workspace-error';
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
  let recoveryOpen = true;
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(WorkspaceLoadRecovery, {
          error: 'Could not read saved workspace.',
          open: recoveryOpen,
          onOpenChange: (open: boolean) => {
            recoveryOpen = open;
            void render();
          },
        }),
      ),
    );
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

test('failed-load recovery renders disclosure, supports Keep open/Escape, reports failed reload and retries explicitly', async () => {
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
  for (const failure of ['read', 'hydrate', 'unmounted', 'unmounted-read']) {
    const d = dom();
    const h = rendererFixture(d.window.document);
    const retained = {
      ...structuredClone(backupWorkspace),
      theme: 'dark' as const,
    };
    h.workspaceRef.current = retained;
    h.context.workspaceLoaded.current = true;
    const reading = gate();
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
          workspaceInitialized: async () => {},
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
    if (failure === 'read' || failure === 'unmounted-read')
      reading.reject(Error('read failed'));
    else reading.release();
    await tick();
    assert.equal(h.context.workspaceLoaded.current, false);
    assert.equal(h.workspaceRef.current, retained);
    assert.equal(h.writes.length, 0);
    if (failure.startsWith('unmounted')) {
      assert.equal(error, null);
      assert.equal(ready, false);
    } else {
      assert.match(error!, /failed/);
      assert.equal(ready, true);
    }
    assert.equal(hydrated, false);
    cleanup();
    const next = {
      ...context,
      migrateViews,
      window: {
        canopy: {
          ...context.window.canopy,
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
  const ast = sourceFile('src/renderer/App.tsx');
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
      saving.release();
      await accepted;
      await closing;
    });
    assert.equal(
      f.d.window.document.querySelector('#host')!.textContent,
      'light',
      'an accepted appearance save commits its React state while the snapshot waits',
    );
    assert.equal(h.writes.at(-1)?.theme, 'light');
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
    assert.match(
      savedError.textContent!,
      /Couldn’t save workspace: Could not write saved workspace/,
    );
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
        outcome === 'failure'
          ? assert.rejects(closing, /disconnect failed/)
          : outcome === 'keep-open'
            ? assert.rejects(closing, /canceled/)
            : closing;
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
        assert.equal(h.writes.length, 0);
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
