import type {
  Choice,
  EditOptions,
  Issue,
  IssuePatch,
  TreeSnapshot,
} from '../shared/types';

export type JiraRequest = (path: string, init?: RequestInit) => Promise<any>;

const ISSUE_FIELDS = [
  'summary',
  'issuetype',
  'parent',
  'priority',
  'assignee',
  'status',
  'issuelinks',
];
const SEARCH_PAGE_SIZE = 100;
const PARENT_BATCH_SIZE = 50;
const ASSIGNEE_PAGE_SIZE = 1000;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

type JiraFields = Record<string, any>;
type JiraIssue = { id?: string; key?: string; fields?: JiraFields };

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quoteTextJql(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\\\\\')
    .replace(/"/g, '\\"')
    .replace(/[+\-&|!(){}[\]^~*?:/]/g, '\\\\$&');
  return `"${escaped}"`;
}

function rankFieldUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /field ['"]?rank['"]? does not exist/i.test(message) ||
    /unknown field ['"]?rank['"]?/i.test(message)
  );
}

function issuePath(key: string, suffix = ''): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}${suffix}`;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function choice(value: any): Choice | null {
  if (!value || value.id == null || value.name == null) return null;
  return { id: String(value.id), name: String(value.name) };
}

function parseIssue(raw: JiraIssue): Issue {
  if (!raw?.key || !raw.fields)
    throw new Error('Jira returned an issue without a key or fields.');

  const fields = raw.fields;
  const statusCategory = fields.status?.statusCategory?.key;
  const category =
    statusCategory === 'new' || statusCategory === 'done'
      ? statusCategory
      : 'indeterminate';
  const links: Issue['links'] = [];

  for (const link of fields.issuelinks ?? []) {
    const linked = link.outwardIssue ?? link.inwardIssue;
    if (!linked?.key) continue;
    links.push({
      key: String(linked.key),
      summary: String(linked.fields?.summary ?? linked.key),
      relationship: String(
        link.outwardIssue
          ? (link.type?.outward ?? 'links to')
          : (link.type?.inward ?? 'is linked from'),
      ),
    });
  }

  return {
    id: String(raw.id ?? raw.key),
    key: String(raw.key),
    summary: String(fields.summary ?? ''),
    type: String(fields.issuetype?.name ?? 'Issue'),
    ...(fields.parent?.key ? { parentKey: String(fields.parent.key) } : {}),
    priority: choice(fields.priority),
    assignee: fields.assignee?.accountId
      ? {
          id: String(fields.assignee.accountId),
          name: String(
            fields.assignee.displayName ?? fields.assignee.accountId,
          ),
        }
      : null,
    status: {
      id: String(fields.status?.id ?? ''),
      name: String(fields.status?.name ?? 'Unknown'),
      category,
    },
    links,
  };
}

function uniqueChoices(values: Choice[]): Choice[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

/** Jira Cloud REST operations scoped to one authenticated Atlassian cloud site. */
export class JiraProvider {
  constructor(private readonly request: JiraRequest) {}

  async tree(rootKey: string): Promise<TreeSnapshot> {
    const normalizedRoot = rootKey.trim();
    if (!normalizedRoot) throw new Error('An issue key is required.');

    let root: Issue;
    try {
      root = await this.getIssue(normalizedRoot);
    } catch (error) {
      throw this.contextError(
        `Unable to open Jira issue ${normalizedRoot}. It may not exist or you may not have access`,
        error,
      );
    }

    const issues = [root];
    const visited = new Set([root.key]);
    const warnings: string[] = [];
    let frontier = [root.key];
    let rankOrderingAvailable = true;

    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (
        let offset = 0;
        offset < frontier.length;
        offset += PARENT_BATCH_SIZE
      ) {
        const parents = frontier.slice(offset, offset + PARENT_BATCH_SIZE);
        const parentClause = `parent in (${parents.map(quoteJql).join(', ')})`;
        let children: JiraIssue[];
        if (rankOrderingAvailable) {
          try {
            children = await this.searchAll(
              `${parentClause} ORDER BY Rank ASC`,
            );
          } catch (error) {
            if (!rankFieldUnavailable(error)) throw error;
            rankOrderingAvailable = false;
            warnings.push(
              'Rank ordering is unavailable for this Jira site; children are ordered by issue key.',
            );
            children = await this.searchAll(`${parentClause} ORDER BY key ASC`);
          }
        } else {
          children = await this.searchAll(`${parentClause} ORDER BY key ASC`);
        }

        for (const raw of children) {
          const child = parseIssue(raw);
          if (visited.has(child.key)) {
            warnings.push(`Ignored duplicate or cyclic child ${child.key}.`);
            continue;
          }
          visited.add(child.key);
          issues.push(child);
          nextFrontier.push(child.key);
        }
      }
      frontier = nextFrontier;
    }

    const ranking = rankOrderingAvailable
      ? await this.rankingPermissions(
          issues.filter((issue) => issue.key !== root.key),
        )
      : {
          state: 'unsupported' as const,
          reason: 'Jira Rank is unavailable for this tree.',
          issueKeys: [],
        };
    return {
      rootKey: root.key,
      issues,
      fetchedAt: Date.now(),
      warnings,
      ranking,
    };
  }

  private async rankingPermissions(
    issues: Issue[],
  ): Promise<NonNullable<TreeSnapshot['ranking']>> {
    if (!issues.length)
      return {
        state: 'unsupported',
        reason: 'This tree has no issues to rank.',
        issueKeys: [],
      };
    const allowed = new Set<string>();
    try {
      for (let offset = 0; offset < issues.length; offset += 1000) {
        const batch = issues.slice(offset, offset + 1000);
        const ids = batch.map((issue) => Number(issue.id));
        if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
          throw new Error('Jira returned invalid issue IDs.');
        const result = await this.call(
          '/rest/api/3/permissions/check',
          jsonInit('POST', {
            projectPermissions: [
              {
                issues: ids,
                permissions: ['SCHEDULE_ISSUES', 'EDIT_ISSUES'],
              },
            ],
          }),
          'check ranking permissions',
        );
        if (!Array.isArray(result?.projectPermissions))
          throw new Error('Jira returned invalid ranking permissions.');
        const grants = ['SCHEDULE_ISSUES', 'EDIT_ISSUES'].map(
          (permission) =>
            new Set(
              result.projectPermissions
                .filter((entry: any) => entry.permission === permission)
                .flatMap((entry: any) => entry.issues ?? [])
                .map(String),
            ),
        );
        for (const issue of batch)
          if (grants.every((grant) => grant.has(issue.id)))
            allowed.add(issue.key);
      }
      return allowed.size
        ? { state: 'supported', issueKeys: [...allowed] }
        : {
            state: 'unsupported',
            reason:
              'Ranking requires Schedule issues and Edit issues permissions.',
            issueKeys: [],
          };
    } catch {
      return {
        state: 'unknown',
        reason:
          'Ranking permissions could not be verified. Refresh to try again.',
        issueKeys: [],
      };
    }
  }

  async priorityOrder(keys: string[]): Promise<string[]> {
    if (!keys.length) return [];
    const representatives = [...new Set(keys)];
    const issues = await this.searchAll(
      `key in (${representatives.map(quoteJql).join(', ')}) ORDER BY priority DESC`,
    );
    if (
      representatives.some((key) => !issues.some((issue) => issue.key === key))
    )
      throw new Error(
        'Some priorities could not be read. Refresh the tree and try again.',
      );
    return [
      ...new Set(
        issues.flatMap((issue) =>
          issue.fields?.priority?.id == null
            ? []
            : [String(issue.fields.priority.id)],
        ),
      ),
    ];
  }

  async search(query: string): Promise<Issue[]> {
    const value = query.trim();
    if (!value) return [];

    const summaryClause = `summary ~ ${quoteTextJql(value)}`;
    const jql = ISSUE_KEY.test(value)
      ? `(key = ${quoteJql(value)} OR ${summaryClause}) ORDER BY updated DESC`
      : `${summaryClause} ORDER BY updated DESC`;
    return (await this.searchAll(jql)).map(parseIssue);
  }

  async editOptions(key: string, query = ''): Promise<EditOptions> {
    const encodedQuery = encodeURIComponent(query.trim());
    const [metadata, assignees, transitions] = await Promise.all([
      this.call(
        issuePath(key, '/editmeta'),
        undefined,
        `load edit metadata for ${key}`,
      ).catch(() => null),
      this.assignableUsers(key, encodedQuery),
      this.call(
        `${issuePath(key, '/transitions')}?expand=transitions.fields`,
        undefined,
        `load workflow transitions for ${key}`,
      ),
    ]);

    const priorities = uniqueChoices(
      (metadata?.fields?.priority?.allowedValues ?? [])
        .map(choice)
        .filter((value: Choice | null): value is Choice => value !== null),
    );

    return {
      priorities,
      assignees: uniqueChoices(
        assignees
          .filter((user: any) => user?.accountId)
          .map((user: any) => ({
            id: String(user.accountId),
            name: String(user.displayName ?? user.accountId),
          })),
      ),
      transitions: (transitions?.transitions ?? []).map((transition: any) => ({
        id: String(transition.id),
        name: String(transition.name),
        requiresFields: Object.values(transition.fields ?? {}).some(
          (field: any) => field?.required === true,
        ),
      })),
    };
  }

  async update(key: string, patch: IssuePatch): Promise<Issue> {
    const fields: Record<string, unknown> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary;
    if (patch.priorityId !== undefined)
      fields.priority = { id: patch.priorityId };
    if (patch.assigneeId !== undefined)
      fields.assignee =
        patch.assigneeId === null ? null : { accountId: patch.assigneeId };

    if (patch.transitionId !== undefined)
      await this.assertTransitionNeedsNoFields(key, patch.transitionId);

    if (Object.keys(fields).length > 0) {
      await this.call(
        `${issuePath(key)}?returnIssue=true`,
        jsonInit('PUT', { fields }),
        `update Jira issue ${key}`,
      );
    }

    if (patch.transitionId !== undefined) {
      await this.call(
        issuePath(key, '/transitions'),
        jsonInit('POST', { transition: { id: patch.transitionId } }),
        `transition Jira issue ${key}`,
      );
    }

    return this.getIssue(key);
  }

  async rank(key: string, beforeKey: string): Promise<void> {
    if (key === beforeKey) return;
    const [issue, before] = await Promise.all([
      this.getIssue(key),
      this.getIssue(beforeKey),
    ]);
    if (!issue.parentKey)
      throw new Error(`Root issue ${key} cannot be reordered.`);
    if (!before.parentKey || issue.parentKey !== before.parentKey) {
      throw new Error(
        `${key} and ${beforeKey} must have the same parent to be reordered.`,
      );
    }

    const result = await this.call(
      '/rest/agile/1.0/issue/rank',
      jsonInit('PUT', { issues: [key], rankBeforeIssue: beforeKey }),
      `rank Jira issue ${key}`,
    );
    const failed = Array.isArray(result?.entries)
      ? result.entries.filter(
          (entry: any) =>
            Number(entry?.status) < 200 || Number(entry?.status) >= 300,
        )
      : [];
    if (failed.length > 0) {
      const details = failed
        .flatMap((entry: any) =>
          Array.isArray(entry.errors) ? entry.errors.map(String) : [],
        )
        .join(' ');
      throw new Error(
        `Jira could not rank ${failed.map((entry: any) => entry.issueKey ?? key).join(', ')}.${details ? ` ${details}` : ''}`,
      );
    }
  }

  private async getIssue(key: string): Promise<Issue> {
    const fields = encodeURIComponent(ISSUE_FIELDS.join(','));
    const raw = await this.call(
      `${issuePath(key)}?fields=${fields}`,
      undefined,
      `load Jira issue ${key}`,
    );
    return parseIssue(raw);
  }

  private async searchAll(jql: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;

    do {
      const page = await this.call(
        '/rest/api/3/search/jql',
        jsonInit('POST', {
          jql,
          fields: ISSUE_FIELDS,
          maxResults: SEARCH_PAGE_SIZE,
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
        'search Jira issues',
      );
      if (!Array.isArray(page?.issues))
        throw new Error('Jira search returned an invalid response.');
      issues.push(...page.issues);

      const token =
        typeof page.nextPageToken === 'string' && page.nextPageToken
          ? page.nextPageToken
          : undefined;
      if (token && seenTokens.has(token))
        throw new Error(
          'Jira search repeated a page token; refusing to return a truncated result.',
        );
      if (page.isLast === false && !token) {
        throw new Error(
          'Jira search indicated more results but supplied no page token.',
        );
      }
      if (token) seenTokens.add(token);
      nextPageToken = token;
    } while (nextPageToken);

    return issues;
  }

  private async assignableUsers(
    key: string,
    encodedQuery: string,
  ): Promise<any[]> {
    const users: any[] = [];
    let startAt = 0;
    while (true) {
      const page = await this.call(
        `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(key)}&query=${encodedQuery}&startAt=${startAt}&maxResults=${ASSIGNEE_PAGE_SIZE}`,
        undefined,
        `load assignable users for ${key}`,
      );
      if (!Array.isArray(page))
        throw new Error(
          'Jira assignable-user search returned an invalid response.',
        );
      users.push(...page);
      if (page.length < ASSIGNEE_PAGE_SIZE) break;
      startAt += page.length;
    }
    return users;
  }

  private async assertTransitionNeedsNoFields(
    key: string,
    transitionId: string,
  ): Promise<void> {
    const response = await this.call(
      `${issuePath(key, '/transitions')}?expand=transitions.fields`,
      undefined,
      `load workflow transitions for ${key}`,
    );
    const transition = (response?.transitions ?? []).find(
      (candidate: any) => String(candidate.id) === transitionId,
    );
    if (!transition)
      throw new Error(
        `Transition ${transitionId} is not available for ${key}.`,
      );
    const required = Object.entries(transition.fields ?? {})
      .filter(([, field]: [string, any]) => field?.required === true)
      .map(([fieldId, field]: [string, any]) => String(field?.name ?? fieldId));
    if (required.length > 0) {
      throw new Error(
        `Transition ${transition.name ?? transitionId} requires fields Canopy cannot edit: ${required.join(', ')}.`,
      );
    }
  }

  private async call(
    path: string,
    init: RequestInit | undefined,
    action: string,
  ): Promise<any> {
    try {
      return await this.request(path, init);
    } catch (error) {
      throw this.contextError(`Unable to ${action}`, error);
    }
  }

  private contextError(message: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(detail ? `${message}: ${detail}` : message);
  }
}
