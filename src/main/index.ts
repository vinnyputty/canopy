import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Issue,
  IssuePatch,
  Workspace,
  TokenConnectionInput,
} from '../shared/types';
import { Auth } from './auth';
import { DemoProvider } from './demo';
import { JiraProvider } from './jira';
import { Storage } from './storage';

app.setName('Canopy');
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
  for (const tab of value.tabs) {
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
  }
  if (JSON.stringify(value).length > 4_000_000)
    throw new Error('Workspace is too large to save.');
  return value;
}
async function start() {
  const storage = new Storage(app.getPath('userData'));
  const auth = new Auth(storage, (url) => shell.openExternal(url));
  let authError: string | undefined;
  try {
    await auth.load();
  } catch (e) {
    authError = (e as Error).message;
  }
  const demo = new DemoProvider(
    (await storage.read<Issue[]>('demo')) ?? undefined,
    (issues) => storage.write('demo', issues),
  );
  const demoConnection = {
    id: 'demo',
    name: 'Canopy demo',
    url: 'https://example.invalid',
    provider: 'demo' as const,
  };
  const provider = (id: string) => {
    text(id);
    return id === 'demo'
      ? demo
      : new JiraProvider((path, init) => auth.request(id, path, init));
  };
  const handlers: Record<string, (...args: any[]) => unknown> = {
    connections: () => [demoConnection, ...auth.connections()],
    connect: async (input?: TokenConnectionInput) => {
      if (authError) throw new Error(authError);
      await auth.connect(input);
      return [demoConnection, ...auth.connections()];
    },
    disconnect: (id: string) => {
      text(id);
      if (id === 'demo')
        throw new Error('The demo workspace is always available.');
      return auth.disconnect(id);
    },
    tree: (id: string, root: string) => provider(id).tree(key(root)),
    search: (id: string, query: string) => provider(id).search(text(query)),
    editOptions: (id: string, issue: string, query?: string) =>
      provider(id).editOptions(
        key(issue),
        query === undefined || query === '' ? '' : text(query),
      ),
    update: (id: string, issue: string, value: IssuePatch) =>
      provider(id).update(key(issue), patch(value)),
    rank: (id: string, issue: string, before: string) =>
      provider(id).rank(key(issue), key(before)),
    loadWorkspace: () => storage.read<Workspace>('workspace'),
    saveWorkspace: (value: Workspace) =>
      storage.write('workspace', workspace(value)),
    openIssue: async (id: string, issue: string) => {
      const issueKey = key(issue);
      const connection = auth.connections().find((c) => c.id === id);
      if (!connection) throw new Error('Demo issues exist only in Canopy.');
      await shell.openExternal(
        `${connection.url}/browse/${encodeURIComponent(issueKey)}`,
      );
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
  const createWindow = async () => {
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 920,
      minHeight: 600,
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
        : []),
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
app
  .whenReady()
  .then(start)
  .catch((error) => {
    dialog.showErrorBox('Canopy could not start', (error as Error).message);
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
