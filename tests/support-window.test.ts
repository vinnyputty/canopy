import { recoverWorkspaceViews } from '../src/shared/views';
import type { Workspace } from '../src/shared/types';
import { rendererFixture } from './fixtures/workspace-close';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { transformSync } from 'esbuild';
import { WorkHandoffQueue } from '../src/main/work-handoff';
import { restoreWindow, type WindowState } from '../src/main/window-state';
import { WindowStateSaver } from '../src/main/window-state-saver';
import { validateWorkspace } from '../src/shared/workspace-validation';
import { WorkspaceTransfer } from '../src/main/workspace-transfer';
import { supportLinks, supportUrl } from '../src/shared/support';

const require = createRequire(import.meta.url);
const main = transformSync(
  readFileSync(
    process.env.CANOPY_WINDOW_MAIN_SOURCE ?? 'src/main/app.ts',
    'utf8',
  ),
  {
    loader: 'ts',
    format: 'cjs',
  },
).code;
function gate() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const wait = new Promise<void>((resolve, rejectWait) => {
    release = resolve;
    reject = rejectWait;
  });
  return { wait, release, reject };
}

// Execute the real main-process module with in-memory Electron/storage doubles.
// No desktop process, credentials, files, or OS clipboard are used.
async function fixture() {
  let readGate = gate();
  let loadGate = gate();
  let reads = 0;
  const windows: FakeWindow[] = [];
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  let template: any[] = [];
  const errors: string[] = [];
  const closeErrors: unknown[][] = [];
  const writes: { name: string; value: any }[] = [];
  const controls = {
    flush: async (_script: string) => {},
    release: (_attempt: number) => {},
    reload: () => {},
    onClosed: () => {},
    warning: async () => {},
    write: async (_name: string) => {},
    crashed: false,
    consent: 0,
    prompts: 0,
    reportHandlers: 0,
    messageWindows: [] as unknown[],
    warnings: [] as {
      type?: string;
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    }[],
    readWorkspace: async (): Promise<Workspace | null> => null,
    quits: 0,
    expireClose: () => {},
    saved: null as WindowState | null,
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setName() {},
    requestSingleInstanceLock: () => true,
    focus() {},
    getPath: () => '/sample',
    getVersion: () => '0.1.0',
    whenReady: () => Promise.resolve(),
    quit() {
      controls.quits++;
      app.emit('before-quit');
      for (const window of windows) if (!window.destroyed) window.close();
    },
  });
  class FakeWindow extends EventEmitter {
    destroyed = false;
    focused = 0;
    shown = true;
    initiallyShown = true;
    maximized = false;
    presentation: string[] = [];
    bounds = { x: 0, y: 0, width: 1000, height: 700 };
    messages: string[] = [];
    handoffStates: any[] = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      isCrashed: () => controls.crashed,
      reload: () => controls.reload(),
      executeJavaScript: (script: string) => controls.flush(script),
      getURL: () => this.webContents.mainFrame.url,
      session: { setPermissionRequestHandler() {} },
      setWindowOpenHandler() {},
      send: (channel: string, state: unknown) => {
        this.messages.push(channel);
        if (channel === 'canopy:workspaceCloseReleased')
          controls.release(state as number);
        if (channel === 'canopy:handoff') this.handoffStates.push(state);
      },
    });
    constructor(options: any) {
      super();
      this.shown = options.show !== false;
      this.initiallyShown = this.shown;
      this.bounds = {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width,
        height: options.height,
      };
      windows.push(this);
    }
    async loadFile(path: string) {
      this.webContents.emit('did-start-loading');
      this.webContents.mainFrame.url = pathToFileURL(path).href;
      await loadGate.wait;
    }
    destroy() {
      controls.onClosed();
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    isMaximized() {
      return this.maximized;
    }
    maximize() {
      this.presentation.push('maximize');
      this.maximized = true;
      this.emit('maximize');
    }
    getNormalBounds() {
      return this.bounds;
    }
    restore() {}
    isVisible() {
      return this.shown;
    }
    show() {
      if (this.shown && this.maximized)
        this.bounds = { x: 0, y: 0, width: 1600, height: 1000 };
      this.presentation.push('show');
      this.shown = true;
    }
    focus() {
      this.focused++;
    }
    close() {
      let prevented = false;
      this.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) {
        controls.onClosed();
        this.destroyed = true;
        this.webContents.emit('destroyed');
        this.emit('closed');
      }
    }
  }
  class Storage {
    async read(name: string) {
      if (name === 'workspace') return controls.readWorkspace();
      assert.equal(name, 'window');
      reads++;
      await readGate.wait;
      return controls.saved;
    }
    async replaceWorkspace(
      expected: Workspace,
      next: Workspace,
      validate?: () => void,
    ) {
      validate?.();
      assert.deepEqual(await controls.readWorkspace(), expected);
      controls.readWorkspace = async () => structuredClone(next);
      writes.push({ name: 'workspace', value: structuredClone(next) });
    }
    async write(name: string, value: unknown) {
      await controls.write(name);
      writes.push({ name, value: structuredClone(value) });
    }
  }
  const module = { exports: {} as { launch: () => void } };
  runInNewContext(main, {
    module,
    exports: module.exports,
    __dirname: '/sample/dist',
    process: { platform: 'darwin', env: {} },
    console: {
      ...console,
      error: (...args: unknown[]) => closeErrors.push(args),
    },
    structuredClone,
    URL,
    AbortController,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      if (ms === 15_000)
        controls.expireClose = () => {
          clearTimeout(timer);
          callback();
        };
      return timer;
    },
    clearTimeout,
    require(name: string) {
      if (name.startsWith('node:')) return require(name);
      if (name === 'electron')
        return {
          app,
          BrowserWindow: FakeWindow,
          ipcMain: {
            handle: (
              channel: string,
              fn: (event: unknown, ...args: unknown[]) => unknown,
            ) => handlers.set(channel, fn),
          },
          Menu: {
            buildFromTemplate: (items: any[]) => items,
            setApplicationMenu: (items: any[]) => {
              template = items;
            },
          },
          screen: {
            getAllDisplays: () => [
              { workArea: { x: 0, y: 0, width: 1600, height: 1000 } },
            ],
          },
          shell: {},
          dialog: {
            showMessageBox: (
              window: unknown,
              options: (typeof controls.warnings)[number],
            ) => {
              controls.warnings.push(options);
              controls.messageWindows.push(window);
              controls.prompts++;
              const reported = controls
                .warning()
                .then(() => ({ response: controls.consent }));
              const catchReport = reported.catch.bind(reported);
              void catchReport(() => {});
              reported.catch = ((...args: Parameters<typeof catchReport>) => {
                controls.reportHandlers++;
                return catchReport(...args);
              }) as typeof reported.catch;
              return reported;
            },
            showErrorBox: (_title: string, message: string) =>
              errors.push(message),
          },
        };
      if (name === '../shared/views') return { recoverWorkspaceViews };
      if (name === '../shared/workspace-validation')
        return { validateWorkspace };
      if (name === '../shared/support') return { supportLinks, supportUrl };
      if (name === './work-handoff') return { WorkHandoffQueue };
      if (name === './window-state-saver') return { WindowStateSaver };
      if (name === './workspace-transfer') return { WorkspaceTransfer };
      if (name === './storage') return { Storage };
      if (name === './auth')
        return {
          Auth: class {
            async load() {}
            connections() {
              return [];
            }
          },
        };
      if (name === './providers') return { Providers: class {} };
      if (name === './updates')
        return {
          Updates: class {
            cancel() {}
          },
        };
      if (name === './credentials')
        return { configureLinuxCredentialStore() {} };
      if (name === './window-state') return { restoreWindow };
      if (name === './demo') return { demoWorkspace: {} };
      return {};
    },
  });
  module.exports.launch();
  await setImmediate();
  assert.deepEqual(errors, []);
  return {
    app,
    controls,
    writes,
    closeErrors,
    windows,
    handlers,
    errors,
    get template() {
      return template;
    },
    get reads() {
      return reads;
    },
    releaseRead: () => readGate.release(),
    releaseLoad: () => loadGate.release(),
    rejectLoad: () => loadGate.reject(new Error('Renderer load failed')),
    hold: () => {
      readGate = gate();
      loadGate = gate();
    },
    invoke(window: FakeWindow, name: string, ...args: unknown[]) {
      return handlers.get(`canopy:${name}`)!(
        {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame,
        },
        ...args,
      );
    },
    about() {
      template
        .find((item) => item.label === 'Canopy')
        .submenu.find((item: any) => item.label === 'About Canopy')
        .click();
    },
  };
}

