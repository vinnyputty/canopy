import { WorkHandoffQueue } from './work-handoff';
import {
  issueRelationships,
  relationshipKinds,
  relationshipFailure,
} from '../shared/relationships';
import { supportLinks, supportUrl } from '../shared/support';
import { isDeepStrictEqual } from 'node:util';
import {
  WorkspaceTransfer,
  readBackupFile,
  writeBackupFile,
} from './workspace-transfer';
import type { WorkspaceBackup, ImportMode } from '../shared/workspace-backup';
import { validateWorkspace } from '../shared/workspace-validation';
import { authoringAction } from '../shared/authoring';
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
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type {
  Connection,
  TreeSnapshot,
  IssuePatch,
  Workspace,
  TokenConnectionInput,
  GithubConnectionInput,
  ChildIssueInput,
} from '../shared/types';
import { Auth } from './auth';
import { diagnosticReport, exportDiagnosticReport } from './diagnostics';
import { JiraProvider, jiraRemoteLinkUrl } from './jira';
import {
  GithubProvider,
  githubDevelopmentUrl,
  githubKey,
  githubRootKey,
  githubRootUrl,
} from './github';
import { Storage } from './storage';
import { Updates } from './updates';
import { restoreWindow, type WindowState } from './window-state';
import { WindowStateSaver } from './window-state-saver';
import { configureLinuxCredentialStore } from './credentials';
import { demoWorkspace } from './demo';
import { recoverWorkspaceViews } from '../shared/views';

app.setName('Canopy');
if (process.platform === 'win32') app.setAppUserModelId('app.canopy.desktop');
if (process.platform === 'linux') app.setDesktopName('canopy.desktop');
configureLinuxCredentialStore((store) =>
  app.commandLine.appendSwitch('password-store', store),
);
if (process.env.CANOPY_USER_DATA)
  app.setPath('userData', process.env.CANOPY_USER_DATA);
let window: BrowserWindow | null = null;
const handoffs = new WorkHandoffQueue(() => {
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send('canopy:handoff', {
        session: '',
        rejected: true,
      });
    } catch {
      handoffs.cancel();
    }
  }
});
let resetHandoffCancellation = () => {};
let focusRequested = false;
let focusWindow = () => {
  focusRequested = true;
};
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
function childInput(value: unknown): ChildIssueInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid child issue.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (name) =>
        ![
          'typeId',
          'summary',
          'description',
          'assigneeId',
          'priorityId',
        ].includes(name),
    )
  )
    throw new Error('Unsupported child issue field.');
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' ||
      input.description.length > 100_000)
  )
    throw new Error('Invalid description.');
  return {
    typeId: text(input.typeId),
    summary: text(input.summary, 255),
    ...(input.description !== undefined
      ? { description: (input.description as string).trim() }
      : {}),
    ...(input.assigneeId !== undefined
      ? { assigneeId: text(input.assigneeId) }
      : {}),
    ...(input.priorityId !== undefined
      ? { priorityId: text(input.priorityId) }
      : {}),
  };
}

type Fixture = {
  updates?: Updates;
  syncStatus?(): { retryAt: number | null };
  disconnect(): Promise<void>;
  openIssue(): never;
  connection: Connection;
  provider: Pick<
    JiraProvider,
    | 'preview'
    | 'development'
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
  > &
    Partial<Pick<JiraProvider, 'relationships'>>;
};

