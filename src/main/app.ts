import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  screen,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Connection,
  IssuePatch,
  Workspace,
  TokenConnectionInput,
} from '../shared/types';
import { Auth } from './auth';
import { JiraProvider } from './jira';
import { Storage } from './storage';
import { restoreWindow, type WindowState } from './window-state';
import { configureLinuxCredentialStore } from './credentials';
import {
  recoverWorkspaceViews,
  validViewMap,
  validRootView,
} from '../shared/views';

app.setName('Canopy');
configureLinuxCredentialStore((store) =>
  app.commandLine.appendSwitch('password-store', store),
);
if (process.env.CANOPY_USER_DATA)
  app.setPath('userData', process.env.CANOPY_USER_DATA);
let window: BrowserWindow | null = null;
const html = join(__dirname, 'renderer/index.html');
function text(value: unknown, limit = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('Invalid input.');
  return value.trim();
}
function key(value: unknown) {
  const result = text(value).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(result))
    throw new Error('Enter a valid issue key, such as CAN-100.');
  return result;
}
function patch(value: unknown): IssuePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid issue edit.');
  const input = value as Record<string, unknown>;
  const result: IssuePatch = {};
  for (const name of Object.keys(input))
    if (!['summary', 'priorityId', 'assigneeId', 'transitionId'].includes(name))
      throw new Error('Unsupported issue field.');
  if ('summary' in input) result.summary = text(input.summary, 255);
  if ('priorityId' in input) result.priorityId = text(input.priorityId);
  if ('assigneeId' in input)
    result.assigneeId =
      input.assigneeId === null ? null : text(input.assigneeId);
  if ('transitionId' in input) result.transitionId = text(input.transitionId);
  return result;
}
function workspace(value: Workspace) {
  if (
    !value ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 100 ||
    !['system', 'light', 'dark'].includes(value.theme) ||
    typeof value.sidebarCollapsed !== 'boolean' ||
    typeof value.shortcuts !== 'object' ||
    !value.shortcuts
  )
    throw new Error('Invalid workspace.');
  if (
    (value.rootViews !== undefined && !validViewMap(value.rootViews)) ||
    (value.viewDefaults !== undefined && !validViewMap(value.viewDefaults))
  )
    throw new Error('Invalid table view.');
  for (const [name, minimum, maximum] of [
    ['sidebarWidth', 180, 400],
    ['previewWidth', 300, 720],
  ] as const) {
    if (
      value[name] !== undefined &&
      (!Number.isFinite(value[name]) ||
        value[name]! < minimum ||
        value[name]! > maximum)
    )
      throw new Error('Invalid pane width.');
  }
  for (const roots of [value.pinnedRoots, value.recentRoots]) {
    if (roots !== undefined && (!Array.isArray(roots) || roots.length > 1000))
      throw new Error('Invalid saved roots.');
    for (const root of roots ?? []) {
      text(root.connectionId);
      key(root.rootKey);
      if (
        root.summary !== undefined &&
        (typeof root.summary !== 'string' || root.summary.length > 10000)
      )
        throw new Error('Invalid root summary.');
    }
  }
  if (
    value.closedTabs !== undefined &&
    (!Array.isArray(value.closedTabs) || value.closedTabs.length > 20)
  )
    throw new Error('Invalid closed tabs.');
  for (const tab of [...value.tabs, ...(value.closedTabs ?? [])]) {
    if (tab.view !== undefined && !validRootView(tab.view))
      throw new Error('Invalid saved table view.');
    if (
      tab.linkedExpanded !== undefined &&
      (!Array.isArray(tab.linkedExpanded) ||
        tab.linkedExpanded.length > 100_000 ||
        !tab.linkedExpanded.every(
          (key) => typeof key === 'string' && key.length < 500,
        ))
    )
      throw new Error('Invalid linked expansion state.');
    text(tab.id);
    text(tab.connectionId);
    key(tab.rootKey);
    if (
      !Array.isArray(tab.expanded) ||
      tab.expanded.length > 100_000 ||
      !tab.expanded.every((k) => typeof k === 'string' && k.length < 500) ||
      typeof tab.hideDone !== 'boolean' ||
      !Number.isFinite(tab.scrollTop)
    )
      throw new Error('Invalid tab state.');
    if (tab.focusKey !== undefined) key(tab.focusKey);
    if (tab.filters !== undefined) {
      if (
        !tab.filters ||
        typeof tab.filters !== 'object' ||
        Array.isArray(tab.filters)
      )
        throw new Error('Invalid filters.');
      if (
        tab.filters.assignee !== undefined &&
        !['me', 'unassigned'].includes(tab.filters.assignee)
      )
        throw new Error('Invalid assignee filter.');
      if (tab.filters.status !== undefined) text(tab.filters.status);
      if (tab.filters.priority !== undefined) text(tab.filters.priority);
    }
  }
  if (JSON.stringify(value).length > 4_000_000)
    throw new Error('Workspace is too large to save.');
  return value;
}
type Fixture = {
  disconnect(): Promise<void>;
  openIssue(): never;
  connection: Connection;
  provider: Pick<
    JiraProvider,
    'preview' | 'tree' | 'search' | 'editOptions' | 'update' | 'rank' | 'priorityOrder'
  >;
};

