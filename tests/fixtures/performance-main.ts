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
    expanded: Array.from({ length: shapes[i][1] }, (_, index) =>
      kind === 'jira'
        ? `PERF${i}-${index + 1}`
        : `${fixture.repository}#${index + 1}`,
    ),
    hideDone: true,
    scrollTop: 0,
  }));
  const workspace: Workspace = {
    tabs: [
      tabs[
        shapes.findIndex(
          ([shape]) => shape === (process.env.CANOPY_PERF_SHAPE ?? 'wide'),
        )
      ],
    ],
    activeTabId:
      tabs[
        shapes.findIndex(
          ([shape]) => shape === (process.env.CANOPY_PERF_SHAPE ?? 'wide'),
        )
      ].id,
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
  const calls: { root: string; at: number; call: number }[] = [];
  const loads: {
    root: string;
    event: string;
    at: number;
    count?: number;
    incomplete?: boolean;
  }[] = [];
  for (const fixture of fixtures)
    fixture.onCall(() => {
      calls.push({
        root: fixture.rootKey,
        at: performance.now(),
        call: fixture.calls(),
      });
    });
  Object.assign(globalThis, {
    canopyPerf: {
      calls: () => fixtures.map((fixture) => fixture.calls()),
      events: () => ({ calls, loads, timeOrigin: performance.timeOrigin }),
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
      tree: async (key, options) => {
        loads.push({ root: key, event: 'start', at: performance.now() });
        try {
          const snapshot = await fixtureFor(key).provider.tree(key, {
            ...options,
            progress: (snapshot) => {
              loads.push({
                root: key,
                event: 'progress',
                at: performance.now(),
                count: snapshot.issues.length,
                incomplete: Boolean(snapshot.incomplete),
              });
              options?.progress?.(snapshot);
            },
          });
          loads.push({
            root: key,
            event: 'complete',
            at: performance.now(),
            count: snapshot.issues.length,
            incomplete: Boolean(snapshot.incomplete),
          });
          return snapshot;
        } catch (error) {
          loads.push({ root: key, event: 'error', at: performance.now() });
          throw error;
        }
      },
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