it('shares held creation across activation and repeated About requests until subscription', async () => {
  const f = await fixture();
  f.about();
  f.app.emit('activate');
  f.about();
  f.about();
  await setImmediate();
  assert.equal(f.reads, 1);
  assert.equal(f.windows.length, 0);
  f.releaseRead();
  await setImmediate();
  assert.equal(f.windows.length, 1);
  const window = f.windows[0];
  f.about();
  f.app.emit('activate');
  assert.deepEqual(window.messages, []);
  f.invoke(window, 'supportReady');
  assert.deepEqual(window.messages, ['canopy:showSupport']);
  f.releaseLoad();
  await setImmediate();
  assert.equal(f.windows.length, 1);
  assert.deepEqual(window.messages, ['canopy:showSupport']);
  assert.equal(f.invoke(window, 'appVersion'), '0.1.0');
  assert.deepEqual(f.errors, []);
});

it('retains an About request during ordinary loading until the renderer subscribes', async () => {
  const f = await fixture();
  f.releaseRead();
  await setImmediate();
  const window = f.windows[0];
  f.about();
  f.about();
  f.releaseLoad();
  await setImmediate();
  assert.deepEqual(window.messages, []);
  f.invoke(window, 'supportReady');
  assert.deepEqual(window.messages, ['canopy:showSupport']);
  assert.deepEqual(f.errors, []);
});

it('keeps the replacement authoritative when an old closed callback fires', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const old = f.windows[0];
  f.invoke(old, 'supportReady');
  old.close();
  await setImmediate();
  f.hold();
  f.app.emit('activate');
  f.about();
  f.about();
  await setImmediate();
  assert.equal(f.reads, 2);
  assert.equal(f.windows.length, 1);
  f.releaseRead();
  await setImmediate();
  const replacement = f.windows[1];
  old.emit('closed');
  assert.equal(f.invoke(replacement, 'appVersion'), '0.1.0');
  assert.throws(
    () => f.invoke(old, 'supportReady'),
    /Untrusted application window/,
  );
  f.invoke(replacement, 'supportReady');
  f.releaseLoad();
  await setImmediate();
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows.filter((window) => !window.destroyed).length, 1);
  assert.deepEqual(replacement.messages, ['canopy:showSupport']);
  assert.deepEqual(f.errors, []);
});

it('waits for the new subscription when About is requested during a reload', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.invoke(window, 'supportReady');
  window.webContents.emit('did-start-loading');
  f.about();
  await setImmediate();
  assert.deepEqual(window.messages, []);
  f.invoke(window, 'supportReady');
  assert.deepEqual(window.messages, ['canopy:showSupport']);
});

it('disposes a failed About window and retries activation with the queued request', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  f.windows[0].close();
  await setImmediate();
  f.hold();
  f.about();
  f.releaseRead();
  await setImmediate();
  const failed = f.windows[1];
  f.rejectLoad();
  await setImmediate();
  assert.equal(failed.destroyed, true);
  assert.equal(f.windows.filter((window) => !window.destroyed).length, 0);
  assert.deepEqual(f.errors, ['Renderer load failed']);
  assert.deepEqual(failed.messages, []);
  assert.throws(
    () => f.invoke(failed, 'supportReady'),
    /Untrusted application window/,
  );
  f.hold();
  f.app.emit('activate');
  f.app.emit('activate');
  await setImmediate();
  assert.equal(f.reads, 3);
  f.releaseRead();
  await setImmediate();
  const replacement = f.windows[2];
  failed.emit('closed');
  f.releaseLoad();
  await setImmediate();
  assert.deepEqual(replacement.messages, []);
  f.invoke(replacement, 'supportReady');
  assert.deepEqual(replacement.messages, ['canopy:showSupport']);
  f.about();
  await setImmediate();
  assert.deepEqual(replacement.messages, [
    'canopy:showSupport',
    'canopy:showSupport',
  ]);
  assert.equal(f.windows.length, 3);
  assert.equal(f.windows.filter((window) => !window.destroyed).length, 1);
  assert.deepEqual(f.errors, ['Renderer load failed']);
});

it('waits for renderer and final bounds writes before duplicate-launch recreation', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const old = f.windows[0];
  const renderer = gate();
  f.controls.flush = () => renderer.wait;
  const focuses = old.focused;
  old.close();
  f.app.emit('activate');
  await setImmediate();
  assert.equal(old.focused, focuses);
  assert.equal(old.destroyed, false);
  assert.equal(f.windows.length, 1);
  const bounds = gate();
  f.controls.write = async (name) => {
    if (name === 'window') await bounds.wait;
  };
  old.bounds = { x: 30, y: 40, width: 1200, height: 800 };
  old.emit('move');
  renderer.release();
  await setImmediate();
  assert.equal(old.destroyed, false);
  assert.equal(f.windows.length, 1);
  bounds.release();
  await setImmediate();
  assert.equal(old.destroyed, true);
  assert.equal(f.windows.length, 2);
  assert.ok(f.windows[1].focused > 0);
  assert.deepEqual(f.writes.at(-1)?.value.bounds, old.bounds);
  assert.deepEqual(f.closeErrors, []);
});

it('a refused save releases queued focus and its close listener, then permits retry', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const initialListeners = window.listenerCount('closed');
  const renderer = gate();
  f.controls.flush = () => renderer.wait;
  window.close();
  f.app.emit('activate');
  const focuses = window.focused;
  renderer.reject(new Error('workspace save rejected'));
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.windows.length, 1);
  assert.ok(window.focused > focuses);
  assert.equal(window.listenerCount('closed'), initialListeners);
  assert.equal(f.controls.prompts, 0);
  assert.equal(f.closeErrors.length, 1);
  f.controls.flush = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
});

it('unavailable renderer save failures require consent and can retry received workspace', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const workspace = {
    tabs: [],
    theme: 'system',
    shortcuts: {},
    sidebarCollapsed: false,
  };
  f.controls.write = async (name) => {
    if (name === 'workspace') throw new Error('disk failure');
  };
  await assert.rejects(
    Promise.resolve(f.invoke(window, 'saveWorkspace', workspace)),
    /disk failure/,
  );
  f.controls.crashed = true;
  window.close();
  f.app.emit('activate');
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.prompts, 1);
  f.controls.write = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.deepEqual(
    f.writes.filter((write) => write.name === 'workspace').at(-1)?.value,
    workspace,
  );
});

