import type {
  Connection,
  Issue,
  Workspace,
  TreeSnapshot,
} from '../../src/shared/types';

export const issue: Issue = {
  id: '42',
  key: 'team/repo#42',
  summary: 'Fix',
  type: 'Issue',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
};
export const connection: Connection = {
  id: 'account-a',
  name: 'Sample',
  provider: 'github',
  url: 'https://github.com',
  repositories: ['team/repo'],
};
export const workspace: Workspace = {
  tabs: [],
  activeTabId: null,
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
  pinnedRoots: [{ connectionId: connection.id, rootKey: 'team/repo' }],
};
export const snapshot: TreeSnapshot = {
  rootKey: 'team/repo',
  issues: [issue],
  fetchedAt: 1,
  warnings: [],
};
