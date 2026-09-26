import type { Workspace } from '../shared/types';
import { DemoProvider } from './demo-provider';

export const demoWorkspace: Workspace = {
  tabs: [
    {
      id: 'demo-can-100',
      connectionId: 'demo',
      rootKey: 'CAN-100',
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    },
  ],
  activeTabId: 'demo-can-100',
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
  sidebarWidth: 220,
  previewWidth: 420,
};

export async function createDemoFixture() {
  const provider = new DemoProvider();
  return {
    disconnect: async () => {
      throw new Error(
        'The demo connection stays available until this window closes.',
      );
    },
    openIssue: (): never => {
      throw new Error('Demo issues exist only in Canopy.');
    },
    connection: {
      id: 'demo',
      name: 'Canopy demo',
      url: 'Local sample workspace',
      provider: 'demo' as const,
    },
    provider: {
      tree: (key: string) => provider.tree(key),
      preview: (key: string) => provider.preview(key),
      development: (key: string) => provider.development(key),
      search: (query: string, token?: string, signal?: AbortSignal) =>
        provider.search(query, token, signal),
      priorities: (key: string, refresh?: boolean) =>
        provider.priorities(key, refresh),
      transitions: (key: string, refresh?: boolean) =>
        provider.transitions(key, refresh),
      invalidateChoices: () => {},
      cachedUsers: () => provider.cachedUsers(),
      assignees: (
        key: string,
        query?: string,
        start?: number,
        refresh?: boolean,
      ) => provider.assignees(key, query, start, refresh),
      validateAssignee: (key: string, id: string, refresh?: boolean) =>
        provider.validateAssignee(key, id, refresh),
      update: (key: string, patch: Parameters<DemoProvider['update']>[1]) =>
        provider.update(key, patch),
      rank: (key: string, anchor: string, position?: 'before' | 'after') =>
        provider.rank(key, anchor, position),
      priorityOrder: (keys: string[]) => provider.priorityOrder(keys),
    },
  };
}