it('unavailable renderer closes after explicit consent to abandon failed writes', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const workspace = {
    tabs: [],
    theme: 'system',
    shortcuts: {},
    sidebarCollapsed: false,
  };
  f.controls.write = async (name) => {
    if (name === 'workspace') throw new Error('disk failure');
  };
  await assert.rejects(
    Promise.resolve(f.invoke(window, 'saveWorkspace', workspace)),
    /disk failure/,
  );
  f.controls.crashed = true;
  f.controls.consent = 1;
  window.close();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(window.destroyed, true);
});

it('close deadline refusal removes temporary renderer listeners and ignores late completion', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const renderer = gate();
  f.controls.flush = () => renderer.wait;
  const listeners = window.webContents.listenerCount('render-process-gone');
  window.close();
  await setImmediate();
  assert.equal(
    window.webContents.listenerCount('render-process-gone'),
    listeners + 1,
  );
  f.controls.expireClose();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.prompts, 1);
  assert.equal(
    window.webContents.listenerCount('render-process-gone'),
    listeners,
  );
  renderer.release();
  await setImmediate();
  assert.equal(window.destroyed, false);
  f.controls.flush = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
});

it('quit waits for workspace and final bounds before approving the native close', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const renderer = gate();
  f.controls.flush = () => renderer.wait;
  const window = f.windows[0];
  f.app.quit();
  f.app.emit('activate');
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.quits, 1);
  renderer.release();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(f.controls.quits, 2);
  assert.equal(f.windows.length, 1);
  assert.deepEqual(f.writes.at(-1)?.value.bounds, window.bounds);
});

it('saved maximized windows receive maximize before show and retain normal bounds', async () => {
  const f = await fixture();
  f.controls.saved = {
    bounds: { x: 30, y: 40, width: 1126, height: 723 },
    maximized: true,
  };
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  assert.equal(window.maximized, true);
  assert.equal(window.initiallyShown, false);
  assert.deepEqual(window.presentation, ['maximize', 'show']);
  f.app.emit('activate');
  f.about();
  await setImmediate();
  assert.deepEqual(window.presentation, ['maximize', 'show']);
  assert.ok(window.focused >= 3);
  window.shown = false;
  f.about();
  await setImmediate();
  assert.deepEqual(window.presentation, ['maximize', 'show', 'show']);
  assert.equal(window.shown, true);
  window.close();
  await setImmediate();
  assert.deepEqual(f.writes.at(-1)?.value, f.controls.saved);
  assert.equal(window.destroyed, true);
});

for (const mode of ['close', 'quit'])
  it(`a refused ${mode} restores handoff delivery to the surviving renderer session`, async () => {
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    const first = f.invoke(
      window,
      'handoffReady',
      '11111111-1111-4111-8111-111111111111',
    ) as { session: string };
    const send = (view: string) =>
      f.app.emit('second-instance', {}, [], '/ignored', {
        canopyMode: 'main',
        canopyArguments: [
          '--canopy-open',
          `canopy://handoff/view?view=${view}`,
        ],
      });
    send('old');
    const old = window.handoffStates.at(-1).delivery;
    const renderer = gate();
    f.controls.flush = () => renderer.wait;
    if (mode === 'quit') f.app.quit();
    else window.close();
    send('during-close');
    await setImmediate();
    assert.equal(window.handoffStates.at(-1).canceledId, old.id);
    assert.equal(
      f.invoke(window, 'handoffAck', first.session, old.id, 'opened'),
      false,
    );
    assert.throws(
      () =>
        f.invoke(
          window,
          'handoffReady',
          '11111111-1111-4111-8111-111111111111',
        ),
      /closing/,
    );
    renderer.reject(new Error('save refused quit'));
    await setImmediate();
    assert.equal(window.destroyed, false);
    assert.equal(f.windows.length, 1);
    const resumed = window.handoffStates.at(-1);
    assert.equal(resumed.session, first.session);
    assert.deepEqual(resumed.delivery.intent, {
      kind: 'view',
      view: 'during-close',
    });
    assert.equal(
      f.invoke(
        window,
        'handoffAck',
        resumed.session,
        resumed.delivery.id,
        'opened',
      ),
      true,
    );
    send('after-refusal');
    assert.deepEqual(window.handoffStates.at(-1).delivery.intent, {
      kind: 'view',
      view: 'after-refusal',
    });
    f.app.emit('will-quit');
    assert.throws(
      () =>
        f.invoke(
          window,
          'handoffReady',
          '11111111-1111-4111-8111-111111111111',
        ),
      /closing/,
    );
  });

it('a refused close restores bounds debouncing for the surviving window', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.controls.flush = async () => {
    throw new Error('save refused');
  };
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, false);
  const writes = f.writes.length;
  for (let x = 1; x <= 50; x++) {
    window.bounds.x = x;
    window.emit('move');
  }
  await setImmediate();
  assert.equal(f.writes.length, writes);
  context.mock.timers.tick(199);
  await setImmediate();
  assert.equal(f.writes.length, writes);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.writes.at(-1)?.value.bounds.x, 50);
  f.controls.flush = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
});

it('a timed-out close cannot drain bounds after Keep open restores debouncing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const renderer = gate();
  f.controls.flush = () => renderer.wait;
  context.after(async () => {
    renderer.release();
    f.controls.flush = async () => {};
    window.close();
    await setImmediate();
  });
  window.close();
  await setImmediate();
  f.controls.expireClose();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(window.destroyed, false);
  const writes = f.writes.length;
  window.bounds.x = 73;
  window.emit('move');
  renderer.release();
  await setImmediate();
  assert.equal(
    f.writes.length,
    writes,
    'abandoned close must leave the pending bounds debounce intact',
  );
  context.mock.timers.tick(199);
  await setImmediate();
  assert.equal(f.writes.length, writes);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.writes.at(-1)?.value.bounds.x, 73);
  window.bounds.x = 74;
  window.emit('move');
  await setImmediate();
  assert.equal(
    f.writes.length,
    writes + 1,
    'late renderer settlement must not leave the saver flushing',
  );
  context.mock.timers.tick(200);
  await setImmediate();
  assert.equal(f.writes.length, writes + 2);
  assert.equal(f.writes.at(-1)?.value.bounds.x, 74);
  assert.equal(window.destroyed, false);
  f.controls.flush = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
});

it('an abandoned renderer completion cannot drain bounds or approve a newer close', async (context) => {
  const flush = WindowStateSaver.prototype.flush;
  let drains = 0;
  context.mock.method(
    WindowStateSaver.prototype,
    'flush',
    function (this: WindowStateSaver) {
      drains++;
      return flush.call(this);
    },
  );
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const abandoned = gate();
  f.controls.flush = () => abandoned.wait;
  window.close();
  await setImmediate();
  assert.equal(drains, 1);
  f.controls.expireClose();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  const current = gate();
  context.after(async () => {
    abandoned.release();
    current.release();
    await setImmediate();
  });
  f.controls.flush = () => current.wait;
  window.close();
  await setImmediate();
  assert.equal(drains, 2);
  const writes = f.writes.length;
  abandoned.release();
  await setImmediate();
  assert.equal(drains, 2, 'only the current close owns a final bounds drain');
  assert.equal(f.writes.length, writes);
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.prompts, 1);
  assert.equal(f.controls.quits, 0);
  assert.throws(
    () =>
      f.invoke(window, 'handoffReady', '11111111-1111-4111-8111-111111111111'),
    /closing/,
  );
  current.release();
  await setImmediate();
  assert.equal(
    drains,
    3,
    'the current close still drains final bounds after its own renderer settles',
  );
  assert.equal(window.destroyed, true);
  assert.equal(f.controls.prompts, 1);
});

