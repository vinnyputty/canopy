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
    flush: async () => {},
    write: async (_name: string) => {},
    crashed: false,
    consent: 0,
    prompts: 0,
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
      executeJavaScript: () => controls.flush(),
      getURL: () => this.webContents.mainFrame.url,
      session: { setPermissionRequestHandler() {} },
      setWindowOpenHandler() {},
      send: (channel: string, state: unknown) => {
        this.messages.push(channel);
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
        this.destroyed = true;
        this.webContents.emit('destroyed');
        this.emit('closed');
      }
    }
  }
  class Storage {
    async read(name: string) {
      assert.equal(name, 'window');
      reads++;
      await readGate.wait;
      return controls.saved;
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
            showMessageBox: async () => {
              controls.prompts++;
              return { response: controls.consent };
            },
            showErrorBox: (_title: string, message: string) =>
              errors.push(message),
          },
        };
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
