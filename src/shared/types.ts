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
export type TreeSnapshot = {
  rootKey: string;
  issues: Issue[];
  fetchedAt: number;
  warnings: string[];
};
export type IssuePatch = {
  summary?: string;
  priorityId?: string;
  assigneeId?: string | null;
  transitionId?: string;
};
export type EditOptions = {
  priorities: Choice[];
  assignees: Choice[];
  transitions: (Choice & { requiresFields: boolean })[];
};
export type TabState = {
  id: string;
  connectionId: string;
  rootKey: string;
  expanded: string[];
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
};
export type TokenConnectionInput = {
  siteUrl: string;
  email: string;
  token: string;
  scoped: boolean;
};
export interface CanopyAPI {
  connections(): Promise<Connection[]>;
  connect(input?: TokenConnectionInput): Promise<Connection[]>;
  disconnect(connectionId: string): Promise<void>;
  tree(connectionId: string, rootKey: string): Promise<TreeSnapshot>;
  search(connectionId: string, query: string): Promise<Issue[]>;
  editOptions(
    connectionId: string,
    key: string,
    query?: string,
  ): Promise<EditOptions>;
  update(connectionId: string, key: string, patch: IssuePatch): Promise<Issue>;
  rank(connectionId: string, key: string, beforeKey: string): Promise<void>;
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