it('the final bounds gap preserves pre-pause edits and rejects later mutations until close', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0],
    bounds = gate();
  const renderer = rendererFixture(dom.window.document, async (value) => {
    await f.invoke(window, 'saveWorkspace', value);
  });
  f.controls.flush = (script) => renderer.executeScript(script);
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  f.controls.onClosed = () => {
    assert.equal(renderer.controller.paused, true);
  };
  f.controls.write = async (name) => {
    if (name === 'window') await bounds.wait;
  };
  renderer.setWorkspace((current: any) => ({ ...current, theme: 'light' }));
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(renderer.controller.paused, true);
  assert.equal(dom.window.document.body.inert, true);
  renderer.setWorkspace((current: any) => ({ ...current, theme: 'dark' }));
  await assert.rejects(
    renderer.api.saveWorkspace({
      ...renderer.workspaceRef.current,
      theme: 'dark',
    }),
    /closing/,
  );
  assert.equal(renderer.workspaceRef.current.theme, 'light');
  bounds.release();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(
    f.writes.filter((write) => write.name === 'workspace').at(-1)?.value.theme,
    'light',
  );
  assert.equal(f.controls.prompts, 0);
  dom.window.close();
});

it('Keep open restores input and stale snapshot completion cannot pause or approve a retry', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0],
    saving = gate();
  let first = true;
  const renderer = rendererFixture(dom.window.document, async (value) => {
    if (first) {
      first = false;
      await saving.wait;
    }
    await f.invoke(window, 'saveWorkspace', value);
  });
  f.controls.flush = (script) => renderer.executeScript(script);
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  window.close();
  await setImmediate();
  assert.equal(renderer.controller.paused, true);
  f.controls.expireClose();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(renderer.controller.paused, false);
  assert.equal(dom.window.document.body.inert, false);
  renderer.setWorkspace((current: any) => ({ ...current, theme: 'light' }));
  window.close();
  await setImmediate();
  assert.equal(renderer.controller.owner, 2);
  saving.release();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(f.controls.prompts, 1);
  assert.equal(
    f.writes.filter((write) => write.name === 'workspace').at(-1)?.value.theme,
    'light',
  );
  assert.deepEqual(renderer.errors(), {});
  dom.window.close();
});

it('a save error releases editing and permits a repaired retry', async () => {
  const { JSDOM } = require('jsdom'),
    dom = new JSDOM('<body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const renderer = rendererFixture(dom.window.document, async (value) => {
    await f.invoke(window, 'saveWorkspace', value);
  });
  f.controls.flush = (script) => renderer.executeScript(script);
  const releases: number[] = [];
  f.controls.release = (attempt) => {
    releases.push(attempt);
    renderer.release(attempt);
  };
  f.controls.write = async (name) => {
    if (name === 'workspace') throw Error('disk failure');
  };
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(renderer.controller.paused, false);
  assert.equal(dom.window.document.body.inert, false);
  assert.match(renderer.errors().workspace, /disk failure/);
  assert.equal(f.controls.prompts, 0);
  assert.deepEqual(releases, [1]);
  renderer.setWorkspace((value: any) => ({ ...value, theme: 'light' }));
  f.controls.write = async () => {};
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(
    f.writes.filter((w) => w.name === 'workspace').at(-1)?.value.theme,
    'light',
  );
  dom.window.close();
});

it('a close canceled during initial loading cannot start a pause after late load completion', async () => {
  const f = await fixture();
  f.releaseRead();
  await setImmediate();
  let flushes = 0;
  f.controls.flush = async () => {
    flushes++;
  };
  const window = f.windows[0];
  window.close();
  await setImmediate();
  f.controls.expireClose();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(flushes, 0);
  f.releaseLoad();
  await setImmediate();
  assert.equal(flushes, 0);
  window.close();
  await setImmediate();
  assert.equal(flushes, 1);
  assert.equal(window.destroyed, true);
});

it('deadline cancellation releases the renderer before waiting for the native warning choice', async () => {
  const { JSDOM } = require('jsdom'),
    dom = new JSDOM('<body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0],
    saving = gate(),
    warning = gate();
  const renderer = rendererFixture(dom.window.document, async () => {
    await saving.wait;
  });
  f.controls.flush = (script) => renderer.executeScript(script);
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  f.controls.warning = () => warning.wait;
  window.close();
  await setImmediate();
  assert.equal(renderer.controller.paused, true);
  f.controls.expireClose();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(renderer.controller.paused, false);
  assert.equal(dom.window.document.body.inert, false);
  saving.release();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.deepEqual(renderer.errors(), {});
  warning.release();
  await setImmediate();
  assert.equal(window.destroyed, false);
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
  dom.window.close();
});

for (const route of ['close', 'quit'])
  it(`persistent initial read failure supports Keep open, cancel and explicit ${route} without a workspace write`, async () => {
    const { JSDOM } = require('jsdom'),
      dom = new JSDOM('<body><button>Edit</button></body>');
    dom.window.document.body.inert = false;
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    let reads = 0;
    f.controls.readWorkspace = async () => {
      reads++;
      throw Error(
        "Error invoking remote method 'canopy:loadWorkspace': Error: Saved workspace is unreadable.",
      );
    };
    const renderer = rendererFixture(dom.window.document, async (value) => {
      await f.invoke(window, 'saveWorkspace', value);
    });
    f.controls.flush = (script) => renderer.executeScript(script);
    f.controls.release = (attempt) => {
      renderer.release(attempt);
    };
    const request = () => (route === 'quit' ? f.app.quit() : window.close());
    let cleanup = await renderer.initialize(
      async () => (await f.invoke(window, 'loadWorkspace')) as Workspace | null,
    );
    const focus = dom.window.document.querySelector('button');
    focus.focus();
    for (const action of ['Keep open', 'Escape']) {
      await assert.rejects(
        renderer.save(renderer.workspaceRef.current),
        /not loaded/,
      );
      await assert.rejects(renderer.api.flushWorkspace(), /workspace.*load/i);
      request();
      await setImmediate();
      assert.equal(window.destroyed, false);
      assert.equal(renderer.controller.paused, false);
      assert.equal(dom.window.document.body.inert, false);
      assert.equal(dom.window.document.activeElement, focus);
      assert.equal(f.controls.prompts, action === 'Keep open' ? 1 : 2);
      assert.match(
        renderer.errors().workspace,
        /Couldn’t save workspace: Workspace has not loaded/,
      );
      const prompt = f.controls.warnings.at(-1)!;
      assert.equal(prompt.message, 'The workspace could not load.');
      assert.deepEqual(Array.from(prompt.buttons), [
        'Keep open',
        'Close anyway',
      ]);
      assert.equal(prompt.defaultId, 0);
      assert.equal(prompt.cancelId, 0);
      assert.match(prompt.detail, /saved workspace will be left unchanged/);
      assert.match(
        prompt.detail,
        /Changes made since loading failed have not been saved and will be lost if you close anyway/,
      );
      assert.doesNotMatch(
        prompt.detail,
        /renderer is unavailable|Error invoking remote method/i,
      );
      await renderer.api.reloadWorkspace();
      assert.equal(renderer.calls.at(-1), 'canopy:reloadWorkspace');
      cleanup();
      cleanup = await renderer.initialize(
        async () =>
          (await f.invoke(window, 'loadWorkspace')) as Workspace | null,
      );
      assert.equal(renderer.context.workspaceLoaded.current, false, action);
    }
    assert.equal(reads, 3);
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
    f.controls.consent = 1;
    request();
    await setImmediate();
    assert.equal(window.destroyed, true);
    assert.equal(f.controls.prompts, 3);
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
    if (route === 'quit') assert.ok(f.controls.quits >= 2);
    else assert.equal(f.controls.quits, 0);
    if (process.env.CANOPY_CLOSE_EVIDENCE_DIR)
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(
          process.env.CANOPY_CLOSE_EVIDENCE_DIR +
            `/initial-load-${route}-prompts.json`,
          JSON.stringify(f.controls.warnings, null, 2) + '\n',
        ),
      );
    cleanup();
    dom.window.close();
  });

