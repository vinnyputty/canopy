import type { Issue } from '../shared/types';

export function issueKeyAndSummary(
  issue: Pick<Issue, 'key' | 'summary'>,
): string {
  return `${issue.key} ${issue.summary.trim().replace(/\s*[\r\n]+\s*/g, ' ')}`;
}
