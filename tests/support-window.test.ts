import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { transformSync } from 'esbuild';
import { supportLinks, supportUrl } from '../src/shared/support';

const require = createRequire(import.meta.url);
const main = transformSync(readFileSync('src/main/app.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
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
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setName() {},
    getPath: () => '/sample',
    getVersion: () => '0.1.0',
    whenReady: () => Promise.resolve(),
    quit() {},
  });
  class FakeWindow extends EventEmitter {
    destroyed = false;
    messages: string[] = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      session: { setPermissionRequestHandler() {} },
      setWindowOpenHandler() {},
      send: (channel: string) => this.messages.push(channel),
    });
    constructor(_options: unknown) {
      super();
      windows.push(this);
    }
    async loadFile(path: string) {
      this.webContents.emit('did-start-loading');
      this.webContents.mainFrame.url = pathToFileURL(path).href;
      await loadGate.wait;
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
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1000, height: 700 };
    }
    restore() {}
    show() {}
    focus() {}
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
      return null;
    }
    async write() {}
  }
  const module = { exports: {} as { launch: () => void } };
  runInNewContext(main, {
    module,
    exports: module.exports,
    __dirname: '/sample/dist',
    process: { platform: 'darwin', env: {} },
    console,
    structuredClone,
    URL,
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
          screen: { getAllDisplays: () => [] },
          shell: {},
          dialog: {
            showErrorBox: (_title: string, message: string) =>
              errors.push(message),
          },
        };
      if (name === '../shared/support') return { supportLinks, supportUrl };
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
      if (name === './credentials')
        return { configureLinuxCredentialStore() {} };
      if (name === './window-state') return { restoreWindow: () => null };
      if (name === './demo') return { demoWorkspace: {} };
      return {};
    },
  });
  module.exports.launch();
  await setImmediate();
  assert.deepEqual(errors, []);
  return {
    app,
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
    hold: () => {
      readGate = gate();
      loadGate = gate();
    },
    invoke(window: FakeWindow, name: string) {
      return handlers.get(`canopy:${name}`)!({
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      });
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