it('a kept-open initial-load failure can repair storage, reload and close normally without abandonment', async () => {
  const { JSDOM } = require('jsdom'),
    dom = new JSDOM('<body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.controls.readWorkspace = async () => {
    throw Error('Initial read failed');
  };
  const createRenderer = () => {
    const next = rendererFixture(dom.window.document, async (value) => {
      await f.invoke(window, 'saveWorkspace', value);
    });
    next.forward((name, value) =>
      f.invoke(window, name.replace('canopy:', ''), value),
    );
    return next;
  };
  let renderer = createRenderer();
  f.controls.flush = (script) => renderer.executeScript(script);
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  let cleanup = await renderer.initialize(
    async () => (await f.invoke(window, 'loadWorkspace')) as Workspace | null,
  );
  let initialization!: Promise<() => void>;
  f.controls.reload = () => {
    cleanup();
    renderer.dispose();
    renderer = createRenderer();
    initialization = renderer.initialize(
      async () => (await f.invoke(window, 'loadWorkspace')) as Workspace | null,
    );
  };
  window.close();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(window.destroyed, false);
  const saved: Workspace = {
    tabs: [],
    activeTabId: null,
    theme: 'light',
    reading: { textSize: 'small', spacing: 'compact' },
    shortcuts: {},
    sidebarCollapsed: false,
  };
  await renderer.api.reloadWorkspace();
  cleanup = await initialization;
  assert.equal(renderer.context.workspaceLoaded.current, false);
  await assert.rejects(renderer.save(saved), /Workspace has not loaded/);
  const read = gate();
  f.controls.readWorkspace = async () => {
    await read.wait;
    return structuredClone(saved);
  };
  let replied = false;
  const reload = renderer.api.reloadWorkspace().then(() => {
    replied = true;
  });
  try {
    await setImmediate();
    assert.equal(
      replied,
      true,
      'Reload reply must not wait for the replacement read',
    );
    assert.equal(renderer.context.workspaceLoaded.current, false);
    await assert.rejects(renderer.save(saved), /Workspace has not loaded/);
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
  } finally {
    read.release();
  }
  await reload;
  cleanup = await initialization;
  assert.equal(renderer.context.workspaceLoaded.current, true);
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(f.controls.prompts, 1);
  assert.equal(
    f.writes.filter((write) => write.name === 'workspace').at(-1)?.value.theme,
    'light',
  );
  cleanup();
  dom.window.close();
});

it('a loaded save error with initialization-like text retains ordinary refusal policy', async () => {
  const { JSDOM } = require('jsdom'),
    dom = new JSDOM('<body><button>Edit</button></body>');
  dom.window.document.body.inert = false;
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  const renderer = rendererFixture(dom.window.document, async (value) => {
    await f.invoke(window, 'saveWorkspace', value);
  });
  f.controls.flush = (script) => renderer.executeScript(script);
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  f.controls.write = async (name) => {
    if (name === 'workspace')
      throw Error('Workspace could not load: permission denied');
  };
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.prompts, 0);
  assert.equal(renderer.controller.paused, false);
  assert.equal(dom.window.document.body.inert, false);
  assert.match(renderer.errors().workspace, /permission denied/);
  assert.equal(f.writes.filter((w) => w.name === 'workspace').length, 0);
  dom.window.close();
});

it('a reported initialization failure retains its consent requirement if renderer availability changes', async () => {
  const { JSDOM } = require('jsdom'),
    dom = new JSDOM('<body><button>Edit</button></body>');
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.controls.readWorkspace = async () => {
    throw Error('Initial read failed');
  };
  const renderer = rendererFixture(dom.window.document);
  await renderer.initialize(
    async () => (await f.invoke(window, 'loadWorkspace')) as Workspace | null,
  );
  f.controls.flush = async (script) => {
    const result = await renderer.executeScript(script);
    f.controls.crashed = true;
    return result;
  };
  f.controls.release = (attempt) => {
    renderer.release(attempt);
  };
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, false);
  assert.equal(f.controls.prompts, 1);
  assert.equal(f.controls.warnings[0].message, 'The workspace could not load.');
  assert.equal(f.writes.filter((w) => w.name === 'workspace').length, 0);
  dom.window.close();
});

for (const loss of ['before-close', 'before-reply'])
  it(`known initial read failure warns when renderer crashes ${loss}`, async () => {
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    f.controls.readWorkspace = async () => {
      throw Error('Initial read failed');
    };
    await assert.rejects(
      Promise.resolve(f.invoke(window, 'loadWorkspace')),
      /Initial read failed/,
    );
    const reply = gate();
    f.controls.flush = () => reply.wait;
    if (loss === 'before-close') f.controls.crashed = true;
    window.close();
    await setImmediate();
    if (loss === 'before-reply') {
      f.controls.crashed = true;
      window.webContents.emit('render-process-gone');
    }
    await setImmediate();
    assert.equal(f.controls.prompts, 1);
    assert.equal(window.destroyed, false);
    assert.equal(
      f.controls.warnings[0].message,
      'The workspace could not load.',
    );
    assert.match(
      f.controls.warnings[0].detail,
      /saved workspace will be left unchanged/,
    );
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
    reply.release();
  });

for (const lateFailure of [false, true])
  it(`Close anyway revokes received state across recreation${lateFailure ? ' even after a late rejection' : ''}`, async () => {
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    const pending = gate();
    let attempts = 0;
    f.controls.write = async (name) => {
      if (name === 'workspace') {
        attempts++;
        if (lateFailure) await pending.wait;
        else throw Error('disk failure');
      }
    };
    const save = Promise.resolve(
      f.invoke(window, 'saveWorkspace', {
        tabs: [],
        theme: 'dark',
        shortcuts: {},
        sidebarCollapsed: false,
      }),
    );
    const rejected = assert.rejects(save, /disk failure/);
    f.controls.crashed = true;
    f.controls.consent = 1;
    window.close();
    await setImmediate();
    if (lateFailure) {
      f.controls.expireClose();
      await setImmediate();
    }
    assert.equal(window.destroyed, true);
    if (lateFailure) pending.reject(Error('disk failure'));
    await rejected;
    await setImmediate();
    f.controls.write = async (name) => {
      if (name === 'workspace') attempts++;
    };
    f.app.emit('activate');
    await setImmediate();
    assert.equal(f.windows.length, 2);
    const replacement = f.windows[1];
    replacement.close();
    await setImmediate();
    assert.equal(replacement.destroyed, true);
    assert.equal(attempts, 1);
    assert.equal(
      f.controls.prompts,
      1,
      'Replacement must not inherit the abandoned failure',
    );
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
  });

