import { launch } from '../../src/main/app';
import type { Issue } from '../../src/shared/types';
import { DemoProvider } from './demo';

launch(async (storage) => {
  if (await storage.read<boolean>('demo-removed')) return undefined;
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
    provider: new DemoProvider(
      (await storage.read<Issue[]>('demo')) ?? undefined,
      (issues) => storage.write('demo', issues),
    ),
  };
});
