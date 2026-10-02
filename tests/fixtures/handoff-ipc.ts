// Real launch/IPC callbacks under Node. All Electron/provider/secret boundaries are injected.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, Module } from 'node:module';
import { pathToFileURL } from 'node:url';
const sourcePath = process.argv[2];
const scenario = process.argv[3];
const args = (name: string) => [
  '--canopy-open',
  `canopy://handoff/view?view=${name}`,
];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let ready!: () => void;
const readiness = new Promise<void>((resolve) => {
  ready = resolve;
});
let start!: () => void;
const startup = new Promise<void>((resolve) => {
  start = resolve;
});
const handlers = new Map<string, (...args: any[]) => any>();
const sent: any[] = [];
const renderer = new EventEmitter();
let bridge: any;
const windows: Window[] = [];
let win!: Window;
let profileCalls = 0;
let fixtureCalls = 0;
let releaseCreation!: () => void;
const creation = new Promise<void>((resolve) => {
  releaseCreation = resolve;
});
let focuses = 0;
let restores = 0;
let quits = 0;
let lockData: unknown;
const forbidden = () => {
  throw new Error('Forbidden external/credential/provider/clipboard boundary');
};
const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  setName() {},
  commandLine: { appendSwitch() {} },
  getPath() {
    profileCalls++;
    return process.env.CANOPY_USER_DATA;
  },
  getVersion: () => '0.1.0',
  setPath() {},
  requestSingleInstanceLock(data: unknown) {
    lockData = data;
    return scenario !== 'loser';
  },
  whenReady: () => readiness,
  quit() {
    quits++;
  },
  focus() {},
});
class Window extends EventEmitter {
  destroyed = false;
  minimized = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '' },
    send: (channel: string, state: unknown) => {
      assert.equal(channel, 'canopy:handoff');
      sent.push(state);
      renderer.emit(channel, { nativeEventMustNotEscape: true }, state);
    },
    setWindowOpenHandler: (callback: () => any) =>
      assert.equal(callback().action, 'deny'),
    session: { setPermissionRequestHandler() {} },
  });
  constructor(options: any) {
    super();
    win = this;
    windows.push(this);
    assert(
      options.webPreferences.sandbox &&
        options.webPreferences.contextIsolation &&
        !options.webPreferences.nodeIntegration,
    );
  }
  async loadFile(file: string) {
    this.webContents.mainFrame.url = pathToFileURL(file).href;
    this.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    start();
    if (scenario === 'close' && windows.length === 2) await creation;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    restores++;
    this.minimized = false;
  }
  show() {}
  focus() {
    focuses++;
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
      app.emit('window-all-closed');
    }
  }
}
const electron = {
  app,
  BrowserWindow: Window,
  contextBridge: {
    exposeInMainWorld(name: string, api: unknown) {
      assert.equal(name, 'canopy');
      bridge = api;
    },
  },
  ipcRenderer: Object.assign(renderer, {
    invoke(name: string, ...args: unknown[]) {
      try {
        return Promise.resolve(handlers.get(name)!(event(), ...args));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  }),
  ipcMain: {
    handle: (name: string, callback: (...args: any[]) => any) =>
      handlers.set(name, callback),
  },
  safeStorage: {
    isEncryptionAvailable: forbidden,
    decryptString: forbidden,
    encryptString: forbidden,
  },
  shell: { openExternal: forbidden },
  clipboard: { writeText: forbidden },
  dialog: { showErrorBox: forbidden },
  screen: { getAllDisplays: () => [] },
  Menu: {
    setApplicationMenu() {},
    buildFromTemplate: (value: unknown) => value,
  },
};
const load = (
  Module as unknown as { _load: (id: string, ...args: any[]) => any }
)._load;
(Module as unknown as { _load: (id: string, ...args: any[]) => any })._load =
  function (id, ...args) {
    return id === 'electron' ? electron : load.call(this, id, ...args);
  };
const source = createRequire(sourcePath)(sourcePath);
source.launch(
  async () => {
    fixtureCalls++;
    return source.createDemoFixture();
  },
  true,
  args('startup'),
);
const event = () => ({
  sender: win.webContents,
  senderFrame: win.webContents.mainFrame,
});
const invoke = (name: string, ...args: unknown[]) =>
  handlers.get(`canopy:${name}`)!(
    event(),
    ...(name === 'handoffReady' && !args.length
      ? ['11111111-1111-4111-8111-111111111111']
      : args),
  );
const duplicate = (payload: unknown) =>
  app.emit(
    'second-instance',
    {},
    ['untrusted', '--arbitrary-reordered'],
    '/ignored',
    payload,
  );
const send = (name: string) =>
  duplicate({ canopyMode: 'demo', canopyArguments: args(name) });
(async () => {
  assert.deepEqual(lockData, {
    canopyMode: 'demo',
    canopyArguments: args('startup'),
  });
  if (scenario === 'loser') {
    assert.equal(quits, 1);
    ready();
    await tick();
    assert.equal(profileCalls, 0);
    assert.equal(fixtureCalls, 0);
    assert.equal(windows.length, 0);
    return;
  }
  send('second');
  send('startup');
  assert.equal(profileCalls, 0);
  assert.equal(sent.length, 0);
  if (scenario === 'early-quit') app.emit('before-quit');
  ready();
  await startup;
  await tick();
  assert.equal(
    sent.length,
    0,
    'No delivery before real renderer hydration handshake',
  );
  if (scenario === 'early-quit') {
    assert.throws(() => invoke('handoffReady'), /closing/);
    assert.equal(sent.length, 0);
    return;
  }
  if (scenario === 'preload') {
    createRequire(sourcePath)(process.argv[4]);
    const received: any[] = [];
    const unsubscribe = bridge.onHandoff((state: unknown) =>
      received.push(state),
    );
    const owner = '33333333-3333-4333-8333-333333333333';
    const first = await bridge.handoffReady(owner);
    assert.equal(first.delivery.intent.view, 'startup');
    assert(await bridge.handoffAck(first.session, first.delivery.id, 'opened'));
    assert.equal(received.at(-1).delivery.intent.view, 'second');
    assert.equal(received.at(-1).nativeEventMustNotEscape, undefined);
    await assert.rejects(
      bridge.handoffReady('arbitrary-owner'),
      /Invalid handoff owner/,
    );
    unsubscribe();
    const count = received.length;
    send('unsubscribed');
    assert(
      await bridge.handoffAck(
        first.session,
        received.at(-1).delivery.id,
        'opened',
      ),
    );
    assert.equal(received.length, count);
    app.emit('before-quit');
    return;
  }
  const first = invoke('handoffReady');
  assert.equal(first.delivery.intent.view, 'startup');
  assert.throws(
    () => handlers.get('canopy:handoffReady')!({ ...event(), sender: {} }),
    /Untrusted/,
  );
  assert.throws(
    () =>
      handlers.get('canopy:handoffAck')!(
        { ...event(), senderFrame: { ...win.webContents.mainFrame } },
        first.session,
        first.delivery.id,
        'opened',
      ),
    /Untrusted/,
  );
  assert.equal(
    invoke('handoffAck', 'foreign', first.delivery.id, 'opened'),
    false,
  );
  assert(invoke('handoffAck', first.session, first.delivery.id, 'opened'));
  assert.equal(sent.at(-1).delivery.intent.view, 'second');
  const trustedUrl = win.webContents.mainFrame.url;
  win.webContents.mainFrame.url = 'https://foreign.example';
  assert.throws(
    () => invoke('handoffAck', first.session, first.delivery.id, 'opened'),
    /Untrusted/,
  );
  win.webContents.mainFrame.url = trustedUrl;
  const second = sent.at(-1).delivery;
  assert(invoke('handoffAck', first.session, second.id, 'rejected'));
  win.minimized = true;
  send('third');
  await tick();
  assert.equal(restores, 1);
  assert(focuses >= 2);
  assert.equal(sent.at(-1).delivery.intent.view, 'third');
  const current = sent.at(-1).delivery;
  if (scenario === 'navigation' || scenario === 'crash') {
    if (scenario === 'navigation')
      win.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
    else win.webContents.emit('render-process-gone');
    assert.equal(
      invoke('handoffAck', current.session, current.id, 'opened'),
      false,
    );
    send('next-generation');
    const next = invoke('handoffReady');
    assert.notEqual(next.session, current.session);
    assert.equal(next.delivery.intent.view, 'next-generation');
    win.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.equal(
      invoke('handoffAck', next.session, next.delivery.id, 'opened'),
      false,
    );
  } else if (scenario === 'close') {
    const oldWindow = win;
    oldWindow.close();
    send('after-close');
    await tick();
    await tick();
    await tick();
    assert.notEqual(win, oldWindow);
    send('during-creation');
    await tick();
    assert.equal(windows.length, 2);
    releaseCreation();
    await tick();
    await tick();
    assert.equal(quits, 0);
    assert.throws(
      () =>
        handlers.get('canopy:handoffAck')!(
          {
            sender: oldWindow.webContents,
            senderFrame: oldWindow.webContents.mainFrame,
          },
          current.session,
          current.id,
          'opened',
        ),
      /Untrusted/,
    );
    const next = invoke('handoffReady');
    assert.equal(next.delivery.intent.view, 'after-close');
    assert.notEqual(next.session, current.session);
    assert(invoke('handoffAck', next.session, next.delivery.id, 'opened'));
    assert.equal(sent.at(-1).delivery.intent.view, 'during-creation');
  } else {
    assert(invoke('handoffAck', current.session, current.id, 'opened'));
    for (const payload of [
      { canopyMode: 'demo', canopyArguments: [...args('bad'), 'extra'] },
      { canopyMode: 'main', canopyArguments: args('bad') },
      {
        canopyMode: 'demo',
        canopyArguments: ['--arbitrary', 'https://evil.example'],
      },
      { canopyMode: 'demo', canopyArguments: args('bad'), secret: 'forbidden' },
    ])
      duplicate(payload);
    assert(sent.at(-1).rejected);
    assert.equal(invoke('handoffReady').delivery, undefined);
    assert.equal(invoke('handoffCancel', 'foreign'), false);
    app.emit('before-quit');
    send('after-quit');
    assert.throws(() => invoke('handoffReady'), /closing/);
  }
  app.emit('before-quit');
  console.log(
    JSON.stringify({
      scenario,
      productionCallbacks: true,
      focusModeledOnly: true,
      profileCalls,
      fixtureCalls,
      windows: windows.length,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
