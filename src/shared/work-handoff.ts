import type { Connection, Workspace, TreeSnapshot } from './types';

export type WorkHandoff =
  | {
      kind: 'issue';
      connection: string;
      provider: 'jira' | 'github';
      host: string;
      root: string;
      key: string;
    }
  | { kind: 'view'; view: string };

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
// Auth metadata uses github:hash, token:hash and OAuth grant:site IDs.
const connectionIdentifier = /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/;
const jiraKey = /^[A-Z][A-Z0-9_]*-[1-9]\d{0,15}$/;
const repo = /^[-\w.]{1,100}\/[-\w.]{1,100}$/;
const githubIssue = /^[-\w.]{1,100}\/[-\w.]{1,100}#[1-9]\d{0,15}$/;

function hasRepositoryDotSegment(value: string): boolean {
  return value
    .split('#')[0]
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

/** A proposed CLI payload. Transport is supplied by the single-instance runtime. */
export function parseWorkHandoff(value: unknown): WorkHandoff {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^canopy:\/\/handoff\/(?:issue|view)\?/.test(value) ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('Invalid handoff.');
  const url = new URL(value);
  if (
    url.protocol !== 'canopy:' ||
    url.hostname !== 'handoff' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Invalid handoff.');
  const names =
    url.pathname === '/issue'
      ? ['connection', 'provider', 'host', 'root', 'key']
      : url.pathname === '/view'
        ? ['view']
        : [];
  if (
    !names.length ||
    [...url.searchParams.keys()].length !== names.length ||
    names.some((name) => url.searchParams.getAll(name).length !== 1) ||
    [...url.searchParams.keys()].some((name) => !names.includes(name))
  )
    throw new Error('Invalid handoff fields.');
  const get = (name: string) => url.searchParams.get(name)!;
  if (url.pathname === '/view') {
    if (!identifier.test(get('view'))) throw new Error('Invalid saved view.');
    return { kind: 'view', view: get('view') };
  }
  const provider = get('provider');
  const root = get('root');
  const key = get('key');
  const host = get('host');
  if (
    get('connection').length > 128 ||
    !connectionIdentifier.test(get('connection')) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    host.length > 253 ||
    !(provider === 'github'
      ? host === 'github.com' &&
        (repo.test(root) || githubIssue.test(root)) &&
        githubIssue.test(key) &&
        !hasRepositoryDotSegment(root) &&
        !hasRepositoryDotSegment(key) &&
        key.split('#')[0] === root.split('#')[0]
      : provider === 'jira' && jiraKey.test(root) && jiraKey.test(key))
  )
    throw new Error('Invalid issue identity.');
  return {
    kind: 'issue',
    connection: get('connection'),
    provider: provider as 'jira' | 'github',
    host,
    root,
    key,
  };
}

/** Pass only the arguments following the executable/app path; never search arbitrary argv. */
export function parseWorkHandoffArguments(args: string[]): WorkHandoff | null {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--canopy-open')
    throw new Error('Invalid handoff command.');
  return parseWorkHandoff(args[1]);
}

/** Resolve against hydrated state and confirmed data without provider requests or fallback. */
export function resolveWorkHandoff(
  input: WorkHandoff,
  connections: Connection[],
  workspace: Workspace,
  snapshots: { connectionId: string; snapshot: TreeSnapshot }[],
): WorkHandoff {
  // Revalidate callers as well as parsed command input.
  const params = new URLSearchParams(
    input.kind === 'view'
      ? { view: input.view }
      : {
          connection: input.connection,
          provider: input.provider,
          host: input.host,
          root: input.root,
          key: input.key,
        },
  );
  input = parseWorkHandoff(`canopy://handoff/${input.kind}?${params}`);
  const knownConnection = (id: string) =>
    connections.filter((connection) => connection.id === id).length === 1;
  if (input.kind === 'view') {
    const viewId = input.view;
    const matches = (workspace.savedViews ?? []).filter(
      (view) => view.id === viewId,
    );
    const view = matches[0];
    if (
      matches.length !== 1 ||
      !view ||
      (!view.roots.length && !view.connectionIds.length) ||
      [
        ...view.connectionIds,
        ...view.roots.map((root) => root.connectionId),
      ].some((id) => !knownConnection(id)) ||
      view.roots.some(
        (root) =>
          !snapshots.some(
            ({ connectionId, snapshot }) =>
              connectionId === root.connectionId &&
              snapshot.rootKey === root.rootKey,
          ),
      )
    )
      throw new Error('Saved view is unavailable.');
    return input;
  }
  const target = input;
  const connection = connections.find(
    (connection) => connection.id === target.connection,
  );
  if (
    !knownConnection(target.connection) ||
    !connection ||
    connection.provider !== target.provider
  )
    throw new Error('Connection is unavailable.');
  const origin = new URL(connection.url);
  if (
    origin.protocol !== 'https:' ||
    origin.host !== target.host ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Connection host does not match.');
  const roots = [
    ...workspace.tabs,
    ...(workspace.pinnedRoots ?? []),
    ...(workspace.recentRoots ?? []),
    ...(workspace.savedViews ?? []).flatMap((view) => view.roots),
  ];
  if (
    !roots.some(
      (root) =>
        root.connectionId === target.connection && root.rootKey === target.root,
    ) ||
    !snapshots.some(
      ({ connectionId, snapshot }) =>
        connectionId === target.connection &&
        snapshot.rootKey === target.root &&
        snapshot.issues.some((issue) => issue.key === target.key),
    )
  )
    throw new Error('Issue is unavailable in the confirmed root.');
  return target;
}
