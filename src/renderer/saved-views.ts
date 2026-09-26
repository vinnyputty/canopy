import type {
  Connection,
  Issue,
  RootReference,
  SavedIssueView,
  TreeSnapshot,
  TabState,
  Workspace,
} from '../shared/types';

export type ViewSource = RootReference & { id: string };
export type ViewResult = { issue: Issue; source: ViewSource };

export function sourceTabId(source: ViewSource, tabs: TabState[]): string {
  return (
    tabs.find(
      (tab) =>
        tab.connectionId === source.connectionId &&
        tab.rootKey === source.rootKey,
    )?.id ?? source.id
  );
}

export const starterViews = (): SavedIssueView[] => [
  {
    id: 'assigned-to-me',
    name: 'Assigned to me',
    roots: [],
    connectionIds: [],
    filters: { assignee: 'me', statuses: [], priority: '', hideDone: true },
    sort: { column: 'key', direction: 'asc' },
  },
  {
    id: 'blocked',
    name: 'Blocked',
    roots: [],
    connectionIds: [],
    filters: {
      assignee: 'any',
      statuses: ['Blocked'],
      priority: '',
      hideDone: true,
    },
    sort: { column: 'key', direction: 'asc' },
  },
  {
    id: 'needs-review',
    name: 'Needs review',
    roots: [],
    connectionIds: [],
    filters: {
      assignee: 'any',
      statuses: ['Needs Review', 'In Review', 'Code Review', 'Review'],
      priority: '',
      hideDone: true,
    },
    sort: { column: 'key', direction: 'asc' },
  },
];

export function configuredRoots(
  workspace: Workspace,
  connections: Connection[],
): RootReference[] {
  const result = new Map<string, RootReference>();
  for (const root of [
    ...workspace.tabs,
    ...(workspace.closedTabs ?? []),
    ...(workspace.pinnedRoots ?? []),
    ...(workspace.recentRoots ?? []),
  ])
    result.set(JSON.stringify([root.connectionId, root.rootKey]), {
      connectionId: root.connectionId,
      rootKey: root.rootKey,
      summary: root.summary,
    });
  for (const connection of connections)
    for (const rootKey of connection.repositories ?? []) {
      const key = JSON.stringify([connection.id, rootKey]);
      if (!result.has(key))
        result.set(key, { connectionId: connection.id, rootKey });
    }
  for (const key of Object.keys(workspace.rootViews ?? {})) {
    try {
      const [connectionId, rootKey] = JSON.parse(key);
      if (typeof connectionId !== 'string' || typeof rootKey !== 'string')
        continue;
      const id = JSON.stringify([connectionId, rootKey]);
      if (!result.has(id)) result.set(id, { connectionId, rootKey });
    } catch {
      /* Ignore hand-edited keys. */
    }
  }
  return [...result.values()];
}

export function viewSources(
  view: SavedIssueView,
  available: RootReference[],
): ViewSource[] {
  const selected = new Map<string, ViewSource>();
  for (const root of [
    ...view.roots,
    ...available.filter((root) =>
      view.connectionIds.includes(root.connectionId),
    ),
  ]) {
    const key = JSON.stringify([root.connectionId, root.rootKey]);
    selected.set(key, { ...root, id: `saved-view:${key}` });
  }
  return [...selected.values()];
}

export function viewResults(
  view: SavedIssueView,
  sources: ViewSource[],
  snapshots: Record<string, TreeSnapshot>,
  users: Record<string, { id: string }>,
): ViewResult[] {
  const found = new Map<string, ViewResult>();
  for (const source of sources) {
    for (const issue of snapshots[source.id]?.issues ?? []) {
      if (view.filters.hideDone && issue.status.category === 'done') continue;
      if (
        view.filters.assignee === 'me' &&
        (!users[source.connectionId] ||
          issue.assignee?.id !== users[source.connectionId].id)
      )
        continue;
      if (view.filters.assignee === 'unassigned' && issue.assignee) continue;
      if (
        view.filters.statuses.length &&
        !view.filters.statuses.some(
          (status) =>
            status.toLocaleLowerCase() ===
            issue.status.name.toLocaleLowerCase(),
        )
      )
        continue;
      if (
        view.filters.priority &&
        view.filters.priority.toLocaleLowerCase() !==
          (issue.priority?.name ?? '').toLocaleLowerCase()
      )
        continue;
      const identity = JSON.stringify([source.connectionId, issue.id]);
      // First selected root wins, providing a stable place in the hierarchy.
      if (!found.has(identity)) found.set(identity, { issue, source });
    }
  }
  const property = (result: ViewResult) => {
    const issue = result.issue;
    switch (view.sort.column) {
      case 'summary':
        return issue.summary;
      case 'status':
        return issue.status.name;
      case 'priority':
        return issue.priority?.name ?? '';
      case 'assignee':
        return issue.assignee?.name ?? '';
      default:
        return issue.key;
    }
  };
  return [...found.values()].sort((a, b) => {
    const order = property(a).localeCompare(property(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return (
      (view.sort.direction === 'asc' ? order : -order) ||
      a.issue.key.localeCompare(b.issue.key) ||
      a.source.id.localeCompare(b.source.id)
    );
  });
}
