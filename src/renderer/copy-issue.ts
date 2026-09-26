import type { Issue, IssuePreview } from '../shared/types';

export function issueKeyAndSummary(
  issue: Pick<Issue, 'key' | 'summary'>,
): string {
  return `${issue.key} ${issue.summary.trim().replace(/\s*[\r\n]+\s*/g, ' ')}`;
}

export function issueWorkBrief({
  preview,
  provider,
  sourceUrl,
  knownIssues,
  issueKey,
}: {
  preview?: IssuePreview;
  provider: 'jira' | 'github' | 'demo';
  sourceUrl?: string;
  knownIssues: Issue[];
  issueKey?: string;
}): string {
  const issue =
    preview?.issue ?? knownIssues.find((item) => item.key === issueKey);
  if (!issue) throw new Error('Issue details are unavailable.');
  const byKey = new Map(knownIssues.map((item) => [item.key, item]));
  const parents: string[] = [];
  const visited = new Set([issue.key]);
  let parentKey = issue.parentKey ?? byKey.get(issue.key)?.parentKey;
  while (parentKey && !visited.has(parentKey)) {
    visited.add(parentKey);
    parents.unshift(parentKey);
    const parent = byKey.get(parentKey);
    if (!parent) {
      parents.unshift('[earlier parents unavailable]');
      break;
    }
    parentKey = parent.parentKey;
  }
  const issueLink = (key: string) => {
    if (provider === 'demo') return '';
    if (provider === 'github' && /^[^/#]+\/[^/#]+#[1-9]\d*$/.test(key)) {
      const [repo, number] = key.split('#');
      return `https://github.com/${repo}/issues/${number}`;
    }
    if (
      provider !== 'github' &&
      sourceUrl &&
      /^[A-Z][A-Z0-9_]*-\d+$/i.test(key)
    ) {
      const url = new URL(sourceUrl);
      url.pathname = url.pathname.replace(/[^/]+$/, encodeURIComponent(key));
      return url.toString();
    }
    return '';
  };
  const availableLinks = (preview?.issue.links ?? []).map((link) => {
    const url = issueLink(link.key);
    return `- ${link.relationship}: ${url ? `[${link.key}](${url})` : link.key} — ${link.summary}`;
  });
  const links = [
    ...(availableLinks.length
      ? availableLinks
      : preview?.linksError || !preview
        ? []
        : ['None']),
    ...(preview?.linksError || !preview
      ? ['Unavailable: some dependency links could not be loaded.']
      : []),
  ].join('\n');
  const body = preview?.descriptionMarkdown ?? preview?.description;
  const description =
    body === undefined
      ? 'Unavailable: description could not be loaded.'
      : body.trim() || 'No description.';
  const identity =
    provider === 'github'
      ? `GitHub ${issue.key}`
      : provider === 'jira'
        ? `Jira ${issue.key}`
        : `Demo ${issue.key}`;
  return [
    `# ${issue.summary.trim()}`,
    '',
    `- Issue: ${identity}`,
    `- Source: ${sourceUrl || 'Unavailable: source URL could not be loaded.'}`,
    `- Status: ${issue.status?.name ?? 'Unavailable'}`,
    `- Priority: ${provider === 'github' ? 'Not available in GitHub issues' : (issue.priority?.name ?? 'None')}`,
    `- Parent path: ${parents.length ? parents.join(' → ') : 'None'}`,
    '',
    '## Description',
    '',
    description,
    '',
    '## Dependency links',
    '',
    links,
  ].join('\n');
}
