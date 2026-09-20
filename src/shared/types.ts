export type Choice = { id: string; name: string };
export type Status = Choice & { category: 'new' | 'indeterminate' | 'done' };
export type Connection = {
  id: string;
  name: string;
  url: string;
  provider: 'jira' | 'demo';
  accountName?: string;
};
export type Issue = {
  id: string;
  key: string;
  summary: string;
  type: string;
  parentKey?: string;
  priority: Choice | null;
  assignee: Choice | null;
  status: Status;
  links: { key: string; summary: string; relationship: string }[];
};
export type IssuePreview = {
  issue: Issue;
  description: string;
  comments: { id: string; author: string; created: string; body: string }[];
  totalComments: number;
  commentsError?: string;
};
export type SearchIssue = Issue & { updated?: string };
export type SearchPage = { issues: SearchIssue[]; nextPageToken?: string };
export type SearchOptions = { requestId: string; nextPageToken?: string };
export type TreeSnapshot = {
  rootKey: string;
  issues: Issue[];
  fetchedAt: number;
  warnings: string[];
  reconcilingRankParents?: string[];
  ranking?: {
    state: 'supported' | 'unsupported' | 'unknown';
    reason?: string;
    issueKeys: string[];
  };
};
export type TableColumn = 'issue' | 'priority' | 'assignee' | 'status';
export type TableSort = {
  column: TableColumn | 'rank';
  direction: 'asc' | 'desc';
};
export type RootView = {
  columns: TableColumn[];
  widths: Record<TableColumn, number>;
  sort: TableSort;
  textSize: 'small' | 'medium' | 'large';
  spacing: 'compact' | 'comfortable';
  hideDone: boolean;
  filters: TreeFilters;
};
export type IssuePatch = {
  summary?: string;
  priorityId?: string;
  assigneeId?: string | null;
  transitionId?: string;
};
export type AssigneePage = { users: Choice[]; nextStartAt?: number };
export type EditOptions = {
  priorities: Choice[];
  assignees: Choice[];
  transitions: (Choice & { requiresFields: boolean; to?: Status })[];
};
export type RootReference = {
  connectionId: string;
  rootKey: string;
  summary?: string;
};
export type TreeFilters = {
  assignee?: 'me' | 'unassigned';
  status?: string;
  priority?: string;
};
export type TabState = {
  view?: RootView;
  id: string;
  connectionId: string;
  rootKey: string;
  expanded: string[];
  linkedExpanded?: string[];
  summary?: string;
  filters?: TreeFilters;
  focusKey?: string;
  hideDone: boolean;
  selectedKey?: string;
  scrollTop: number;
};
export type Workspace = {
  tabs: TabState[];
  activeTabId: string | null;
  shortcuts: Record<string, string>;
  theme: 'system' | 'dark' | 'light';
  sidebarCollapsed: boolean;
  pinnedRoots?: RootReference[];
  recentRoots?: RootReference[];
  closedTabs?: TabState[];
  sidebarWidth?: number;
  previewWidth?: number;
  viewDefaults?: Record<string, RootView>;
  rootViews?: Record<string, RootView>;
};
export type TokenConnectionInput = {
  siteUrl: string;
  email: string;
  token: string;
  scoped: boolean;
};
export interface CanopyAPI {
  connections(): Promise<Connection[]>;
  currentUser(connectionId: string): Promise<Choice>;
  connect(input?: TokenConnectionInput): Promise<Connection[]>;
  disconnect(connectionId: string): Promise<void>;
  tree(connectionId: string, rootKey: string): Promise<TreeSnapshot>;
  preview(connectionId: string, key: string): Promise<IssuePreview>;
  copyText(value: string): Promise<void>;
  search(
    connectionId: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchPage>;
  cancelSearch(connectionId: string, requestId: string): Promise<void>;
  priorities(
    connectionId: string,
    key: string,
    refresh?: boolean,
  ): Promise<Choice[]>;
  transitions(
    connectionId: string,
    key: string,
    refresh?: boolean,
  ): Promise<EditOptions['transitions']>;
  cachedUsers(connectionId: string): Promise<Choice[]>;
  assignees(
    connectionId: string,
    key: string,
    query?: string,
    startAt?: number,
    refresh?: boolean,
  ): Promise<AssigneePage>;
  validateAssignee(
    connectionId: string,
    key: string,
    accountId: string,
    refresh?: boolean,
  ): Promise<Choice | null>;
  update(connectionId: string, key: string, patch: IssuePatch): Promise<Issue>;
  rank(
    connectionId: string,
    key: string,
    beforeKey: string,
    position?: 'before' | 'after',
  ): Promise<void>;
  priorityOrder(connectionId: string, keys: string[]): Promise<string[]>;
  loadWorkspace(): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  copyIssueLink(connectionId: string, key: string): Promise<void>;
  openIssue(connectionId: string, key: string): Promise<void>;
}
declare global {
  interface Window {
    canopy: CanopyAPI;
  }
}
