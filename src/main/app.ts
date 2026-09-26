import { Providers } from './providers';
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
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type {
  Connection,
  IssuePatch,
  Workspace,
  TokenConnectionInput,
  GithubConnectionInput,
} from '../shared/types';
import { Auth } from './auth';
import { JiraProvider } from './jira';
import {
  GithubProvider,
  githubKey,
  githubRootKey,
  githubRootUrl,
} from './github';
import { Storage } from './storage';
import { restoreWindow, type WindowState } from './window-state';
import { configureLinuxCredentialStore } from './credentials';
import { demoWorkspace } from './demo';
import {
  recoverWorkspaceViews,
  validSavedViews,
  validViewMap,
  validRootView,
} from '../shared/views';

app.setName('Canopy');
configureLinuxCredentialStore((store) =>
  app.commandLine.appendSwitch('password-store', store),
);
if (process.env.CANOPY_USER_DATA)
  app.setPath('userData', process.env.CANOPY_USER_DATA);
if (process.env.CANOPY_DEMO_TEMP === '1' && process.env.CANOPY_USER_DATA) {
  const directory = process.env.CANOPY_USER_DATA;
  process.on('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // The launching app also removes this directory after the demo exits.
    }
  });
}
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
function issueKey(value: unknown, connection?: Connection) {
  return connection?.provider === 'github'
    ? githubKey(text(value))
    : key(value);
}
function treeKey(value: unknown, connection?: Connection) {
  return connection?.provider === 'github'
    ? githubRootKey(text(value))
    : key(value);
}
function patch(value: unknown): IssuePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid issue edit.');
  const input = value as Record<string, unknown>;
  const result: IssuePatch = {};
  for (const name of Object.keys(input))
    if (
      ![
        'summary',
        'priorityId',
        'assigneeId',
        'transitionId',
        'labels',
      ].includes(name)
    )
      throw new Error('Unsupported issue field.');
  if ('summary' in input) result.summary = text(input.summary, 255);
  if ('priorityId' in input) result.priorityId = text(input.priorityId);
  if ('assigneeId' in input)
    result.assigneeId =
      input.assigneeId === null ? null : text(input.assigneeId);
  if ('transitionId' in input) result.transitionId = text(input.transitionId);
  if ('labels' in input) {
    if (!Array.isArray(input.labels) || input.labels.length > 100)
      throw new Error('Invalid labels.');
    result.labels = input.labels.map((label: unknown) => text(label, 100));
  }
  return result;
}
function workspace(value: Workspace) {
  if (
    !value ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 100 ||
    !['system', 'light', 'dark'].includes(value.theme) ||
    (value.palette !== undefined &&
      !['default', 'ocean', 'forest'].includes(value.palette)) ||
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
  if (value.savedViews !== undefined && !validSavedViews(value.savedViews))
    throw new Error('Invalid saved issue view.');
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
      if (
        typeof root.rootKey !== 'string' ||
        (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(root.rootKey) &&
          !/^[-\w.]+\/[-\w.]+#\d+$/i.test(root.rootKey) &&
          !/^[-\w.]+\/[-\w.]+$/i.test(root.rootKey))
      )
        throw new Error('Invalid root key.');
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
    if (
      typeof tab.rootKey !== 'string' ||
      (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(tab.rootKey) &&
        !/^[-\w.]+\/[-\w.]+#\d+$/i.test(tab.rootKey) &&
        !/^[-\w.]+\/[-\w.]+$/i.test(tab.rootKey))
    )
      throw new Error('Invalid root key.');
    if (
      !Array.isArray(tab.expanded) ||
      tab.expanded.length > 100_000 ||
      !tab.expanded.every((k) => typeof k === 'string' && k.length < 500) ||
      typeof tab.hideDone !== 'boolean' ||
      !Number.isFinite(tab.scrollTop)
    )
      throw new Error('Invalid tab state.');
    if (
      tab.focusKey !== undefined &&
      !/^[A-Z][A-Z0-9_]*-\d+$/i.test(tab.focusKey) &&
      !/^[-\w.]+\/[-\w.]+#\d+$/i.test(tab.focusKey) &&
      !/^[-\w.]+\/[-\w.]+$/i.test(tab.focusKey)
    )
      throw new Error('Invalid focus key.');
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
  if (value.seenRoots !== undefined) {
    if (
      !value.seenRoots ||
      typeof value.seenRoots !== 'object' ||
      Array.isArray(value.seenRoots) ||
      Object.keys(value.seenRoots).length > 12
    )
      throw new Error('Invalid last-seen roots.');
    for (const root of Object.values(value.seenRoots)) {
      if (
        !root ||
        !Number.isSafeInteger(root.touchedAt) ||
        !root.issues ||
        typeof root.issues !== 'object' ||
        Array.isArray(root.issues) ||
        Object.keys(root.issues).length > 1000
      )
        throw new Error('Invalid last-seen root.');
      for (const issue of Object.values(root.issues)) {
        if (
          !issue ||
          !Number.isSafeInteger(issue.seenAt) ||
          !issue.fields ||
          typeof issue.fields !== 'object' ||
          Array.isArray(issue.fields)
        )
          throw new Error('Invalid last-seen issue.');
      }
    }
  }
  return value;
}
type Fixture = {
  syncStatus?(): { retryAt: number | null };
  disconnect(): Promise<void>;
  openIssue(): never;
  connection: Connection;
  provider: Pick<
    JiraProvider,
    | 'preview'
    | 'tree'
    | 'search'
    | 'priorities'
    | 'transitions'
    | 'invalidateChoices'
    | 'cachedUsers'
    | 'assignees'
    | 'validateAssignee'
    | 'update'
    | 'rank'
    | 'priorityOrder'
  >;
};

async function start(
  createFixture?: (storage: Storage) => Promise<Fixture | undefined>,
  demoMode = false,
) {
  const storage = new Storage(app.getPath('userData'));
  const auth = new Auth(storage, (url) => shell.openExternal(url));
  let authError: string | undefined;
  if (!demoMode) {
    try {
      await auth.load();
    } catch (e) {
      authError = (e as Error).message;
    }
  }
  let fixture = await createFixture?.(storage);
  let demoWorkspaceState: Workspace = structuredClone(demoWorkspace);
  const connections = () => [
    ...(fixture ? [fixture.connection] : []),
    ...(demoMode ? [] : auth.connections()),
  ];
  const providers = new Providers(
    () => auth.connections(),
    (connection, current) =>
      new JiraProvider(async (path, init) => {
        current();
        const result = await auth.request(connection.id, path, init);
        current();
        return result;
      }),
  );
  const githubProviders = new Providers(
    () =>
      auth
        .connections()
        .filter((connection) => connection.provider === 'github'),
    (connection, current) =>
      new GithubProvider(connection, async (path, init) => {
        current();
        const result = await auth.githubRequest(connection.id, path, init);
        current();
        return result;
      }),
  );
  const provider = (id: string) => {
    text(id);
    if (fixture?.connection.id === id) return fixture.provider;
    if (
      connections().find((connection) => connection.id === id)?.provider ===
      'github'
    )
      return githubProviders.get(id);
    return providers.get(id);
  };
  const normalized = (id: string, value: unknown) =>
    issueKey(
      value,
      connections().find((connection) => connection.id === id),
    );
  const normalizedRoot = (id: string, value: unknown) =>
    treeKey(
      value,
      connections().find((connection) => connection.id === id),
    );
  const issueUrl = (id: string, issue: string) => {
    const connection = connections().find((connection) => connection.id === id);
    if (!connection) throw new Error('This connection is unavailable.');
    const value = normalizedRoot(id, issue);
    return connection.provider === 'github'
      ? githubRootUrl(value)
      : `${connection.url}/browse/${encodeURIComponent(value)}`;
  };
  const searches = new Map<string, AbortController>();
  const cancelSearch = (id: string, requestId: string) => {
    const owner = JSON.stringify([text(id), text(requestId)]);
    searches.get(owner)?.abort();
    searches.delete(owner);
  };
  let demoLaunch: symbol | null = null;
  const handlers: Record<string, (...args: any[]) => unknown> = {
    demoMode: () => demoMode,
    launchDemo: async () => {
      if (demoMode) throw new Error('The demo is already open.');
      if (demoLaunch) throw new Error('The demo is already open.');
      const launch = Symbol('demo launch');
      demoLaunch = launch;
      let directory: string | undefined;
      try {
        directory = await mkdtemp(join(tmpdir(), 'canopy-demo-'));
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CANOPY_USER_DATA: directory,
          CANOPY_DEMO_TEMP: '1',
        };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(
          process.execPath,
          [...(app.isPackaged ? [] : [app.getAppPath()]), '--canopy-demo'],
          { env, stdio: 'ignore' },
        );
        const childDirectory = directory;
        child.once('exit', () => {
          if (demoLaunch === launch) demoLaunch = null;
          void rm(childDirectory, { recursive: true, force: true });
          if (window && !window.isDestroyed()) {
            window.show();
            window.focus();
          }
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        child.unref();
      } catch (error) {
        if (demoLaunch === launch) demoLaunch = null;
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    closeDemo: () => {
      if (!demoMode) throw new Error('No demo is open in this window.');
      window?.close();
    },
    resetDemo: async () => {
      if (!demoMode || !createFixture)
        throw new Error('Reset is available in the demo workspace.');
      fixture = await createFixture(storage);
      demoWorkspaceState = structuredClone(demoWorkspace);
      window?.webContents.reload();
    },
    connections,
    currentUser: async (id: string) => {
      provider(id);
      if (id === fixture?.connection.id)
        return { id: 'alex', name: 'Alex Morgan' };
      if (connections().find((item) => item.id === id)?.provider === 'github') {
        const user = await auth.githubUser(id);
        return { id: text(user.login), name: text(user.login) };
      }
      const user = await auth.request(id, '/rest/api/3/myself');
      return {
        id: text(user.accountId),
        name: text(user.displayName ?? user.accountId),
      };
    },
    connect: async (input?: TokenConnectionInput) => {
      if (demoMode) throw new Error('Close the demo to connect an account.');
      if (authError) throw new Error(authError);
      try {
        await auth.connect(input);
      } finally {
        providers.reconcile();
      }
      return connections();
    },
    connectGithub: async (input: GithubConnectionInput) => {
      if (demoMode) throw new Error('Close the demo to connect an account.');
      if (authError) throw new Error(authError);
      try {
        await auth.connectGithub(input);
      } finally {
        githubProviders.reconcile();
      }
      return connections();
    },
    disconnect: async (id: string) => {
      if (demoMode) throw new Error('Close the demo to manage connections.');
      text(id);
      for (const [owner, controller] of searches) {
        if (JSON.parse(owner)[0] === id) {
          controller.abort();
          searches.delete(owner);
        }
      }
      if (id === fixture?.connection.id) {
        await fixture.disconnect();
        fixture = undefined;
        return;
      }
      try {
        await auth.disconnect(id);
      } finally {
        providers.remove(id);
        githubProviders.remove(id);
      }
    },
    syncStatus: (id: string) => {
      provider(id);
      return id === fixture?.connection.id
        ? (fixture.syncStatus?.() ?? { retryAt: null })
        : connections().find((item) => item.id === id)?.provider === 'github'
          ? auth.githubSyncStatus(id)
          : auth.syncStatus(id);
    },
    tree: (id: string, root: string) =>
      provider(id).tree(normalizedRoot(id, root)),
    priorityOrder: (id: string, keys: unknown) => {
      if (!Array.isArray(keys) || keys.length > 1000)
        throw new Error('Invalid priority representatives.');
      return provider(id).priorityOrder(
        keys.map((value) => normalized(id, value)),
      );
    },
    preview: (id: string, issue: string) =>
      provider(id).preview(normalized(id, issue)),
    issueUrl: (id: string, issue: string) => issueUrl(id, issue),
    copyText: (value: string) => {
      if (typeof value !== 'string' || value.length > 100_000)
        throw new Error('Invalid clipboard text.');
      clipboard.writeText(value);
    },
    search: async (
      id: string,
      query: string,
      options: { requestId: string; nextPageToken?: string },
    ) => {
      const client = provider(id);
      const requestId = text(options?.requestId);
      const token = options.nextPageToken;
      if (
        token !== undefined &&
        (typeof token !== 'string' || !token.length || token.length > 16_384)
      )
        throw new Error('Invalid search page token.');
      const owner = JSON.stringify([id, requestId]);
      cancelSearch(id, requestId);
      const controller = new AbortController();
      searches.set(owner, controller);
      try {
        return await client.search(text(query), token, controller.signal);
      } finally {
        if (searches.get(owner) === controller) searches.delete(owner);
      }
    },
    cancelSearch,
    priorities: (id: string, issue: string, refresh = false) =>
      provider(id).priorities(normalized(id, issue), refresh === true),
    labels: (id: string, issue: string) => {
      const client = provider(id);
      if (!(client instanceof GithubProvider))
        throw new Error('Labels are available for GitHub issues.');
      return client.labels(normalized(id, issue));
    },
    transitions: (id: string, issue: string, refresh = false) =>
      provider(id).transitions(normalized(id, issue), refresh === true),
    workflowGraph: (id: string, projectId: string, issueTypeId: string) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider)) return null;
      return client.workflowGraph(text(projectId), text(issueTypeId));
    },
    invalidateChoices: (id: string, issue: string) =>
      provider(id).invalidateChoices(normalized(id, issue)),
    cachedUsers: (id: string) => provider(id).cachedUsers(),
    assignees: (
      id: string,
      issue: string,
      query = '',
      startAt = 0,
      refresh = false,
    ) =>
      provider(id).assignees(
        normalized(id, issue),
        typeof query === 'string' && !query.trim() ? '' : text(query),
        startAt,
        refresh === true,
      ),
    validateAssignee: (
      id: string,
      issue: string,
      accountId: string,
      refresh = false,
    ) =>
      provider(id).validateAssignee(
        normalized(id, issue),
        text(accountId),
        refresh === true,
      ),
    update: (id: string, issue: string, value: IssuePatch) =>
      provider(id).update(normalized(id, issue), patch(value)),
    rank: (
      id: string,
      issue: string,
      before: string,
      position: 'before' | 'after' = 'before',
    ) => {
      if (position !== 'before' && position !== 'after')
        throw new Error('Invalid rank position.');
      return provider(id).rank(
        normalized(id, issue),
        normalized(id, before),
        position,
      );
    },
    loadWorkspace: async () => {
      if (demoMode) return structuredClone(demoWorkspaceState);
      const saved = await storage.read<Workspace>('workspace');
      return saved ? recoverWorkspaceViews(saved) : null;
    },
    saveWorkspace: (value: Workspace) => {
      const valid = workspace(value);
      if (demoMode) {
        demoWorkspaceState = structuredClone(valid);
        return;
      }
      return storage.write('workspace', valid);
    },
    copyIssueLink: (id: string, issue: string) =>
      demoMode && id === fixture?.connection.id
        ? Promise.reject(new Error('Demo issues have no Jira link.'))
        : clipboard.writeText(issueUrl(id, issue)),
    openIssue: async (id: string, issue: string) => {
      if (id === fixture?.connection.id) fixture.openIssue();
      await shell.openExternal(issueUrl(id, issue));
    },
    openLink: async (value: unknown) => {
      const url = new URL(text(value, 2048));
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Unsupported link URL.');
      await shell.openExternal(url.href);
    },
    openComment: async (id: string, issue: string, commentId: string) => {
      if (id === fixture?.connection.id) fixture.openIssue();
      const fragment =
        provider(id) instanceof GithubProvider ? 'issuecomment-' : 'comment-';
      if (!/^\d+$/.test(commentId)) throw new Error('Invalid comment ID.');
      await shell.openExternal(
        `${issueUrl(id, issue)}#${fragment}${commentId}`,
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
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  const createWindow = async () => {
    const saved = demoMode
      ? null
      : restoreWindow(
          await storage.read<WindowState>('window'),
          screen.getAllDisplays().map((display) => display.workArea),
        );
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: Math.min(920, saved?.bounds.width ?? 920),
      minHeight: Math.min(600, saved?.bounds.height ?? 600),
      ...(saved?.bounds ?? {}),
      title: demoMode ? 'Canopy — Demo' : 'Canopy',
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
    created.webContents.on('destroyed', () => {
      for (const controller of searches.values()) controller.abort();
      searches.clear();
    });
    if (saved?.maximized) created.maximize();
    let savingWindow: Promise<void> = Promise.resolve();
    let closeApproved = false;
    const saveBounds = () => {
      if (
        demoMode ||
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
  const openDemoFromMenu = () =>
    void Promise.resolve(handlers.launchDemo()).catch((error: unknown) =>
      dialog.showErrorBox(
        'Could not open demo',
        error instanceof Error ? error.message : String(error),
      ),
    );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Canopy',
              submenu: [
                { role: 'about' as const },
                ...(!demoMode
                  ? [
                      {
                        label: 'Try demo',
                        click: openDemoFromMenu,
                      },
                    ]
                  : [{ label: 'Close demo', click: () => window?.close() }]),
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
                ...(!demoMode
                  ? [
                      {
                        label: 'Try demo',
                        click: openDemoFromMenu,
                      },
                    ]
                  : [{ label: 'Close demo', click: () => window?.close() }]),
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
  demoMode = false,
) {
  app
    .whenReady()
    .then(() => start(createFixture, demoMode))
    .catch((error) => {
      dialog.showErrorBox('Canopy could not start', (error as Error).message);
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (demoMode || process.platform !== 'darwin') app.quit();
  });
}
