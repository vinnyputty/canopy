import { launch } from '../../src/main/app';
import type { Issue } from '../../src/shared/types';
import { DemoProvider } from './demo';

launch(async (storage) => {
  if (await storage.read<boolean>('demo-removed')) return undefined;
  const demo = new DemoProvider(
    (await storage.read<Issue[]>('demo')) ?? undefined,
    (issues) => storage.write('demo', issues),
  );
  let rankAttempts = 0;
  let priorityFailures = Number(
    process.env.CANOPY_SMOKE_PRIORITY_FAILURES ?? 0,
  );
  await storage.write('rank-attempts', rankAttempts);
  return {
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
      search: (query) => demo.search(query),
      editOptions: (key, query) => demo.editOptions(key, query),
      update: (key, patch) => demo.update(key, patch),
      rank: async (key, before) => {
        await storage.write('rank-attempts', ++rankAttempts);
        return demo.rank(key, before);
      },
      priorityOrder: (keys) => {
        if (priorityFailures-- > 0)
          return Promise.reject(new Error('Priority lookup unavailable.'));
        return demo.priorityOrder(keys);
      },
    },
  };
});