async function start(
  createFixture?: (storage: Storage) => Promise<Fixture | undefined>,
  demoMode = false,
) {
  if (process.platform === 'darwin' && !app.isPackaged)
    app.dock?.setIcon(join(__dirname, 'branding/icons/512x512.png'));
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
  const updates =
    fixture?.updates ??
    new Updates(
      storage,
      app.getVersion(),
      process.platform,
      process.arch,
      app.isPackaged && !demoMode,
    );
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
  const trees = new Map<string, AbortController>();
  const searches = new Map<string, AbortController>();
  const cancelSearch = (id: string, requestId: string) => {
    const owner = JSON.stringify([text(id), text(requestId)]);
    searches.get(owner)?.abort();
    searches.delete(owner);
  };
  const relationshipRequests = new Map<string, AbortController>();
  const clearRelationshipRequests = () => {
    for (const controller of relationshipRequests.values()) controller.abort();
    relationshipRequests.clear();
  };
  const cancelRelationships = (id: string, requestId: string) => {
    const owner = JSON.stringify([text(id), text(requestId)]);
    relationshipRequests.get(owner)?.abort();
    relationshipRequests.delete(owner);
  };
  let demoLaunch: symbol | null = null;
  let savingWorkspace: Promise<void> = Promise.resolve();
  let receivedWorkspace: Workspace | undefined;
  let retryUnavailableWorkspace = false;
  let reviewedDiagnostics: string | undefined;
  let creatingWindow: Promise<void> | null = null;
  let supportPending = false;
  let supportSubscriber: BrowserWindow | null = null;
  const deliverSupport = () => {
    if (
      supportPending &&
      window &&
      supportSubscriber === window &&
      !window.isDestroyed()
    ) {
      supportPending = false;
      window.webContents.send('canopy:showSupport');
    }
  };
  const transfer = new WorkspaceTransfer(
    demoMode
      ? {
          read: async <T>() => structuredClone(demoWorkspaceState) as T,
          replaceWorkspace: async (expected, next, validate) => {
            validate?.();
            if (
              !isDeepStrictEqual(
                JSON.parse(JSON.stringify(demoWorkspaceState)),
                JSON.parse(JSON.stringify(expected)),
              )
            )
              throw new Error('Workspace changed after preview; review again.');
            demoWorkspaceState = structuredClone(next);
          },
        }
      : storage,
    connections,
  );
  const handlers: Record<string, (...args: any[]) => unknown> = {
    handoffReady: (clientId: unknown) => {
      if (
        typeof clientId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          clientId,
        )
      )
        throw new Error('Invalid handoff owner.');
      if (quitting || closingWindow || !window || window.isDestroyed())
        throw new Error('Canopy is closing.');
      const owner = window;
      resetHandoffCancellation();
      return handoffs.ready((state) => {
        if (window === owner && !owner.isDestroyed()) {
          try {
            owner.webContents.send('canopy:handoff', state);
          } catch {
            handoffs.cancel();
          }
        }
      }, clientId);
    },
    handoffAck: (session: unknown, id: unknown, result: unknown) =>
      handoffs.acknowledge(session, id, result),
    handoffCancel: (session: unknown) => handoffs.cancel(text(session, 128)),
    updateState: () => updates.snapshot(),
    updatePreferences: (value: unknown) => updates.preferences(value),
    checkUpdates: (background: unknown) => {
      if (background !== undefined && typeof background !== 'boolean')
        throw new Error('Invalid update check.');
      return updates.check(background === true);
    },
    cancelUpdateCheck: () => updates.cancel(),
    dismissUpdateNotice: () => updates.dismiss(),
    openRelease: (tag: unknown) =>
      updates.open(tag, (url) => shell.openExternal(url)),
    diagnostics: () => {
      let credentialStorage: 'available' | 'unavailable' | 'unlock-failed' =
        authError ? 'unlock-failed' : 'available';
      try {
        storage.assertSecure();
      } catch {
        credentialStorage = 'unavailable';
      }
      reviewedDiagnostics = diagnosticReport({
        version: app.getVersion(),
        platform: process.platform,
        demoMode,
        credentialStorage,
        connections: connections(),
        retryAt: (connection) =>
          connection.provider === 'github'
            ? auth.githubSyncStatus(connection.id).retryAt
            : auth.syncStatus(connection.id).retryAt,
      });
      return reviewedDiagnostics;
    },
    exportDiagnostics: (reviewed: unknown) =>
      exportDiagnosticReport(reviewed, reviewedDiagnostics, async () => {
        const result = await dialog.showSaveDialog(window!, {
          title: 'Export reviewed diagnostics',
          defaultPath: 'canopy-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        return result.canceled ? undefined : result.filePath;
      }),
    supportReady: () => {
      supportSubscriber = window;
      deliverSupport();
    },
    appVersion: () => app.getVersion(),
    openSupportLink: (link: unknown) => shell.openExternal(supportUrl(link)),
    demoMode: () => demoMode,
    demoTimeScale: () => {
      const scale = Number(process.env.CANOPY_DEMO_TIME_SCALE ?? 1);
      return demoMode && Number.isFinite(scale) && scale > 0 && scale <= 1
        ? scale
        : 1;
    },
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
            if (!window.isVisible()) window.show();
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
      for (const [owner, controller] of [...searches, ...trees]) {
        if (JSON.parse(owner)[0] === id) {
          controller.abort();
          searches.delete(owner);
          trees.delete(owner);
        }
      }
      for (const [owner, controller] of relationshipRequests) {
        if (JSON.parse(owner)[0] === id) {
          controller.abort();
          relationshipRequests.delete(owner);
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
    tree: async (id: string, root: string, requestId?: string) => {
      const client = provider(id);
      const key = normalizedRoot(id, root);
      if (requestId === undefined) return client.tree(key);
      const owner = JSON.stringify([text(id), text(requestId)]);
      trees.get(owner)?.abort();
      const controller = new AbortController();
      trees.set(owner, controller);
      try {
        return await client.tree(key, {
          signal: controller.signal,
          progress: (snapshot: TreeSnapshot) => {
            if (
              trees.get(owner) === controller &&
              window &&
              !window.isDestroyed()
            )
              window.webContents.send(
                'canopy:treeProgress',
                requestId,
                snapshot,
              );
          },
        });
      } finally {
        if (trees.get(owner) === controller) trees.delete(owner);
      }
    },
    cancelTree: (id: string, requestId: string) => {
      trees.get(JSON.stringify([text(id), text(requestId)]))?.abort();
    },
    priorityOrder: (id: string, keys: unknown) => {
      if (!Array.isArray(keys) || keys.length > 1000)
        throw new Error('Invalid priority representatives.');
      return provider(id).priorityOrder(
        keys.map((value) => normalized(id, value)),
      );
    },
    preview: (id: string, issue: string) =>
      provider(id).preview(normalized(id, issue)),
    relationships: async (id: string, issue: string, requestId: string) => {
      const key = normalized(id, issue);
      const client = provider(id);
      const owner = JSON.stringify([id, text(requestId)]);
      cancelRelationships(id, requestId);
      if (relationshipRequests.size >= 16)
        throw new Error('Too many relationship requests. Retry shortly.');
      const controller = new AbortController();
      relationshipRequests.set(owner, controller);
      try {
        const graph = client.relationships
          ? await client.relationships(key, controller.signal)
          : issueRelationships((await client.preview(key)).issue);
        controller.signal.throwIfAborted();
        return graph;
      } catch (error) {
        return {
          key,
          groups: relationshipKinds.map((kind) => ({
            kind,
            state: 'unavailable',
            items: [],
            ...relationshipFailure(error, controller.signal),
          })),
        };
      } finally {
        if (relationshipRequests.get(owner) === controller)
          relationshipRequests.delete(owner);
      }
    },
    cancelRelationships,
    olderComments: (id: string, issue: string, page: number) => {
      const client = provider(id);
      if (!(client instanceof GithubProvider))
        throw new Error('Older comment pages are available only for GitHub.');
      return client.olderComments(normalized(id, issue), page);
    },
    issueUrl: (id: string, issue: string) => issueUrl(id, issue),
    authoringOptions: (id: string, issue: string) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider || client instanceof GithubProvider))
        throw new Error('Authoring is unavailable for demo issues.');
      return client.authoring.options(normalized(id, issue));
    },
    previewParent: (id: string, issue: string, parent: string | null) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider || client instanceof GithubProvider))
        throw new Error('Parent changes are unavailable for demo issues.');
      return client.authoring.plan(
        normalized(id, issue),
        parent === null ? null : normalized(id, parent),
      );
    },
    author: (id: string, issue: string, value: unknown) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider || client instanceof GithubProvider))
        throw new Error('Authoring is unavailable for demo issues.');
      const action = authoringAction(value);
      const issueKey = normalized(id, issue);
      if (action.kind === 'parent') {
        action.plan.key = normalized(id, action.plan.key);
        if (action.plan.key !== issueKey)
          throw new Error('Preview belongs to a different issue.');
        if (action.plan.parentKey)
          action.plan.parentKey = normalized(id, action.plan.parentKey);
        if (action.plan.previousParent)
          action.plan.previousParent = normalized(
            id,
            action.plan.previousParent,
          );
      }
      return client.authoring.write(issueKey, action);
    },
    openAttachment: async (id: string, issue: string, attachmentId: string) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider || client instanceof GithubProvider))
        throw new Error('Attachments are unavailable for demo issues.');
      const options = await client.authoring.options(normalized(id, issue));
      const attachment = options.attachments.find(
        (item) => item.id === text(attachmentId),
      );
      if (!attachment)
        throw new Error('Attachment is unavailable. Refresh and try again.');
      const connection = connections().find((item) => item.id === id)!;
      const url =
        client instanceof JiraProvider
          ? new URL(
              `/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`,
              connection.url,
            )
          : new URL(attachment.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (client instanceof GithubProvider &&
          !['github.com', 'user-images.githubusercontent.com'].includes(
            url.hostname,
          ))
      )
        throw new Error('Invalid attachment URL.');
      await shell.openExternal(url.href);
    },
    development: (id: string, issue: string) =>
      provider(id).development(normalized(id, issue)),
    openDevelopmentLink: (id: string, url: string) => {
      const client = provider(id);
      const safe =
        client instanceof GithubProvider
          ? githubDevelopmentUrl(url)
          : client instanceof JiraProvider
            ? jiraRemoteLinkUrl(url)
            : null;
      if (!safe) throw new Error('Development links are unavailable here.');
      return shell.openExternal(safe);
    },
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
    childCreateOptions: (id: string, issue: string, refresh = false) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider))
        throw new Error('Child creation is available for Jira issues.');
      return client.childCreateOptions(normalized(id, issue), refresh === true);
    },
    childCreateFields: (id: string, issue: string, typeId: string) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider))
        throw new Error('Child creation is available for Jira issues.');
      return client.childCreateFields(normalized(id, issue), text(typeId));
    },
    createChild: (id: string, issue: string, value: ChildIssueInput) => {
      const client = provider(id);
      if (!(client instanceof JiraProvider))
        throw new Error('Child creation is available for Jira issues.');
      return client.createChild(normalized(id, issue), childInput(value));
    },
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
    prepareWorkspaceExport: () => transfer.prepareExport(),
    exportWorkspace: async (token: string) => {
      const contents = transfer.exportContents(text(token));
      const result = await dialog.showSaveDialog({
        title: 'Export reviewed workspace backup',
        defaultPath: 'canopy-workspace.json',
        filters: [{ name: 'Workspace backup', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeBackupFile(result.filePath, contents, app.getPath('userData'));
      return true;
    },
    chooseWorkspaceBackup: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Preview workspace backup',
        properties: ['openFile'],
        filters: [{ name: 'Workspace backup', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return readBackupFile(result.filePaths[0]);
    },
    previewWorkspaceImport: (
      backup: WorkspaceBackup,
      mapping: Record<string, string>,
      mode: ImportMode,
    ) => transfer.preview(backup, mapping, mode),
    applyWorkspaceImport: (token: string) => transfer.apply(text(token)),
    canUndoWorkspaceImport: () => transfer.canUndo(),
    rollbackWorkspaceImport: () => transfer.rollback(),
    reloadWorkspace: () => window?.webContents.reload(),
    loadWorkspace: async () => {
      if (demoMode) return structuredClone(demoWorkspaceState);
      const saved = await storage.read<Workspace>('workspace');
      return saved ? recoverWorkspaceViews(saved) : null;
    },
    saveWorkspace: (value: Workspace) => {
      const valid = validateWorkspace(value);
      if (demoMode) {
        demoWorkspaceState = structuredClone(valid);
        return;
      }
      receivedWorkspace = valid;
      retryUnavailableWorkspace = false;
      savingWorkspace = storage.write('workspace', valid);
      return savingWorkspace;
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
  let closingWindow: Promise<void> | undefined;
  app.on('before-quit', () => {
    quitting = true;
    updates.cancel();
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
      show: !saved?.maximized,
      title: demoMode ? 'Canopy — Demo' : 'Canopy',
      icon: join(
        __dirname,
        process.platform === 'win32'
          ? 'branding/icon.ico'
          : 'branding/icons/256x256.png',
      ),
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
    let initialLoad = true;
    let handoffCanceled = false;
    const cancelHandoffs = () => {
      if (handoffCanceled || window !== created) return;
      handoffCanceled = true;
      handoffs.cancel();
    };
    resetHandoffCancellation = () => {
      handoffCanceled = false;
    };
    created.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // Reload/navigation can destroy the renderer before its cancellation IPC
      // arrives. Release the departing document's provider reads in main too.
      for (const controller of trees.values()) controller.abort();
      trees.clear();
      clearRelationshipRequests();
      if (!initialLoad) cancelHandoffs();
    });
    created.webContents.on('render-process-gone', () => {
      clearRelationshipRequests();
      cancelHandoffs();
    });
    created.webContents.on('did-start-loading', () => {
      if (window === created) supportSubscriber = null;
    });
    created.webContents.on('destroyed', () => {
      cancelHandoffs();
      updates.cancel();
      for (const controller of trees.values()) controller.abort();
      trees.clear();
      for (const controller of searches.values()) controller.abort();
      searches.clear();
      clearRelationshipRequests();
    });
    const windowStateSaver = new WindowStateSaver(
      (state) => storage.write('window', state),
      (error) => console.error('Could not save window state:', error),
    );
    let closeApproved = false;
    let closing = false;
    let rendererLoaded: Promise<void>;
    let rendererUnavailable = false;
    created.webContents.on('render-process-gone', () => {
      rendererUnavailable = true;
    });
    created.webContents.on(
      'did-fail-load',
      (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) rendererUnavailable = true;
      },
    );
    created.webContents.on('did-finish-load', () => {
      rendererUnavailable =
        created.webContents.getURL() !== pathToFileURL(html).href;
    });
    const flushRenderer = async (signal: AbortSignal) => {
      if (!rendererUnavailable && !created.webContents.isCrashed()) {
        let unavailable: () => void;
        const failedLoad = (
          _event: unknown,
          code: number,
          _description: string,
          _url: string,
          mainFrame: boolean,
        ) => {
          if (mainFrame && code !== -3) unavailable();
        };
        const lostRenderer = new Promise<true>((resolve) => {
          unavailable = () => resolve(true);
          created.webContents.once('render-process-gone', unavailable);
          created.webContents.on('did-fail-load', failedLoad);
        });
        const unsubscribe = () => {
          created.webContents.removeListener(
            'render-process-gone',
            unavailable!,
          );
          created.webContents.removeListener('did-fail-load', failedLoad);
          signal.removeEventListener('abort', unsubscribe);
        };
        signal.addEventListener('abort', unsubscribe, { once: true });
        try {
          const lost = await Promise.race([
            lostRenderer,
            (async () => {
              await rendererLoaded;
              await created.webContents.executeJavaScript(
                'window.canopy.flushWorkspace()',
              );
              return false;
            })(),
          ]);
          if (!lost) return false;
        } catch (error) {
          if (!rendererUnavailable && !created.webContents.isCrashed())
            throw error;
        } finally {
          unsubscribe();
        }
      }
      // Preserve writes already received when an unavailable renderer cannot
      // supply newer state. The overall close deadline also bounds this drain.
      if (retryUnavailableWorkspace && receivedWorkspace) {
        retryUnavailableWorkspace = false;
        savingWorkspace = storage.write('workspace', receivedWorkspace);
      }
      try {
        await savingWorkspace;
      } catch (error) {
        retryUnavailableWorkspace = true;
        throw error;
      }
      return true;
    };
    const flushBeforeClose = async () => {
      const timedOut = new Error(
        'Workspace save did not finish before the close deadline.',
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const attempt = new AbortController();
      try {
        const [, forceClose] = await Promise.race([
          Promise.all([
            windowStateSaver.flush(),
            flushRenderer(attempt.signal),
          ]).then(async (result) => {
            await windowStateSaver.flush();
            return result;
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(timedOut), 15_000);
          }),
        ]);
        return forceClose;
      } catch (error) {
        attempt.abort();
        if (
          error !== timedOut &&
          !rendererUnavailable &&
          !created.webContents.isCrashed()
        )
          throw error;
        const { response } = await dialog.showMessageBox(created, {
          type: 'warning',
          message:
            error === timedOut
              ? 'The workspace save has not finished.'
              : 'The workspace could not be saved.',
          detail:
            error === timedOut
              ? 'Keep Canopy open to allow saving or recovery. Closing anyway abandons unfinished writes and may lose the latest workspace changes.'
              : `${error instanceof Error ? error.message : String(error)}\n\nThe renderer is unavailable. Keep Canopy open to repair storage and retry closing; only workspace changes already received can be retried. Closing anyway abandons those changes.`,
          buttons: ['Keep open', 'Close anyway'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response !== 1) throw error;
        return true;
      } finally {
        attempt.abort();
        clearTimeout(deadline);
      }
    };
    const saveBounds = () => {
      if (
        demoMode ||
        created.isDestroyed() ||
        created.isMinimized() ||
        created.isFullScreen()
      )
        return;
      windowStateSaver.update({
        bounds: created.getNormalBounds(),
        maximized: created.isMaximized(),
      } satisfies WindowState);
    };
    created.on('resize', saveBounds);
    created.on('move', saveBounds);
    created.on('maximize', saveBounds);
    created.on('unmaximize', saveBounds);
    created.on('close', (event) => {
      if (closeApproved) return;
      handoffCanceled = true;
      handoffs.pause();
      event.preventDefault();
      if (closing) return;
      closing = true;
      let resolveClosing!: () => void;
      closingWindow = new Promise<void>((resolve) => {
        resolveClosing = resolve;
      });
      const finishClosing = () => {
        closingWindow = undefined;
        resolveClosing();
      };
      created.once('closed', finishClosing);
      saveBounds();
      void flushBeforeClose()
        .then((forceClose) => {
          closeApproved = true;
          if (forceClose) created.destroy();
          if (quitting) app.quit();
          else if (!created.isDestroyed()) created.close();
        })
        .catch((error) => {
          closing = false;
          quitting = false;
          windowStateSaver.resume();
          handoffCanceled = false;
          handoffs.resume();
          created.removeListener('closed', finishClosing);
          finishClosing();
          console.error('Could not save workspace before closing:', error);
        });
    });
    created.on('query-session-end', (event) => {
      // Windows marks forced termination as critical; that request cannot
      // promise time to persist and must not start another blocking close.
      if (closeApproved || event.reasons.includes('critical')) return;
      event.preventDefault();
      app.quit();
    });
    if (saved?.maximized) {
      // X11 must receive maximized state before mapping to retain normal bounds.
      created.maximize();
      created.show();
    }
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
    created.on('closed', () => {
      for (const controller of trees.values()) controller.abort();
      trees.clear();
      if (window === created) {
        window = null;
        supportSubscriber = null;
        handoffs.resume(true);
      }
    });
    rendererLoaded = created.loadFile(html).catch((error) => {
      rendererUnavailable = true;
      throw error;
    });
    try {
      await rendererLoaded;
      initialLoad = false;
    } catch (error) {
      if (window === created) {
        window = null;
        supportSubscriber = null;
        if (!created.isDestroyed()) created.destroy();
      }
      throw error;
    }
  };
  const ensureWindow = async (): Promise<void> => {
    if (closingWindow) await closingWindow;
    if (quitting) return;
    if (creatingWindow) return creatingWindow;
    if (window) return Promise.resolve();
    creatingWindow = createWindow().finally(() => {
      creatingWindow = null;
    });
    return creatingWindow;
  };
  const openDemoFromMenu = () =>
    void Promise.resolve(handlers.launchDemo()).catch((error: unknown) =>
      dialog.showErrorBox(
        'Could not open demo',
        error instanceof Error ? error.message : String(error),
      ),
    );
  const showSupport = () => {
    supportPending = true;
    void ensureWindow()
      .then(() => {
        if (!window || quitting) return;
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        window.focus();
        deliverSupport();
      })
      .catch((error: Error) =>
        dialog.showErrorBox('Could not open About & Support', error.message),
      );
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Canopy',
              submenu: [
                { label: 'About Canopy', click: showSupport },
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
        label: 'Help',
        submenu: [
          { label: 'About & Support', click: showSupport },
          ...Object.values(supportLinks).map(({ label, url }) => ({
            label,
            click: () =>
              void shell
                .openExternal(url)
                .catch((error: Error) =>
                  dialog.showErrorBox(
                    'Could not open support link',
                    error.message,
                  ),
                ),
          })),
        ],
      },
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
  const showWindow = async () => {
    await ensureWindow();
    if (quitting) return;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      if (process.platform === 'darwin') app.focus({ steal: true });
      window.focus();
    }
  };
  await showWindow();
  let pendingFocusRequests = 0;
  focusWindow = () => {
    pendingFocusRequests += 1;
    focusRequested = true;
    void showWindow()
      .catch((error) =>
        dialog.showErrorBox('Canopy could not open', (error as Error).message),
      )
      .finally(() => {
        pendingFocusRequests -= 1;
        focusRequested = pendingFocusRequests > 0;
      });
  };
  if (focusRequested) focusWindow();
  app.on('activate', focusWindow);
}
export function launch(
  createFixture?: (storage: Storage) => Promise<Fixture | undefined>,
  demoMode = false,
  handoffArguments: string[] = [],
) {
  // Electron scopes this lock to userData, including isolated demo/smoke profiles.
  // Acquire it before readiness or reading any profile state.
  const boundedArgs =
    handoffArguments.length <= 2 &&
    handoffArguments.every(
      (arg) => typeof arg === 'string' && arg.length <= 2048,
    )
      ? handoffArguments
      : ['--invalid-canopy-command'];
  if (
    !app.requestSingleInstanceLock({
      canopyArguments: boundedArgs,
      canopyMode: demoMode ? 'demo' : 'main',
    })
  ) {
    app.quit();
    return;
  }
  app.on('before-quit', () => handoffs.pause());
  app.on('will-quit', () => handoffs.stop());
  handoffs.receive(boundedArgs);
  app.on('second-instance', (_event, _argv, _directory, data: unknown) => {
    if (data !== undefined) {
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        Object.keys(data).length !== 2 ||
        !('canopyArguments' in data) ||
        !('canopyMode' in data) ||
        data.canopyMode !== (demoMode ? 'demo' : 'main')
      )
        handoffs.reject();
      else handoffs.receive(data.canopyArguments);
    }
    focusWindow();
  });
  app
    .whenReady()
    .then(() => start(createFixture, demoMode))
    .catch((error) => {
      dialog.showErrorBox('Canopy could not start', (error as Error).message);
      app.quit();
    });
  app.on('window-all-closed', () => {
    if ((demoMode || process.platform !== 'darwin') && !focusRequested)
      app.quit();
  });
}
