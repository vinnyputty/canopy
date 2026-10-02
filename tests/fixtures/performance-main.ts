import { launch } from '../../src/main/app';
import { defaultShortcuts } from '../../src/renderer/tree';
import type { Workspace } from '../../src/shared/types';
import { largeProvider, type Shape } from './large-trees';

// Built but never launched by portable checks. Use only a disposable profile.
const kind = process.env.CANOPY_PERF_PROVIDER === 'github' ? 'github' : 'jira';
const shapes: [Shape, number][] = [
  ['wide', 9901],
  ['tiered', 10101],
  ['deep', 2001],
];
const fixtures = shapes.map(([shape, size], index) =>
  largeProvider(kind, shape, size, index, 2),
);
const connectionId = `perf-${kind}`;
launch(async (storage) => {
  const tabs = fixtures.map((fixture, i) => ({
    id: `perf-${i}`,
    connectionId,
    rootKey: fixture.rootKey,
    summary: shapes[i][0],
    expanded: [fixture.rootKey],
    hideDone: true,
    scrollTop: 0,
  }));
  const workspace: Workspace = {
    tabs,
    activeTabId: tabs[0].id,
    theme: 'system',
    sidebarCollapsed: false,
    shortcuts: defaultShortcuts(
      process.platform === 'darwin' ? 'Mac' : 'Windows',
    ),
    savedViews: [
      {
        id: 'large-roots',
        name: 'Large roots',
        roots: tabs,
        connectionIds: [],
        filters: {
          assignee: 'any',
          statuses: [],
          priority: '',
          hideDone: true,
        },
        sort: { column: 'key', direction: 'asc' },
      },
    ],
  };
  if (!(await storage.read('workspace')))
    await storage.write('workspace', workspace);
  const fixtureFor = (key: string) =>
    fixtures.find((fixture) =>
      kind === 'jira'
        ? key.startsWith(fixture.rootKey.split('-')[0] + '-')
        : key.startsWith(fixture.repository + '#'),
    )!;
  Object.assign(globalThis, {
    canopyPerf: {
      calls: () => fixtures.map((fixture) => fixture.calls()),
      offline: (value: boolean) =>
        fixtures.forEach((fixture) =>
          fixture.fail(value ? fixture.calls() + 1 : Infinity),
        ),
    },
  });
  return {
    connection: {
      id: connectionId,
      provider: kind,
      name: `Large ${kind} samples`,
      url:
        kind === 'github'
          ? 'https://github.com'
          : 'https://sample.atlassian.net',
      repositories: fixtures.map((fixture) => fixture.repository),
    },
    disconnect: async () => {},
    openIssue: () => {
      throw new Error('Isolated sample issues have no external target.');
    },
    provider: {
      tree: (key, options) => fixtureFor(key).provider.tree(key, options),
      preview: (key) => fixtureFor(key).provider.preview(key),
      development: async () => ({
        state: 'unavailable',
        reason: 'Isolated fixture',
        branches: { state: 'unavailable', reason: 'Isolated fixture' },
        pullRequests: [],
        commits: [],
      }),
      search: async () => ({ issues: [] }),
      priorities: async () => [],
      transitions: async () => [],
      invalidateChoices: () => {},
      cachedUsers: async () => [],
      assignees: async () => ({ users: [] }),
      validateAssignee: async () => null,
      update: async () => {
        throw new Error('Read-only performance fixture');
      },
      rank: async () => {
        throw new Error('Read-only performance fixture');
      },
      priorityOrder: async () => [],
    },
  };
});
