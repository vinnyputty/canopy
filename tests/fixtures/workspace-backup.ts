import { DEFAULT_VIEW } from '../../src/renderer/table-view';
import type { Connection, Workspace } from '../../src/shared/types';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/tree';
export const backupConnections: Connection[] = [
  {
    id: 'sample-jira',
    name: 'Sample Jira',
    provider: 'jira',
    url: 'https://sample.invalid',
  },
  {
    id: 'sample-github',
    name: 'Sample GitHub',
    provider: 'github',
    url: 'https://github.com',
  },
];
export const backupWorkspace: Workspace = {
  tabs: [
    {
      id: 'tab-1',
      connectionId: 'sample-jira',
      rootKey: 'SAMPLE-1',
      summary: 'Sample root',
      expanded: ['SAMPLE-1'],
      hideDone: true,
      scrollTop: 100,
    },
    {
      id: 'tab-2',
      connectionId: 'sample-github',
      rootKey: 'sample/repo#1',
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    },
  ],
  closedTabs: [
    {
      id: 'closed-1',
      connectionId: 'sample-jira',
      rootKey: 'SAMPLE-2',
      expanded: [],
      scrollTop: 0,
      hideDone: false,
    },
  ],
  rootViews: { '["sample-jira","SAMPLE-1"]': structuredClone(DEFAULT_VIEW) },
  viewDefaults: { 'sample-github': structuredClone(DEFAULT_VIEW) },
  activeTabId: 'tab-1',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  theme: 'dark',
  palette: 'forest',
  reading: { textSize: 'large', spacing: 'comfortable' },
  sidebarCollapsed: true,
  sidebarWidth: 240,
  previewWidth: 400,
  pinnedRoots: [
    {
      connectionId: 'sample-jira',
      rootKey: 'SAMPLE-1',
      summary: 'Sample favorite',
    },
  ],
  recentRoots: [{ connectionId: 'sample-github', rootKey: 'sample/repo#1' }],
  savedViews: [
    {
      id: 'saved-1',
      name: 'Sample view',
      roots: [{ connectionId: 'sample-jira', rootKey: 'SAMPLE-1' }],
      connectionIds: ['sample-jira'],
      filters: {
        assignee: 'me',
        statuses: ['Open'],
        priority: '',
        hideDone: true,
      },
      sort: { column: 'key', direction: 'asc' },
    },
  ],
  activeSavedViewId: 'saved-1',
  seenRoots: {
    'sample-jira:SAMPLE-1': {
      touchedAt: 1,
      issues: {
        'SAMPLE-1': {
          seenAt: 1,
          fields: { summary: 'PRIVATE SNAPSHOT FIXTURE' },
        },
      },
    },
  },
};
