// Runs under Node with Electron/HTTPS stubbed. The parent supplies a disposable
// profile; no Electron runtime, GUI, browser, clipboard or provider is used.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createRequire, Module } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { UpdateState } from '../../src/shared/updates';

const profile = process.env.CANOPY_USER_DATA;
assert.ok(
  profile && isAbsolute(profile),
  'Parent must supply disposable CANOPY_USER_DATA.',
);
const scenario = process.argv[3];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release, held: false };
}
const load = gate(),
  write = gate();
let holdLoad = scenario.startsWith('load-'),
  holdWrite = false;
let time = 2 * 7 * 24 * 60 * 60 * 1000;
let ready = false;
let win: any;
const handlers = new Map<string, (...args: any[]) => any>();
const requests: string[] = [],
  browsers: string[] = [],
  dialogs: unknown[] = [];
const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  setName() {},
  setPath(_name: string, path: string) {
    assert.equal(path, profile);
  },
  getPath() {
    return profile;
  },
  getVersion() {
    return '0.1.0';
  },
  commandLine: { appendSwitch() {} },
  whenReady: async () => {},
  quit() {},
});
class Window extends EventEmitter {
  webContents: any;
  constructor(options: any) {
    super();
    win = this;
    assert.equal(options.webPreferences.sandbox, true);
    this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler(fn: () => any) {
        assert.equal(fn().action, 'deny');
      },
      session: { setPermissionRequestHandler() {} },
    });
  }
  async loadFile(file: string) {
    this.webContents.mainFrame.url = pathToFileURL(file).href;
    ready = true;
  }
}
const forbidden = () => {
  throw new Error('Forbidden external boundary');
};
const electron = {
  app,
  BrowserWindow: Window,
  ipcMain: {
    handle(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
  },
  safeStorage: {
    isEncryptionAvailable: forbidden,
    decryptString: forbidden,
    encryptString: forbidden,
  },
  shell: {
    openExternal: async (url: string) => {
      browsers.push(url);
    },
  },
  clipboard: { writeText: forbidden },
  dialog: {
    showErrorBox: (...args: unknown[]) => {
      dialogs.push(args);
    },
  },
  screen: {
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1440, height: 920 } },
    ],
  },
  Menu: {
    setApplicationMenu() {},
    buildFromTemplate: (template: unknown) => template,
  },
};
let status = 200,
  version = '0.2.0';
let deliverHeld: (() => void) | undefined;
const suffix =
  process.platform === 'darwin'
    ? `mac-${process.arch}.dmg`
    : process.platform === 'win32'
      ? `win-${process.arch}.exe`
      : `linux-${process.arch === 'x64' ? 'amd64' : process.arch}.deb`;