it('initialization status is trusted, clears after successful initialization, and ignores obsolete read failures', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  assert.throws(
    () =>
      f.handlers.get('canopy:workspaceInitialized')!(
        { sender: {}, senderFrame: {} },
        'failure',
      ),
    /Untrusted application window/,
  );
  f.invoke(window, 'workspaceInitialized', 'Connections failed');
  f.controls.crashed = true;
  window.close();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(window.destroyed, false);
  const pending = gate();
  f.controls.readWorkspace = async () => {
    await pending.wait;
    return null;
  };
  const read = Promise.resolve(f.invoke(window, 'loadWorkspace'));
  const rejected = assert.rejects(read, /obsolete read/);
  window.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  f.invoke(window, 'workspaceInitialized', null);
  pending.reject(Error('obsolete read'));
  await rejected;
  window.close();
  await setImmediate();
  assert.equal(f.controls.prompts, 1);
  assert.equal(window.destroyed, true);
});

it('successful initialization clears the remembered warning before renderer loss', async () => {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.invoke(window, 'workspaceInitialized', 'Connections failed');
  f.invoke(window, 'workspaceInitialized', null);
  f.controls.crashed = true;
  window.close();
  await setImmediate();
  assert.equal(window.destroyed, true);
  assert.equal(f.controls.prompts, 0);
});

for (const lost of ['navigation', 'failed-page'])
  it(`failed workspace initialization survives replacement ${lost} until recovery acknowledges success`, async () => {
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    f.invoke(window, 'workspaceInitialized', 'Original read failed');
    await f.invoke(window, 'reloadWorkspace');
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    if (lost === 'failed-page')
      window.webContents.emit(
        'did-fail-load',
        {},
        -2,
        'ERR_FAILED',
        'file:///failed.html',
        true,
      );
    f.controls.crashed = lost === 'navigation';
    window.close();
    await setImmediate();
    assert.equal(window.destroyed, false);
    assert.equal(f.controls.prompts, 1);
    assert.equal(
      f.controls.warnings[0].message,
      'The workspace could not load.',
    );
    assert.match(f.controls.warnings[0].detail, /Original read failed/);
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      0,
    );
    f.invoke(window, 'workspaceInitialized', null);
    window.close();
    await setImmediate();
    assert.equal(window.destroyed, true);
    assert.equal(f.controls.prompts, 1);
  });

for (const failure of [false, true])
  it(`transfer reload recovery uses the owned native window: dialog failure=${failure}`, async () => {
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    const held = gate();
    f.controls.warning = () => held.wait;
    let settled = false;
    const showing = f.invoke(window, 'workspaceReloadFailed') as Promise<void>;
    const result = showing.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    assert.equal(f.controls.prompts, 1);
    assert.equal(f.controls.messageWindows[0], window);
    const options = f.controls.warnings[0];
    assert.equal(options.type, 'error');
    assert.equal(
      options.message,
      'Workspace transferred, but reload failed. Restart Canopy before editing.',
    );
    assert.deepEqual(Array.from(options.buttons), ['OK']);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(window.destroyed, false);
    assert.equal(f.controls.quits, 0);
    assert.equal(f.writes.length, 0);
    assert.throws(
      () =>
        f.handlers.get('canopy:workspaceReloadFailed')!({
          sender: {},
          senderFrame: {},
        }),
      /Untrusted application window/,
    );
    assert.equal(f.controls.prompts, 1);
    if (failure) {
      const rejected = assert.rejects(result, /native dialog unavailable/);
      held.reject(Error('native dialog unavailable'));
      await rejected;
    } else {
      held.release();
      await result;
    }
    assert.equal(settled, true);
    assert.equal(window.destroyed, false);
    assert.equal(f.controls.quits, 0);
    assert.equal(f.writes.length, 0);
  });

for (const outcome of [
  'failure',
  'success',
  'destroyed',
  'closed',
  'stale',
  'dialog-refused',
  'reload-throw',
  'absent-expiry',
])
  it(`committed transfer tracks asynchronous replacement load: ${outcome}`, async (context) => {
    if (outcome === 'absent-expiry')
      context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    const f = await fixture();
    f.releaseRead();
    f.releaseLoad();
    await setImmediate();
    const window = f.windows[0];
    const original: Workspace = {
      tabs: [],
      activeTabId: null,
      theme: 'dark',
      shortcuts: {},
      sidebarCollapsed: false,
    };
    f.controls.readWorkspace = async () => structuredClone(original);
    const exported = (await f.invoke(window, 'prepareWorkspaceExport')) as any;
    exported.backup.workspace.theme = 'light';
    const preview = (await f.invoke(
      window,
      'previewWorkspaceImport',
      exported.backup,
      {},
      'replace',
    )) as any;
    await f.invoke(window, 'applyWorkspaceImport', preview.token);
    const oldSession = f.invoke(
      window,
      'handoffReady',
      '11111111-1111-4111-8111-111111111111',
    ) as any;
    for (const view of ['one', 'two'])
      f.app.emit('second-instance', {}, [], '/ignored', {
        canopyMode: 'main',
        canopyArguments: [
          '--canopy-open',
          `canopy://handoff/view?view=${view}`,
        ],
      });
    const delivered = window.handoffStates.at(-1).delivery;
    const committed = JSON.stringify(await f.controls.readWorkspace());
    const baseline = window.webContents.listenerCount('did-fail-load');
    let reloads = 0;
    f.controls.reload = () => {
      reloads++;
    };
    if (outcome === 'reload-throw') {
      f.controls.reload = () => {
        throw Error('reload refused');
      };
      await assert.rejects(
        async () => f.invoke(window, 'reloadWorkspace'),
        /reload refused/,
      );
      assert.equal(window.webContents.listenerCount('did-fail-load'), baseline);
      assert.equal(JSON.stringify(await f.controls.readWorkspace()), committed);
      assert.equal(f.controls.prompts, 0);
      return;
    }
    await f.invoke(window, 'reloadWorkspace');
    assert.equal(reloads, 1);
    assert.equal(
      f.controls.prompts,
      0,
      'void reload succeeds before asynchronous failure',
    );
    assert.equal(
      window.webContents.listenerCount('did-fail-load'),
      baseline + 1,
    );
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.equal(f.invoke(window, 'handoffCancel', oldSession.session), false);
    assert.equal(
      f.invoke(
        window,
        'handoffAck',
        oldSession.session,
        delivered.id,
        'opened',
      ),
      false,
    );
    if (outcome === 'absent-expiry') {
      const send = window.webContents.send;
      window.webContents.send = () => {
        throw Error('departing renderer unavailable');
      };
      context.mock.timers.tick(10_000);
      window.webContents.send = send;
    }
    window.webContents.emit('did-navigate');
    const replacement = f.invoke(
      window,
      'handoffReady',
      '22222222-2222-4222-8222-222222222222',
    ) as any;
    assert.ok(
      replacement.delivery,
      'unacknowledged request survives committed-transfer navigation',
    );
    assert.equal(
      replacement.delivery.intent.view,
      outcome === 'absent-expiry' ? 'two' : 'one',
    );
    if (outcome === 'absent-expiry') assert.equal(replacement.rejected, true);
    else assert.equal(replacement.delivery.expiresAt, delivered.expiresAt);
    assert.notEqual(replacement.session, oldSession.session);
    assert.equal(
      f.invoke(
        window,
        'handoffAck',
        replacement.session,
        replacement.delivery.id,
        'opened',
      ),
      true,
    );
    if (outcome !== 'absent-expiry')
      assert.equal(window.handoffStates.at(-1).delivery.intent.view, 'two');
    const fail = (code = -2, mainFrame = true) =>
      window.webContents.emit(
        'did-fail-load',
        {},
        code,
        'ERR_FAILED',
        'file:///sample/dist/renderer/index.html',
        mainFrame,
      );
    fail(-2, false);
    fail(-3);
    assert.equal(f.controls.prompts, 0);
    assert.equal(
      window.webContents.listenerCount('did-fail-load'),
      baseline + 1,
    );
    if (outcome === 'success') window.webContents.emit('did-finish-load');
    if (outcome === 'destroyed') window.webContents.emit('destroyed');
    if (outcome === 'closed') window.emit('closed');
    if (outcome === 'stale') {
      window.destroyed = true;
      f.app.emit('activate');
      await setImmediate();
    }
    if (outcome === 'dialog-refused')
      f.controls.warning = async () => {
        throw Error('dialog unavailable');
      };
    fail();
    fail();
    await setImmediate();
    const failed = ['failure', 'dialog-refused', 'absent-expiry'].includes(
      outcome,
    );
    assert.equal(f.controls.prompts, failed ? 1 : 0);
    if (failed) {
      assert.equal(
        f.controls.reportHandlers,
        1,
        'asynchronous native reporting has an effective rejection handler',
      );
      assert.equal(f.controls.messageWindows[0], window);
      assert.match(
        f.controls.warnings[0].message,
        /Restart Canopy before editing/,
      );
    }
    if (outcome === 'stale') window.webContents.emit('destroyed');
    assert.equal(window.webContents.listenerCount('did-fail-load'), baseline);
    if (outcome === 'success') {
      await f.invoke(window, 'reloadWorkspace');
      assert.equal(
        window.webContents.listenerCount('did-fail-load'),
        baseline,
        'successful replacement clears committed reload tracking',
      );
    }
    assert.equal(JSON.stringify(await f.controls.readWorkspace()), committed);
    assert.equal(
      f.writes.filter((write) => write.name === 'workspace').length,
      1,
    );
    assert.equal(f.controls.quits, 0);
  });

