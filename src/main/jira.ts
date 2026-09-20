import type {
  AssigneePage,
  Choice,
  EditOptions,
  Issue,
  IssuePatch,
  IssuePreview,
  TreeSnapshot,
  SearchPage,
} from '../shared/types';

import { documentText } from './adf';

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
const ASSIGNEE_PAGE_SIZE = 100;
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
  private identities = new Map<string, Choice>();
  private statuses = new Map<string, string>();
  private pickerCache = new Map<
    string,
    { promise: Promise<any>; pending: boolean }
  >();

  private cached<T>(
    key: string,
    refresh: boolean,
    load: () => Promise<T>,
    retain = true,
  ): Promise<T> {
    const existing = this.pickerCache.get(key);
    if (existing && (!refresh || existing.pending)) return existing.promise;
    const entry = {
      promise: undefined as unknown as Promise<T>,
      pending: true,
    };
    entry.promise = load().then(
      (value) => {
        entry.pending = false;
        if (!retain && this.pickerCache.get(key) === entry)
          this.pickerCache.delete(key);
        return value;
      },
      (error) => {
        if (this.pickerCache.get(key) === entry) this.pickerCache.delete(key);
        throw error;
      },
    );
    this.pickerCache.set(key, entry);
    return entry.promise;
  }
  private invalidate(key: string, field?: 'priority' | 'assignee' | 'status') {
    for (const entry of this.pickerCache.keys()) {
      const [issue, kind] = JSON.parse(entry);
      if (issue === key.toUpperCase() && (!field || field === kind))
        this.pickerCache.delete(entry);
    }
  }
  private cacheKey(key: string, field: string, ...context: unknown[]) {
    return JSON.stringify([key.toUpperCase(), field, ...context]);
  }
  private remember(user: Choice) {
    this.identities.delete(user.id);
    this.identities.set(user.id, user);
    if (this.identities.size > 100)
      this.identities.delete(this.identities.keys().next().value!);
  }
  private observeIssue(raw: JiraIssue): Issue {
    const issue = parseIssue(raw);
    const key = issue.key.toUpperCase();
    if (this.statuses.has(key) && this.statuses.get(key) !== issue.status.id)
      this.invalidate(key);
    this.statuses.set(key, issue.status.id);
    if (issue.assignee) this.remember(issue.assignee);
    return issue;
  }
  async cachedUsers(): Promise<Choice[]> {
    return [...this.identities.values()].reverse();
  }

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
          const child = this.observeIssue(raw);
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

  async preview(key: string): Promise<IssuePreview> {
    const [raw, comments] = await Promise.all([
      this.call(
        `${issuePath(key)}?fields=${encodeURIComponent([...ISSUE_FIELDS, 'description'].join(','))}`,
        undefined,
        `load preview for ${key}`,
      ),
      this.call(
        `${issuePath(key, '/comment')}?maxResults=10&orderBy=-created`,
        undefined,
        `load comments for ${key}`,
      )
        .then((page) => {
          if (!Array.isArray(page?.comments))
            throw new Error('Jira returned invalid comments.');
          return { page, error: undefined };
        })
        .catch((error: unknown) => ({
          page: undefined,
          error: error instanceof Error ? error.message : String(error),
        })),
    ]);
    return {
      issue: parseIssue(raw),
      description: documentText(raw.fields?.description),
      comments: (comments.page?.comments ?? [])
        .slice(0, 10)
        .map((comment: any) => ({
          id: String(comment.id),
          author: String(comment.author?.displayName ?? 'Unknown author'),
          created: String(comment.created ?? ''),
          body: documentText(comment.body),
        })),
      totalComments: Number(comments.page?.total ?? 0),
      ...(comments.error ? { commentsError: comments.error } : {}),
    };
  }

  async search(
    query: string,
    nextPageToken?: string,
    signal?: AbortSignal,
  ): Promise<SearchPage> {
    const value = query.trim();
    if (!value) return { issues: [] };
    signal?.throwIfAborted();
    const literal = `summary ~ ${quoteTextJql(value)}`;
    // Only Canopy's generated suffix is syntax; user punctuation stays escaped.
    const summaryClause = /[\p{L}\p{N}]$/u.test(value)
      ? `(${literal} OR summary ~ ${quoteTextJql(value).slice(0, -1)}*")`
      : literal;
    const jql = ISSUE_KEY.test(value)
      ? `(key = ${quoteJql(value)} OR ${summaryClause}) ORDER BY updated DESC, key ASC`
      : `${summaryClause} ORDER BY updated DESC, key ASC`;
    const page = await this.call(
      '/rest/api/3/search/jql',
      {
        ...jsonInit('POST', {
          jql,
          fields: [...ISSUE_FIELDS, 'updated'],
          maxResults: 25,
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
        signal,
      },
      'search Jira issues',
    );
    if (!Array.isArray(page?.issues))
      throw new Error('Jira search returned an invalid response.');
    const token =
      typeof page.nextPageToken === 'string' && page.nextPageToken
        ? page.nextPageToken
        : undefined;
    if (token && token === nextPageToken)
      throw new Error(
        'Jira search repeated a page token. Try the search again.',
      );
    if (page.isLast === false && !token)
      throw new Error(
        'Jira search indicated more results but supplied no page token.',
      );
    return {
      issues: page.issues.map((raw: JiraIssue) => ({
        ...this.observeIssue(raw),
        ...(typeof raw.fields?.updated === 'string'
          ? { updated: raw.fields.updated }
          : {}),
      })),
      ...(token ? { nextPageToken: token } : {}),
    };
  }

  priorities(key: string, refresh = false): Promise<Choice[]> {
    return this.cached(this.cacheKey(key, 'priority'), refresh, async () => {
      const metadata = await this.call(
        issuePath(key, '/editmeta'),
        undefined,
        `load priority choices for ${key}`,
      );
      if (!metadata?.fields || typeof metadata.fields !== 'object')
        throw new Error('Jira returned invalid edit metadata.');
      const priority = metadata.fields.priority;
      if (!priority)
        throw new Error('Priority cannot be edited for this issue.');
      if (!Array.isArray(priority.allowedValues))
        throw new Error(
          'Jira did not provide priority choices for this issue.',
        );
      return uniqueChoices(
        priority.allowedValues
          .map(choice)
          .filter((value: Choice | null): value is Choice => value !== null),
      );
    });
  }

  transitions(
    key: string,
    refresh = false,
  ): Promise<EditOptions['transitions']> {
    return this.cached(
      this.cacheKey(key, 'status', this.statuses.get(key.toUpperCase())),
      refresh,
      async () => {
        const response = await this.call(
          `${issuePath(key, '/transitions')}?expand=transitions.fields`,
          undefined,
          `load workflow transitions for ${key}`,
        );
        if (!Array.isArray(response?.transitions))
          throw new Error('Jira returned invalid workflow transitions.');
        return response.transitions.map((transition: any) => ({
          id: String(transition.id),
          name: String(transition.name),
          ...(transition.to?.id && transition.to?.name
            ? {
                to: {
                  id: String(transition.to.id),
                  name: String(transition.to.name),
                  category:
                    transition.to.statusCategory?.key === 'new' ||
                    transition.to.statusCategory?.key === 'done'
                      ? transition.to.statusCategory.key
                      : 'indeterminate',
                },
              }
            : {}),
          requiresFields: Object.values(transition.fields ?? {}).some(
            (field: any) => field?.required === true,
          ),
        }));
      },
    );
  }

  assignees(
    key: string,
    query = '',
    startAt = 0,
    refresh = false,
  ): Promise<AssigneePage> {
    if (
      !Number.isInteger(startAt) ||
      startAt < 0 ||
      startAt >= 1000 ||
      startAt % ASSIGNEE_PAGE_SIZE !== 0
    )
      throw new Error('Invalid assignee search position.');
    const normalized = query.trim();
    return this.cached(
      this.cacheKey(key, 'assignee', 'search', normalized, startAt),
      refresh,
      async () => {
        const page = await this.call(
          `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(key)}&query=${encodeURIComponent(normalized)}&startAt=${startAt}&maxResults=${ASSIGNEE_PAGE_SIZE}`,
          undefined,
          `load assignable users for ${key}`,
        );
        const users = this.parseUsers(page);
        // Jira filters after selecting the candidate window; a short page is not exhaustion.
        return {
          users,
          ...(startAt + ASSIGNEE_PAGE_SIZE < 1000
            ? { nextStartAt: startAt + ASSIGNEE_PAGE_SIZE }
            : {}),
        };
      },
      false,
    );
  }

  async validateAssignee(
    key: string,
    accountId: string,
    refresh = false,
  ): Promise<Choice | null> {
    const eligible = await this.cached(
      this.cacheKey(key, 'assignee', 'identity', accountId),
      refresh,
      async () => {
        const page = await this.call(
          `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(key)}&accountId=${encodeURIComponent(accountId)}&startAt=0&maxResults=1000`,
          undefined,
          `check assignment eligibility for ${key}`,
        );
        return this.parseUsers(page).some((user) => user.id === accountId);
      },
    );
    if (!eligible) return null;
    return this.identities.get(accountId) ?? { id: accountId, name: accountId };
  }

  private parseUsers(page: unknown): Choice[] {
    if (!Array.isArray(page))
      throw new Error(
        'Jira assignable-user search returned an invalid response.',
      );
    const users = uniqueChoices(
      page
        .filter((user: any) => user?.accountId)
        .map((user: any) => ({
          id: String(user.accountId),
          name: String(user.displayName ?? user.accountId),
        })),
    );
    for (const user of users) this.remember(user);
    return users;
  }

  async update(key: string, patch: IssuePatch): Promise<Issue> {
    try {
      return await this.performUpdate(key, patch);
    } catch (error) {
      if (patch.priorityId !== undefined) this.invalidate(key, 'priority');
      if (patch.assigneeId !== undefined) this.invalidate(key, 'assignee');
      if (patch.transitionId !== undefined) this.invalidate(key, 'status');
      throw error;
    }
  }

  private async performUpdate(key: string, patch: IssuePatch): Promise<Issue> {
    const fields: Record<string, unknown> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary;
    if (patch.priorityId !== undefined)
      fields.priority = { id: patch.priorityId };
    if (patch.assigneeId !== undefined)
      fields.assignee =
        patch.assigneeId === null ? null : { accountId: patch.assigneeId };

    if (
      patch.assigneeId &&
      !(await this.validateAssignee(key, patch.assigneeId))
    )
      throw new Error(
        'Jira could not confirm this person is assignable to this issue.',
      );

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

    if (patch.transitionId !== undefined) this.invalidate(key);
    return this.getIssue(key);
  }

  async rank(
    key: string,
    beforeKey: string,
    position: 'before' | 'after' = 'before',
  ): Promise<void> {
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
      jsonInit('PUT', {
        issues: [key],
        [position === 'after' ? 'rankAfterIssue' : 'rankBeforeIssue']:
          beforeKey,
      }),
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
    return this.observeIssue(raw);
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