function row(value: string, artifact = suffix) {
  const tag = `v${value}`,
    name = `Canopy-${value}-${artifact}`;
  return {
    tag_name: tag,
    html_url: `https://github.com/vinnyputty/canopy/releases/tag/${encodeURIComponent(tag)}`,
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    body: `Matching notes for ${tag}`,
    assets: [
      {
        name,
        state: 'uploaded',
        size: 42,
        browser_download_url: `https://github.com/vinnyputty/canopy/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      },
    ],
  };
}
function get(url: string, options: any, callback: (response: any) => void) {
  assert.equal(
    url,
    'https://api.github.com/repos/vinnyputty/canopy/releases?per_page=30&page=1',
  );
  assert.deepEqual(Object.keys(options).sort(), ['headers', 'signal']);
  assert.deepEqual(options.headers, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Canopy-release-discovery',
    'X-GitHub-Api-Version': '2026-03-10',
  });
  requests.push(url);
  const req = Object.assign(new EventEmitter(), {
    setTimeout(ms: number) {
      assert.equal(ms, 10000);
    },
    destroy(error: Error) {
      req.emit('error', error);
    },
  });
  options.signal.addEventListener(
    'abort',
    () => {
      if (scenario !== 'active-replacement')
        req.destroy(new Error('Stub abort'));
    },
    { once: true },
  );
  const body = JSON.stringify([
    row(version),
    row('0.8.0-rc.1'),
    row('9.0.0', 'wrong-cpu.zip'),
  ]);
  const responseStatus = status;
  const deliver = () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: responseStatus,
      headers: {},
      destroy() {},
    });
    callback(response);
    response.emit('data', Buffer.from(body));
    response.emit('end');
  };
  if (scenario === 'active-replacement' && requests.length === 1)
    deliverHeld = deliver;
  else queueMicrotask(deliver);
  return req;
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++) await tick();
  assert.ok(predicate(), 'Expected boundary to be reached');
}
const moduleLoader = Module as unknown as { _load: (...args: any[]) => any };
const original = moduleLoader._load;
moduleLoader._load = function (name, ...args) {
  if (name === 'electron') return electron;
  if (name === 'node:https') return { get };
  if (name === 'node:fs/promises')
    return {
      ...fs,
      async readFile(file: string, ...rest: any[]) {
        assert.ok(
          String(file).startsWith(profile! + require('node:path').sep),
          'Read outside disposable profile',
        );
        assert.notEqual(
          String(file),
          join(profile!, 'credentials.json'),
          'Auth secrets must not be accessed',
        );
        if (String(file) === join(profile!, 'updates.json') && holdLoad) {
          load.held = true;
          await load.wait;
        }
        return (fs.readFile as any)(file, ...rest);
      },
      async writeFile(file: string, ...rest: any[]) {
        assert.ok(
          String(file).startsWith(profile! + require('node:path').sep),
          'Write outside disposable profile',
        );
        if (String(file) === join(profile!, 'updates.json.tmp') && holdWrite) {
          write.held = true;
          await write.wait;
        }
        return (fs.writeFile as any)(file, ...rest);
      },
    };
  return original.call(this, name, ...args);
};
globalThis.fetch = forbidden;
const source = createRequire(__filename)(process.argv[2]);
const { launch, Updates, createDemoFixture } = source;
launch(
  async (storage: any) => ({
    ...(await createDemoFixture()),
    updates: new Updates(
      storage,
      '0.1.0',
      process.platform,
      process.arch,
      true,
      undefined,
      () => time,
    ),
  }),
  true,
);

(async () => {
  await until(() => ready || !!dialogs.length);
  assert.deepEqual(dialogs, []);
  const event = () => ({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  const invoke = (name: string, ...args: any[]): any =>
    handlers.get(`canopy:${name}`)!(event(), ...args);
  assert.throws(
    () =>
      handlers.get('canopy:checkUpdates')!({
        sender: {},
        senderFrame: win.webContents.mainFrame,
      }),
    /Untrusted/,
  );
  assert.throws(() => invoke('checkUpdates', 'true'), /Invalid/);
  await assert.rejects(
    invoke('updatePreferences', {
      notifications: true,
      prereleases: false,
      endpoint: 'https://evil.test',
    }),
  );
  const selected = (state: UpdateState, expected = version) => {
    assert.equal(state.release?.version, expected);
    assert.equal(state.release?.notes, `Matching notes for v${expected}`);
    assert.deepEqual(state.release?.assets, [`Canopy-${expected}-${suffix}`]);
  };
  if (scenario === 'active-replacement') {
    await invoke('updatePreferences', {
      notifications: true,
      prereleases: false,
    });
    const pending = invoke('checkUpdates', true);
    await until(() => !!deliverHeld);
    await invoke('cancelUpdateCheck');
    time += 7 * 24 * 60 * 60 * 1000 + 1;
    version = '0.4.0';
    const fresh = await invoke('checkUpdates', true);
    selected(fresh);
    assert.equal(fresh.notice, true);
    deliverHeld!();
    const late = await pending;
    selected(late);
    assert.equal(late.notice, true);
    selected(await invoke('updateState'));
    assert.equal((await invoke('updateState')).notice, true);
    assert.equal(requests.length, 2);
  } else if (scenario.startsWith('retention-')) {
    const success: UpdateState = await invoke('checkUpdates');
    selected(success);
    const originalTime = success.checkedAt!;
    time += 3600001;
    status = 503;
    const failed: UpdateState = await invoke('checkUpdates');
    selected(failed);
    assert.equal(failed.stale, true);
    assert.equal(failed.notice, false);
    time = originalTime + 7 * 24 * 60 * 60 * 1000 - 1;
    selected(await invoke('updateState'));
    const count = requests.length;
    time++;
    if (scenario === 'retention-open')
      await assert.rejects(invoke('openRelease', 'v0.2.0'));
    const expired: UpdateState =
      scenario === 'retention-background'
        ? await invoke('checkUpdates', true)
        : await invoke('updateState');
    assert.equal(
      expired.release,
      undefined,
      'Stale release must expire at one week without another network request',
    );
    assert.equal(expired.checkedAt, undefined);
    assert.equal(expired.stale, false);
    assert.equal(expired.notice, false);
    assert.equal(requests.length, count);
    await assert.rejects(invoke('openRelease', 'v0.2.0'));
    if (scenario === 'retention-replacement') {
      status = 200;
      version = '0.4.0';
      await invoke('updatePreferences', {
        notifications: true,
        prereleases: false,
      });
      const fresh: UpdateState = await invoke('checkUpdates', true);
      selected(fresh);
      assert.equal(fresh.notice, true);
      selected(await invoke('updateState'));
      assert.equal((await invoke('updateState')).notice, true);
    }
  } else {
    let prefs: Promise<UpdateState> | undefined;
    if (scenario.startsWith('write-')) {
      selected(await invoke('checkUpdates'));
      time += 3600001;
      holdWrite = true;
      prefs = invoke('updatePreferences', {
        notifications: true,
        prereleases: false,
      });
      await until(() => write.held);
    } else await until(() => load.held);
    const before = requests.length;
    const pending: Promise<UpdateState> = invoke(
      'checkUpdates',
      scenario.startsWith('write-'),
    );
    await tick();
    const action = scenario.split('-')[1];
    if (action === 'cancel' || action === 'replacement')
      await invoke('cancelUpdateCheck');
    else if (action === 'destroyed') win.webContents.emit('destroyed');
    else if (action === 'quit') app.emit('before-quit');
    else if (action === 'preferences')
      prefs = invoke('updatePreferences', {
        notifications: false,
        prereleases: true,
      });
    let fresh: Promise<UpdateState> | undefined;
    if (action === 'replacement' || action === 'control') {
      version = '0.4.0';
      fresh = invoke(
        'checkUpdates',
        action === 'replacement' && scenario.startsWith('write-'),
      );
    }
    holdLoad = false;
    holdWrite = false;
    load.release();
    write.release();
    await prefs;
    const result = await pending;
    if (action === 'replacement' || action === 'control') {
      selected(await fresh!);
      assert.equal(
        requests.length,
        before + 1,
        'Replacement/dedup performs one request',
      );
      selected(await invoke('updateState'));
      assert.equal(
        (await invoke('updateState')).notice,
        scenario.startsWith('write-'),
      );
      // A cancelled older request can return a snapshot, but must not erase the
      // newer selection/notice or trigger another request after it settles.
      await tick();
      selected(await invoke('updateState'));
      assert.equal(requests.length, before + 1);
    } else {
      assert.equal(
        requests.length,
        before,
        'Cancelled queued check must not send HTTPS',
      );
      assert.equal(result.release, undefined);
      assert.ok(!result.notice);
      assert.equal((await invoke('updateState')).release, undefined);
      if (scenario.startsWith('write-')) {
        const saved = JSON.parse(
          await fs.readFile(join(profile!, 'updates.json'), 'utf8'),
        );
        assert.equal(saved.attemptedAt, undefined);
        assert.equal(saved.noticedAt, undefined);
      }
      if (action === 'preferences') {
        selected(await invoke('checkUpdates'), '0.8.0-rc.1'); // Deliberately requested AFTER the boundary.
        assert.equal(requests.length, before + 1);
      }
    }
  }
  const tree = await invoke('tree', 'demo', 'CAN-100');
  assert.ok(tree.issues.length);
  const edited = await invoke('update', 'demo', 'CAN-111', {
    summary: 'Disposable lifecycle audit edit',
  });
  assert.equal(edited.summary, 'Disposable lifecycle audit edit');
  assert.equal(
    (await invoke('preview', 'demo', 'CAN-111')).issue.summary,
    edited.summary,
  );
  await assert.rejects(invoke('openRelease', 'https://evil.test'));
  assert.deepEqual(dialogs, []);
  assert.deepEqual(browsers, []);
  assert.equal(
    (await fs.readdir(profile!)).includes('credentials.json'),
    false,
  );
  console.log(
    `PASS ${scenario}: actual main IPC + real Storage + production HTTPS adapter; no GUI/auth/provider/browser/clipboard`,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