async function committedHandoffFixture(registerOld = true) {
  const f = await fixture();
  f.releaseRead();
  f.releaseLoad();
  await setImmediate();
  const window = f.windows[0];
  f.controls.readWorkspace = async () => ({
    tabs: [],
    activeTabId: null,
    theme: 'dark',
    shortcuts: {},
    sidebarCollapsed: false,
  });
  const exported = (await f.invoke(window, 'prepareWorkspaceExport')) as any;
  exported.backup.workspace.theme = 'light';
  const preview = (await f.invoke(
    window,
    'previewWorkspaceImport',
    exported.backup,
    {},
    'replace',
  )) as any;
  await f.invoke(window, 'applyWorkspaceImport', preview.token);
  const old = registerOld
    ? (f.invoke(
        window,
        'handoffReady',
        '11111111-1111-4111-8111-111111111111',
      ) as any)
    : undefined;
  for (const view of ['one', 'two'])
    f.app.emit('second-instance', {}, [], '/ignored', {
      canopyMode: 'main',
      canopyArguments: ['--canopy-open', `canopy://handoff/view?view=${view}`],
    });
  return { f, window, old };
}

for (const registerOld of [false, true])
  it(`replacement readiness requires a committed document: existing session=${registerOld}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    const { f, window, old } = await committedHandoffFixture(registerOld);
    const delivered = window.handoffStates.at(-1)?.delivery;
    const outgoingFrame = window.webContents.mainFrame;
    await f.invoke(window, 'reloadWorkspace');
    const departingReady = () =>
      f.invoke(window, 'handoffReady', '11111111-1111-4111-8111-111111111111');
    assert.throws(departingReady, /replacing the workspace/);
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.throws(departingReady, /replacing the workspace/);
    window.webContents.emit(
      'did-frame-navigate',
      {},
      outgoingFrame.url,
      200,
      'OK',
      false,
    );
    assert.throws(departingReady, /replacing the workspace/);
    context.mock.timers.tick(1_000);
    window.webContents.mainFrame = { url: outgoingFrame.url };
    window.webContents.emit('did-navigate', {}, outgoingFrame.url, 200, 'OK');
    assert.throws(
      () =>
        f.handlers.get('canopy:handoffReady')!(
          { sender: window.webContents, senderFrame: outgoingFrame },
          '11111111-1111-4111-8111-111111111111',
        ),
      /Untrusted/,
    );
    let replacement: any;
    assert.doesNotThrow(() => {
      replacement = f.invoke(
        window,
        'handoffReady',
        '22222222-2222-4222-8222-222222222222',
      );
    });
    assert.equal(replacement.delivery.intent.view, 'one');
    assert.equal(
      replacement.delivery.expiresAt,
      delivered?.expiresAt ?? 11_100,
    );
    if (old) {
      assert.equal(f.invoke(window, 'handoffCancel', old.session), false);
      assert.equal(
        f.invoke(window, 'handoffAck', old.session, delivered.id, 'opened'),
        false,
      );
    }
    window.webContents.emit('did-finish-load');
    assert.equal(
      f.invoke(
        window,
        'handoffAck',
        replacement.session,
        replacement.delivery.id,
        'opened',
      ),
      true,
    );
    const second = window.handoffStates.at(-1).delivery;
    assert.equal(second.intent.view, 'two');
    assert.equal(f.invoke(window, 'handoffCancel', replacement.session), true);
    assert.equal(
      f.invoke(window, 'handoffAck', replacement.session, second.id, 'opened'),
      false,
    );
    assert.equal(
      (
        f.invoke(
          window,
          'handoffReady',
          '33333333-3333-4333-8333-333333333333',
        ) as any
      ).delivery,
      undefined,
    );
  });

it('synchronous reload refusal reports expiry without registration and preserves the committed barrier', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const { f, window, old } = await committedHandoffFixture();
  const delivered = window.handoffStates.at(-1).delivery;
  const bytes = JSON.stringify(await f.controls.readWorkspace());
  const failListeners = window.webContents.listenerCount('did-fail-load');
  const finishListeners = window.webContents.listenerCount('did-finish-load');
  f.controls.reload = () => {
    throw Error('reload refused');
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      async () => f.invoke(window, 'reloadWorkspace'),
      /reload refused/,
    );
    assert.equal(
      window.webContents.listenerCount('did-fail-load'),
      failListeners,
    );
    assert.equal(
      window.webContents.listenerCount('did-finish-load'),
      finishListeners,
    );
  }
  assert.equal(f.invoke(window, 'handoffCancel', old.session), false);
  assert.equal(
    f.invoke(window, 'handoffAck', old.session, delivered.id, 'opened'),
    false,
  );
  const before = window.handoffStates.length;
  context.mock.timers.tick(9_999);
  assert.equal(window.handoffStates.length, before);
  context.mock.timers.tick(1);
  assert.ok(
    window.handoffStates
      .slice(before)
      .some((state) => state.session === '' && state.rejected),
  );
  const afterCurrent = window.handoffStates.length;
  context.mock.timers.tick(49_999);
  assert.equal(window.handoffStates.length, afterCurrent);
  context.mock.timers.tick(1);
  assert.ok(
    window.handoffStates.slice(afterCurrent).some((state) => state.rejected),
  );
  assert.equal(JSON.stringify(await f.controls.readWorkspace()), bytes);
  assert.equal(f.controls.prompts, 0);
});

for (const failure of ['throw', 'async'])
  it(`repeated ${failure} reload failure permits retry with original deadlines`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    const { f, window, old } = await committedHandoffFixture();
    const delivered = window.handoffStates.at(-1).delivery;
    const bytes = JSON.stringify(await f.controls.readWorkspace());
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failure === 'throw') {
        f.controls.reload = () => {
          throw Error('reload refused');
        };
        await assert.rejects(
          async () => f.invoke(window, 'reloadWorkspace'),
          /reload refused/,
        );
      } else {
        await f.invoke(window, 'reloadWorkspace');
        window.webContents.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: false,
        });
        window.webContents.emit(
          'did-fail-load',
          {},
          -2,
          'ERR_FAILED',
          window.webContents.mainFrame.url,
          true,
        );
      }
      context.mock.timers.tick(1_000);
    }
    f.controls.reload = () => {};
    await f.invoke(window, 'reloadWorkspace');
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.equal(f.invoke(window, 'handoffCancel', old.session), false);
    window.webContents.emit('did-navigate');
    let replacement: any;
    assert.doesNotThrow(() => {
      replacement = f.invoke(
        window,
        'handoffReady',
        '22222222-2222-4222-8222-222222222222',
      );
    });
    assert.equal(replacement.delivery.intent.view, 'one');
    assert.equal(replacement.delivery.expiresAt, delivered.expiresAt);
    context.mock.timers.tick(7_999);
    assert.equal(window.handoffStates.at(-1).delivery?.intent.view, 'one');
    context.mock.timers.tick(1);
    assert.equal(
      f.invoke(
        window,
        'handoffAck',
        replacement.session,
        replacement.delivery.id,
        'opened',
      ),
      false,
    );
    const second = window.handoffStates.at(-1).delivery;
    assert.equal(second.intent.view, 'two');
    assert.equal(second.expiresAt, 20_100);
    window.webContents.emit('did-finish-load');
    assert.equal(JSON.stringify(await f.controls.readWorkspace()), bytes);
  });

for (const loss of ['crash', 'destroyed', 'closed'])
  for (const ready of [false, true])
    it(`${loss} cancels retained handoffs and reload listeners: replacement ready=${ready}`, async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
      const { f, window } = await committedHandoffFixture();
      const baseline = window.webContents.listenerCount('did-fail-load');
      const finishBaseline =
        window.webContents.listenerCount('did-finish-load');
      await f.invoke(window, 'reloadWorkspace');
      window.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
      let replacement: any;
      if (ready) {
        window.webContents.emit('did-navigate');
        assert.doesNotThrow(() => {
          replacement = f.invoke(
            window,
            'handoffReady',
            '22222222-2222-4222-8222-222222222222',
          );
        });
        assert.ok(replacement.delivery);
        if (loss === 'destroyed')
          window.webContents.once('destroyed', () => {
            assert.equal(
              f.invoke(
                window,
                'handoffAck',
                replacement.session,
                replacement.delivery.id,
                'opened',
              ),
              false,
              'destruction cancels before the window closed callback',
            );
          });
      }
      if (loss === 'crash')
        window.webContents.emit(
          'render-process-gone',
          {},
          { reason: 'crashed' },
        );
      else if (loss === 'destroyed') window.destroy();
      else {
        window.destroyed = true;
        window.emit('closed');
      }
      assert.equal(window.webContents.listenerCount('did-fail-load'), baseline);
      assert.equal(
        window.webContents.listenerCount('did-finish-load'),
        finishBaseline,
      );
      let next = window;
      if (loss !== 'crash') {
        f.app.emit('activate');
        await setImmediate();
        next = f.windows[1];
        assert.ok(next);
      }
      const beforeInvalid = next.handoffStates.length;
      f.app.emit('second-instance', {}, [], '/ignored', {
        canopyMode: 'main',
        canopyArguments: ['--invalid-canopy-command'],
      });
      await setImmediate();
      assert.equal(
        next.handoffStates
          .slice(beforeInvalid)
          .some((state) => state.session === '' && state.rejected),
        true,
        'renderer loss restores rejection notifications before registration',
      );
      let recovered: any;
      assert.doesNotThrow(() => {
        recovered = f.invoke(
          next,
          'handoffReady',
          '33333333-3333-4333-8333-333333333333',
        );
      });
      assert.equal(recovered.delivery, undefined);
      const before = next.handoffStates.length;
      context.mock.timers.tick(60_000);
      assert.equal(next.handoffStates.length, before);
      window.webContents.emit(
        'did-fail-load',
        {},
        -2,
        'ERR_FAILED',
        window.webContents.mainFrame.url,
        true,
      );
      assert.equal(f.controls.prompts, 0);
      if (loss !== 'crash') {
        f.app.emit('second-instance', {}, [], '/ignored', {
          canopyMode: 'main',
          canopyArguments: [
            '--canopy-open',
            'canopy://handoff/view?view=fresh',
          ],
        });
        const fresh = next.handoffStates.at(-1).delivery;
        assert.equal(fresh.intent.view, 'fresh');
        window.webContents.emit(
          'render-process-gone',
          {},
          { reason: 'crashed' },
        );
        window.webContents.emit('destroyed');
        window.emit('closed');
        assert.equal(
          f.invoke(next, 'handoffAck', recovered.session, fresh.id, 'opened'),
          true,
        );
      }
    });

it('crash cancellation overrides an earlier ordinary navigation cancellation latch', async () => {
  const { f, window } = await committedHandoffFixture();
  window.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  f.app.emit('second-instance', {}, [], '/ignored', {
    canopyMode: 'main',
    canopyArguments: ['--canopy-open', 'canopy://handoff/view?view=late'],
  });
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const recovered = f.invoke(
    window,
    'handoffReady',
    '33333333-3333-4333-8333-333333333333',
  ) as any;
  assert.equal(recovered.delivery, undefined);
});

it('aborted replacement admits late outgoing readiness within the original pending deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const { f, window } = await committedHandoffFixture(false);
  f.controls.reload = () => {
    throw Error('reload refused');
  };
  await assert.rejects(
    async () => f.invoke(window, 'reloadWorkspace'),
    /reload refused/,
  );
  context.mock.timers.tick(59_000);
  let outgoing: any;
  assert.doesNotThrow(() => {
    outgoing = f.invoke(
      window,
      'handoffReady',
      '11111111-1111-4111-8111-111111111111',
    );
  });
  assert.equal(outgoing.delivery.intent.view, 'one');
  assert.equal(outgoing.delivery.expiresAt, 60_100);
  context.mock.timers.tick(999);
  assert.equal(
    f.invoke(
      window,
      'handoffAck',
      outgoing.session,
      outgoing.delivery.id,
      'opened',
    ),
    true,
  );
  assert.equal(window.handoffStates.at(-1).delivery.intent.view, 'two');
  assert.equal(window.handoffStates.at(-1).delivery.expiresAt, 60_100);
  context.mock.timers.tick(1);
  assert.equal(window.handoffStates.at(-1).rejected, true);
});
