import type { Connection } from '../shared/types';

export function providerLabel(provider?: Connection['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'jira':
      return 'Jira';
    case 'demo':
      return 'Demo';
    default:
      return 'Unknown provider';
  }
}