async function start(
  createFixture?: (storage: Storage) => Promise<Fixture | undefined>,
) {
  const storage = new Storage(app.getPath('userData'));
  const auth = new Auth(storage, (url) => shell.openExternal(url));
  let authError: string | undefined;
  try {
    await auth.load();
  } catch (e) {
    authError = (e as Error).message;
  }
  let fixture = await createFixture?.(storage);
  const connections = () => [
    ...(fixture ? [fixture.connection] : []),
    ...auth.connections(),
  ];
  const provider = (id: string) => {
    text(id);
    if (fixture?.connection.id === id) return fixture.provider;
    if (!auth.connections().some((connection) => connection.id === id))
      throw new Error(
        'This connection is unavailable. Connect the Jira site again.',
      );
    return new JiraProvider((path, init) => auth.request(id, path, init));
  };
  const issueUrl = (id: string, issue: string) => {
    const issueKey = key(issue);
    const connection = connections().find((connection) => connection.id === id);
    if (!connection) throw new Error('This connection is unavailable.');
    return `${connection.url}/browse/${encodeURIComponent(issueKey)}`;
  };
  const handlers: Record<string, (...args: any[]) => unknown> = {
    connections,
    currentUser: async (id: string) => {
      provider(id);
      if (id === fixture?.connection.id)
        return { id: 'alex', name: 'Alex Morgan' };
      const user = await auth.request(id, '/rest/api/3/myself');
      return {
        id: text(user.accountId),
        name: text(user.displayName ?? user.accountId),
      };
    },
    connect: async (input?: TokenConnectionInput) => {
      if (authError) throw new Error(authError);
      await auth.connect(input);
      return connections();
    },
    disconnect: async (id: string) => {
      text(id);
      if (id === fixture?.connection.id) {
        await fixture.disconnect();
        fixture = undefined;
        return;
      }
      return auth.disconnect(id);
    },
    tree: (id: string, root: string) => provider(id).tree(key(root)),
    priorityOrder: (id: string, keys: unknown) => {
      if (!Array.isArray(keys) || keys.length > 1000)
        throw new Error('Invalid priority representatives.');
      return provider(id).priorityOrder(keys.map(key));
    },
    preview: (id: string, issue: string) => provider(id).preview(key(issue)),
    copyText: (value: string) => {
      if (typeof value !== 'string' || value.length > 100_000)
        throw new Error('Invalid clipboard text.');
      clipboard.writeText(value);
    },
    search: (id: string, query: string) => provider(id).search(text(query)),
    editOptions: (id: string, issue: string, query?: string) =>
      provider(id).editOptions(
        key(issue),
        query === undefined || query === '' ? '' : text(query),
      ),
    update: (id: string, issue: string, value: IssuePatch) =>
      provider(id).update(key(issue), patch(value)),
    rank: (
      id: string,
      issue: string,
      before: string,
      position: 'before' | 'after' = 'before',
    ) => {
      if (position !== 'before' && position !== 'after')
        throw new Error('Invalid rank position.');
      return provider(id).rank(key(issue), key(before), position);
    },
    loadWorkspace: async () => {
      const saved = await storage.read<Workspace>('workspace');
      return saved ? recoverWorkspaceViews(saved) : null;
    },
    saveWorkspace: (value: Workspace) =>
      storage.write('workspace', workspace(value)),
    copyIssueLink: (id: string, issue: string) =>
      clipboard.writeText(issueUrl(id, issue)),
    openIssue: async (id: string, issue: string) => {
      if (id === fixture?.connection.id) fixture.openIssue();
      await shell.openExternal(issueUrl(id, issue));
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`canopy:${name}`, (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== pathToFileURL(html).href
      )
        throw new Error('Untrusted application window.');
      return handler(...args);
    });
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  const createWindow = async () => {
    const saved = restoreWindow(
      await storage.read<WindowState>('window'),
      screen.getAllDisplays().map((display) => display.workArea),
    );
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: Math.min(920, saved?.bounds.width ?? 920),
      minHeight: Math.min(600, saved?.bounds.height ?? 600),
      ...(saved?.bounds ?? {}),
      title: 'Canopy',
      backgroundColor: '#141719',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const created = window;
    if (saved?.maximized) created.maximize();
    let savingWindow: Promise<void> = Promise.resolve();
    let closeApproved = false;
    const saveBounds = () => {
      if (
        created.isDestroyed() ||
        created.isMinimized() ||
        created.isFullScreen()
      )
        return;
      savingWindow = storage.write('window', {
        bounds: created.getNormalBounds(),
        maximized: created.isMaximized(),
      } satisfies WindowState);
      void savingWindow.catch((error) =>
        console.error('Could not save window state:', error),
      );
    };
    created.on('resize', saveBounds);
    created.on('move', saveBounds);
    created.on('maximize', saveBounds);
    created.on('unmaximize', saveBounds);
    created.on('close', (event) => {
      if (closeApproved) return;
      event.preventDefault();
      saveBounds();
      void savingWindow
        .catch(() => {})
        .finally(() => {
          closeApproved = true;
          if (quitting) app.quit();
          else created.close();
        });
    });
    window.webContents.on('before-input-event', (event, input) => {
      const modifier =
        process.platform === 'darwin' ? input.meta : input.control;
      if (
        input.type === 'keyDown' &&
        modifier &&
        !input.alt &&
        !input.shift &&
        input.key.toLowerCase() === 'q'
      ) {
        event.preventDefault();
        app.quit();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    window.on('closed', () => {
      window = null;
    });
    await window.loadFile(html);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Canopy',
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : [
            {
              label: 'File',
              submenu: [
                { role: 'quit' as const, accelerator: 'CommandOrControl+Q' },
              ],
            },
          ]),
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        ],
      },
    ]),
  );
  await createWindow();
  app.on('activate', () => {
    if (!window) void createWindow();
  });
}
export function launch(
  createFixture?: (storage: Storage) => Promise<Fixture | undefined>,
) {
  app
    .whenReady()
    .then(() => start(createFixture))
    .catch((error) => {
      dialog.showErrorBox('Canopy could not start', (error as Error).message);
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
