export type Choice = { id: string; name: string };
export type Status = Choice & { category: 'new' | 'indeterminate' | 'done' };
export type Connection = {
  id: string;
  name: string;
  url: string;
  provider: 'jira' | 'github' | 'demo';
  accountName?: string;
  repositories?: string[];
};
export type Issue = {
  id: string;
  key: string;
  summary: string;
  type: string;
  typeId?: string;
  projectId?: string;
  parentKey?: string;
  priority: Choice | null;
  assignee: Choice | null;
  status: Status;
  links: {
    key: string;
    summary: string;
    relationship: string;
    statusCategory?: Status['category'];
  }[];
  linksAvailable?: boolean;
  labels?: Choice[];
  commentCount?: number;
  unavailableFields?: string[];
};
export type IssuePreview = {
  issue: Issue;
  description: string;
  descriptionMarkdown?: string;
  descriptionDocument?: unknown;
  comments: {
    id: string;
    author: string;
    created: string;
    body: string;
    bodyDocument?: unknown;
  }[];
  totalComments: number;
  commentsError?: string;
  linksError?: string;
};
export type SearchIssue = Issue & { updated?: string };
export type SearchPage = {
  issues: SearchIssue[];
  nextPageToken?: string;
  nextPageKind?: 'issues' | 'repositories';
};
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
  assumeMatchingStatusTransitions: boolean;
  filters: TreeFilters;
};
export type IssuePatch = {
  summary?: string;
  priorityId?: string;
  assigneeId?: string | null;
  transitionId?: string;
  labels?: string[];
};
export type AssigneePage = { users: Choice[]; nextStartAt?: number };
export type EditOptions = {
  priorities: Choice[];
  assignees: Choice[];
  transitions: (Choice & { requiresFields: boolean; to?: Status })[];
};
export type StatusTransitionTree = Record<string, EditOptions['transitions']>;
export type RootReference = {
  connectionId: string;
  rootKey: string;
  summary?: string;
};
export type SavedIssueView = {
  id: string;
  name: string;
  roots: RootReference[];
  connectionIds: string[];
  filters: {
    assignee: 'any' | 'me' | 'unassigned';
    statuses: string[];
    priority: string;
    hideDone: boolean;
  };
  sort: {
    column: 'key' | 'summary' | 'status' | 'priority' | 'assignee';
    direction: 'asc' | 'desc';
  };
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
  palette?: 'default' | 'ocean' | 'forest';
  sidebarCollapsed: boolean;
  pinnedRoots?: RootReference[];
  recentRoots?: RootReference[];
  closedTabs?: TabState[];
  sidebarWidth?: number;
  previewWidth?: number;
  viewDefaults?: Record<string, RootView>;
  rootViews?: Record<string, RootView>;
  savedViews?: SavedIssueView[];
  activeSavedViewId?: string | null;
  seenRoots?: Record<string, SeenRoot>;
};
export type SeenValue = string | null | string[];
export type SeenIssue = {
  seenAt: number;
  fields: Record<string, SeenValue>;
  commentCount?: number;
};
export type SeenRoot = { touchedAt: number; issues: Record<string, SeenIssue> };
export type TokenConnectionInput = {
  siteUrl: string;
  email: string;
  token: string;
  scoped: boolean;
};
export type GithubConnectionInput = { token: string; repositories: string[] };
export interface CanopyAPI {
  demoMode(): Promise<boolean>;
  launchDemo(): Promise<void>;
  closeDemo(): Promise<void>;
  resetDemo(): Promise<void>;
  connections(): Promise<Connection[]>;
  currentUser(connectionId: string): Promise<Choice>;
  connect(input?: TokenConnectionInput): Promise<Connection[]>;
  connectGithub(input: GithubConnectionInput): Promise<Connection[]>;
  disconnect(connectionId: string): Promise<void>;
  syncStatus(connectionId: string): Promise<{ retryAt: number | null }>;
  tree(connectionId: string, rootKey: string): Promise<TreeSnapshot>;
  preview(connectionId: string, key: string): Promise<IssuePreview>;
  issueUrl(connectionId: string, key: string): Promise<string>;
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
  labels(connectionId: string, key: string): Promise<Choice[]>;
  transitions(
    connectionId: string,
    key: string,
    refresh?: boolean,
  ): Promise<EditOptions['transitions']>;
  workflowGraph(
    connectionId: string,
    projectId: string,
    issueTypeId: string,
  ): Promise<StatusTransitionTree | null>;
  invalidateChoices(connectionId: string, key: string): Promise<void>;
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
  openLink(url: string): Promise<void>;
  openComment(
    connectionId: string,
    key: string,
    commentId: string,
  ): Promise<void>;
}
declare global {
  interface Window {
    canopy: CanopyAPI;
  }
}
