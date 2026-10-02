import { relationshipTitles } from '../shared/relationships';
import type { Issue, IssuePreview, IssueRelationships } from '../shared/types';

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
  relationships,
}: {
  preview?: IssuePreview;
  provider: 'jira' | 'github' | 'demo';
  sourceUrl?: string;
  knownIssues: Issue[];
  issueKey?: string;
  relationships?: IssueRelationships;
}): string {
  const issue =
    preview?.issue ?? knownIssues.find((item) => item.key === issueKey);
  if (!issue) throw new Error('Issue details are unavailable.');
  const graph = relationships?.key === issue.key ? relationships : undefined;
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
  const links = graph
    ? [
        'Only relationships visible to this connection are included; inaccessible issues may be omitted.',
        ...graph.groups.flatMap((group) => [
          '',
          `### ${relationshipTitles[group.kind]} (${group.state === 'visible' ? 'visible results' : group.state})`,
          '',
          ...group.items.map((link) => {
            const url = issueLink(link.key);
            const details = [
              link.direction === 'inward' ? 'Incoming' : 'Outgoing',
              link.statusCategory === 'done'
                ? 'Completed'
                : link.statusCategory
                  ? 'Active'
                  : 'Status unknown',
              ...(link.crossRepository ? ['Cross-repository'] : []),
              ...(link.access === 'outside-connection'
                ? ['Outside selected repositories']
                : link.access === 'unknown'
                  ? ['Target access unverified']
                  : []),
            ];
            return `- ${link.relationship}: ${url ? `[${link.key}](${url})` : link.key} — ${link.summary} (${details.join('; ')})`;
          }),
          ...(group.state === 'visible'
            ? group.items.length
              ? []
              : [
                  `No visible ${relationshipTitles[group.kind].toLowerCase()} returned.`,
                ]
            : [
                group.state === 'partial'
                  ? 'Partial: additional or uninterpreted relationships may exist.'
                  : 'Unavailable: this relationship group could not be loaded.',
              ]),
        ]),
      ].join('\n')
    : [
        ...availableLinks,
        ...(preview?.linksError || !preview
          ? ['Unavailable: some dependency links could not be loaded.']
          : preview.issue.linksAvailable !== true
            ? [
                'Uninspected: complete dependency relationships have not been loaded.',
              ]
            : availableLinks.length
              ? [
                  'Only visible issue links are included; hierarchy relationships have not been inspected.',
                ]
              : [
                  'No visible issue links returned; hierarchy relationships have not been inspected.',
                ]),
      ].join('\n');
  const parentGroup = graph?.groups.find((group) => group.kind === 'parent');
  const parentPath = parentGroup
    ? parentGroup.state !== 'visible'
      ? 'Unknown: parent relationships are incomplete or unavailable.'
      : parentGroup.items.length
        ? parentGroup.items.map((link) => link.key).join(' → ')
        : 'No visible parent returned.'
    : parents.length
      ? parents.join(' → ')
      : issue.unavailableFields?.includes('parent') || provider === 'github'
        ? 'Unknown: parent relationships have not been inspected.'
        : 'None';
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
    `- Parent path: ${parentPath}`,
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
