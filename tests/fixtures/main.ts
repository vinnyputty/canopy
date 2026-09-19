import { launch } from '../../src/main/app';
import type { Issue } from '../../src/shared/types';
import { ControlledDemoProvider } from './controlled';

launch(async (storage) => {
  if (await storage.read<boolean>('demo-removed')) return undefined;
  const demo = new ControlledDemoProvider(
    (await storage.read<Issue[]>('demo')) ?? undefined,
    (issues) => storage.write('demo', issues),
    process.env.CANOPY_SMOKE_PREVIEW_FAILURE === '1',
  );
  Object.assign(globalThis, { canopySmoke: demo });
  let rankAttempts = 0;
  let priorityFailures = Number(
    process.env.CANOPY_SMOKE_PRIORITY_FAILURES ?? 0,
  );
  await storage.write('rank-attempts', rankAttempts);
  if (process.env.CANOPY_SMOKE_PREVIEW_FAILURE === '1') {
    const controls = {
      requests: [] as string[],
      completed: [] as string[],
      hold: [] as string[],
      fail: [] as string[],
      empty: [] as string[],
      release: {} as Record<string, () => void>,
    };
    Object.assign(globalThis, { canopyPreviewTest: controls });
    const preview = demo.preview.bind(demo);
    demo.preview = async (key) => {
      controls.requests.push(key);
      if (controls.hold.includes(key))
        await new Promise<void>((resolve) => {
          controls.release[key] = resolve;
        });
      try {
        if (controls.fail.includes(key))
          throw new Error('Preview temporarily unavailable.');
        const result = await preview(key);
        if (key === 'CAN-108')
          result.issue.links.push(
            {
              key: 'CAN-101',
              summary: 'Build the workspace foundation',
              relationship: 'blocks',
            },
            {
              key: 'CAN-102',
              summary: 'Design the navigation shell',
              relationship: 'is blocked by',
            },
          );
        if (controls.empty.includes(key))
          return { ...result, description: '', comments: [], totalComments: 0 };
        return result;
      } finally {
        controls.completed.push(key);
      }
    };
  }
  return {
    syncStatus: () => ({ retryAt: demo.retryAt }),
    disconnect: () => storage.write('demo-removed', true),
    openIssue: () => {
      throw new Error('Demo issues exist only in Canopy.');
    },
    connection: {
      id: 'demo',
      name: 'Canopy demo',
      url: 'https://example.invalid',
      provider: 'demo',
    },
    provider: {
      tree: async (key) => {
        const snapshot = await demo.tree(key);
        const state = process.env.CANOPY_SMOKE_RANKING;
        if (state === 'unsupported' || state === 'unknown')
          snapshot.ranking = {
            state,
            issueKeys: [],
            reason:
              state === 'unsupported'
                ? 'Jira Rank is unavailable for this tree.'
                : 'Ranking permissions could not be verified. Refresh to try again.',
          };
        return snapshot;
      },
      preview: (key) => demo.preview(key),
      search: (query, token, signal) => demo.search(query, token, signal),
      priorities: (key, refresh) => demo.priorities(key, refresh),
      transitions: (key, refresh) => demo.transitions(key, refresh),
      invalidateChoices: () => {},
      cachedUsers: () => demo.cachedUsers(),
      assignees: (key, query, startAt, refresh) =>
        demo.assignees(key, query, startAt, refresh),
      validateAssignee: (key, accountId, refresh) =>
        demo.validateAssignee(key, accountId, refresh),
      update: (key, patch) => demo.update(key, patch),
      rank: async (key, before, position) => {
        await storage.write('rank-attempts', ++rankAttempts);
        return demo.rank(key, before, position);
      },
      priorityOrder: (keys) => {
        if (priorityFailures-- > 0)
          return Promise.reject(new Error('Priority lookup unavailable.'));
        return demo.priorityOrder(keys);
      },
    },
  };
});
