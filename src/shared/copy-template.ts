import type { Issue, Connection } from './types';

export const DEFAULT_COPY_TEMPLATE =
  '{{provider}} {{key}}: {{summary}}\n{{sourceUrl}}\nStatus: {{status}}';
export const COPY_PLACEHOLDERS = [
  'provider',
  'key',
  'summary',
  'sourceUrl',
  'status',
  'priority',
] as const;

export function validateCopyTemplate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4000 ||
    /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    return false;
  const remainder = value.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, name: string) =>
    COPY_PLACEHOLDERS.includes(name as (typeof COPY_PLACEHOLDERS)[number])
      ? ''
      : '{{invalid}}',
  );
  return !/[{}<>]/.test(remainder);
}

function safeText(value: string): string {
  if (value.length > 100_000) throw new Error('Copy field is too large.');
  return value
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Select only confirmed issue fields. No connection object, account, errors or workspace paths. */
export function renderCopyTemplate(
  template: string,
  issue: Issue,
  provider: Connection['provider'],
  sourceUrl?: string,
): string {
  if (!validateCopyTemplate(template))
    throw new Error('Invalid copy template.');
  let source = 'Unavailable';
  if (provider === 'demo') source = 'Local sample workspace';
  else if (sourceUrl) {
    const url = new URL(sourceUrl);
    const github = /^([-\w.]+)\/([-\w.]+)#([1-9]\d*)$/.exec(issue.key);
    const path =
      provider === 'github' && github
        ? `/${github[1]}/${github[2]}/issues/${github[3]}`
        : `/browse/${issue.key}`;
    if (
      provider === 'github'
        ? !github
        : !/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(issue.key)
    )
      throw new Error('Invalid issue identity.');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== path ||
      (provider === 'github' && url.hostname !== 'github.com')
    )
      throw new Error('Invalid source URL.');
    source = url.toString();
  }
  const fields = {
    provider,
    key: issue.key,
    summary: issue.summary,
    sourceUrl: source,
    status: issue.status.name,
    priority:
      provider === 'github'
        ? 'Not available in GitHub issues'
        : (issue.priority?.name ?? 'None'),
  };
  let expandedLength = template.length;
  const result = template.replace(
    /\{\{([a-zA-Z]+)\}\}/g,
    (match, name: string) => {
      const value = safeText(fields[name as keyof typeof fields]);
      expandedLength += value.length - match.length;
      if (expandedLength > 100_000) throw new Error('Copy text is too large.');
      return value;
    },
  );
  if (result.length > 100_000) throw new Error('Copy text is too large.');
  return result;
}
