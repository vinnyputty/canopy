import type {
  AssigneePage,
  Choice,
  Connection,
  EditOptions,
  Issue,
  IssuePatch,
  IssuePreview,
  SearchPage,
  TreeSnapshot,
} from '../shared/types';

export type GithubRequest = (path: string, init?: RequestInit) => Promise<any>;
const reference = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)#([1-9]\d*)$/i;
const repository = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i;
export function githubRepository(value: string): string {
  const input = value.trim();
  let match = input.match(repository);
  if (!match) {
    try {
      const url = new URL(input);
      if (url.origin === 'https://github.com')
        match = url.pathname.match(/^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i);
    } catch {}
  }
  if (!match) throw new Error('Enter a selected GitHub repository.');
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}
export function githubRootKey(value: string): string {
  try {
    return githubRepository(value);
  } catch {
    return githubKey(value);
  }
}
export function githubRootUrl(value: string): string {
  const key = githubRootKey(value);
  return key.includes('#') ? githubIssueUrl(key) : `https://github.com/${key}`;
}
export function githubKey(value: string): string {
  const input = value.trim();
  let match = input.match(reference);
  if (!match) {
    try {
      const url = new URL(input);
      if (url.origin === 'https://github.com')
        match = url.pathname.match(
          /^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/i,
        );
    } catch {}
  }
  if (!match) throw new Error('Enter a GitHub issue URL or owner/repo#number.');
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
}
export function githubIssueUrl(key: string) {
  const match = githubKey(key).match(reference)!;
  return `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
}
function parts(key: string) {
  const match = githubKey(key).match(reference)!;
  return { repo: `${match[1]}/${match[2]}`, number: match[3] };
}
function rawKey(raw: any): string {
  return githubKey(
    raw.html_url ??
      `${String(raw.repository_url ?? '').replace('https://api.github.com/repos/', '')}#${raw.number}`,
  );
}
type ChildMetadata = { key: string; count: number; parentKey?: string };
function parseIssue(raw: any, parentKey?: string): Issue {
  const key = rawKey(raw);
  const assignee = raw.assignee ?? raw.assignees?.[0];
  return {
    id: String(raw.id),
    key,
    summary: String(raw.title ?? ''),
    type: 'Issue',
    parentKey,
    priority: null,
    assignee: assignee ? { id: assignee.login, name: assignee.login } : null,
    status: {
      id: raw.state === 'closed' ? 'closed' : 'open',
      name: raw.state === 'closed' ? 'Closed' : 'Open',
      category: raw.state === 'closed' ? 'done' : 'new',
    },
    labels: (raw.labels ?? [])
      .filter((label: any) => typeof label !== 'string')
      .map((label: any) => ({ id: label.name, name: label.name })),
    links: [],
  };
}
function pageToken(value?: string): { repo: number; page: number } {
  if (!value) return { repo: 0, page: 1 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      Number.isSafeInteger(parsed.repo) &&
      parsed.repo >= 0 &&
      Number.isSafeInteger(parsed.page) &&
      parsed.page > 0 &&
      parsed.page <= 10
    )
      return parsed;
  } catch {}
  throw new Error('Invalid GitHub search page. Start a new search.');
}
export class GithubProvider {
  private selected: Set<string>;
  constructor(
    private connection: Connection,
    private request: GithubRequest,
  ) {
    this.selected = new Set(connection.repositories ?? []);
  }
  private assertSelected(key: string) {
    const { repo } = parts(key);
    if (!this.selected.has(repo))
      throw new Error(
        `Repository ${repo} is outside this GitHub connection. Add it to the connection and token selection.`,
      );
    return parts(key);
  }
  private path(key: string, suffix = '') {
    const { repo, number } = this.assertSelected(key);
    return `/repos/${repo}/issues/${number}${suffix}`;
  }
  private async all(path: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request(
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch))
        throw new Error('GitHub returned an invalid page.');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub returned more than 10,000 issues for this view.');
  }
  private async childMetadata(
    candidates: { key: string; nodeId: string }[],
  ): Promise<ChildMetadata[]> {
    const metadata: ChildMetadata[] = [];
    for (let start = 0; start < candidates.length; start += 100) {
      const batch = candidates.slice(start, start + 100);
      const result = await this.request('/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query:
            'query($ids:[ID!]!){nodes(ids:$ids){... on Issue{parent{url} subIssuesSummary{total}}}}',
          variables: { ids: batch.map((item) => item.nodeId) },
        }),
      });
      if (result.errors?.length || !Array.isArray(result.data?.nodes))
        throw new Error('GitHub could not load sub-issue metadata.');
      if (result.data.nodes.length !== batch.length)
        throw new Error('GitHub returned incomplete sub-issue metadata.');
      for (let index = 0; index < batch.length; index++) {
        const node = result.data.nodes[index];
        const count = node?.subIssuesSummary?.total;
        if (!Number.isSafeInteger(count) || count < 0)
          throw new Error('GitHub returned invalid sub-issue counts.');
        metadata.push({
          key: batch[index].key,
          count,
          parentKey: node.parent?.url ? githubKey(node.parent.url) : undefined,
        });
      }
    }
    return metadata;
  }
  private async repositoryTree(repo: string): Promise<TreeSnapshot> {
    if (!this.selected.has(repo))
      throw new Error(
        `Repository ${repo} is outside this GitHub connection. Add it to the connection and token selection.`,
      );
    const listed = (await this.all(`/repos/${repo}/issues?state=all`)).filter(
      (raw) => !raw.pull_request,
    );
    const issues = new Map<string, Issue>();
    for (const raw of listed) {
      const issue = parseIssue(raw, repo);
      issues.set(issue.key, issue);
    }
    const metadata = await this.childMetadata(
      listed.map((raw) => ({ key: rawKey(raw), nodeId: raw.node_id })),
    );
    for (const item of metadata) {
      const issue = issues.get(item.key)!;
      if (item.parentKey && issues.has(item.parentKey))
        issue.parentKey = item.parentKey;
    }
    const warnings: string[] = [];
    let frontier = metadata
      .filter((item) => item.count > 0)
      .map((item) => item.key);
    while (frontier.length) {
      const candidates: { key: string; nodeId: string }[] = [];
      for (const parent of frontier) {
        const children = await this.all(this.path(parent, '/sub_issues'));
        for (const child of children) {
          const key = rawKey(child);
          if (!this.selected.has(parts(key).repo)) {
            warnings.push(
              `${key} is outside the selected repositories. Add that repository to read this subtree.`,
            );
            continue;
          }
          const existing = issues.get(key);
          if (existing) {
            existing.parentKey = parent;
            continue;
          }
          const issue = parseIssue(child, parent);
          issues.set(key, issue);
          candidates.push({ key, nodeId: child.node_id });
        }
      }
      frontier = (await this.childMetadata(candidates))
        .filter((item) => item.count > 0)
        .map((item) => item.key);
    }
    return {
      rootKey: repo,
      issues: [
        {
          id: `repository:${repo}`,
          key: repo,
          summary: 'Repository',
          type: 'Repository',
          priority: null,
          assignee: null,
          status: { id: 'repository', name: 'Repository', category: 'new' },
          links: [],
        },
        ...issues.values(),
      ],
      fetchedAt: Date.now(),
      warnings,
      ranking: {
        state: 'unsupported',
        reason: 'GitHub issues have no Jira rank.',
        issueKeys: [],
      },
    };
  }
  async tree(rootKey: string): Promise<TreeSnapshot> {
    if (!githubRootKey(rootKey).includes('#'))
      return this.repositoryTree(githubRepository(rootKey));
    const root = githubKey(rootKey);
    const raw = await this.request(this.path(root));
    if (raw.pull_request)
      throw new Error('This reference is a pull request. Open a GitHub issue.');
    const issues = [parseIssue(raw)];
    const seen = new Set([root]);
    const warnings: string[] = [];
    let frontier = [root];
    while (frontier.length) {
      const next: string[] = [];
      const candidates: { key: string; nodeId: string }[] = [];
      for (const parent of frontier) {
        const children = await this.all(this.path(parent, '/sub_issues'));
        for (const child of children) {
          const key = rawKey(child);
          if (seen.has(key)) {
            warnings.push(`Ignored duplicate or cyclic child ${key}.`);
            continue;
          }
          seen.add(key);
          if (!this.selected.has(parts(key).repo)) {
            warnings.push(
              `${key} is outside the selected repositories. Add that repository to read this subtree.`,
            );
            continue;
          }
          issues.push(parseIssue(child, parent));
          if (typeof child.node_id === 'string')
            candidates.push({ key, nodeId: child.node_id });
          else next.push(key);
        }
      }
      next.push(
        ...(await this.childMetadata(candidates))
          .filter((item) => item.count > 0)
          .map((item) => item.key),
      );
      frontier = next;
    }
    return {
      rootKey: root,
      issues,
      fetchedAt: Date.now(),
      warnings,
      ranking: {
        state: 'unsupported',
        reason: 'GitHub issues have no Jira rank.',
        issueKeys: [],
      },
    };
  }
  async preview(key: string): Promise<IssuePreview> {
    const raw = await this.request(this.path(key));
    const issue = parseIssue(raw);
    const [commentsResult, blockedByResult, blockingResult] = await Promise.all(
      [
        this.request(`${this.path(key, '/comments')}?per_page=20`).then(
          (value) => ({ value, error: '' }),
          (error: unknown) => ({ value: [], error: String(error) }),
        ),
        this.all(this.path(key, '/dependencies/blocked_by')).then(
          (value) => ({ value, error: '' }),
          (error: unknown) => ({ value: [], error: String(error) }),
        ),
        this.all(this.path(key, '/dependencies/blocking')).then(
          (value) => ({ value, error: '' }),
          (error: unknown) => ({ value: [], error: String(error) }),
        ),
      ],
    );
    issue.links = [
      ...blockedByResult.value.map((item: any) => ({
        key: rawKey(item),
        summary: item.title,
        relationship: 'blocked by',
      })),
      ...blockingResult.value.map((item: any) => ({
        key: rawKey(item),
        summary: item.title,
        relationship: 'blocks',
      })),
    ];
    return {
      issue,
      description: String(raw.body ?? ''),
      comments: commentsResult.value.map((item: any) => ({
        id: String(item.id),
        author: item.user?.login ?? 'Unknown',
        created: item.created_at,
        body: String(item.body ?? ''),
      })),
      totalComments: raw.comments ?? commentsResult.value.length,
      commentsError: commentsResult.error || undefined,
      linksError: blockedByResult.error || blockingResult.error || undefined,
    };
  }
  async search(
    query: string,
    token?: string,
    signal?: AbortSignal,
  ): Promise<SearchPage> {
    const repos = this.connection.repositories ?? [];
    let { repo, page } = pageToken(token);
    if (repo >= repos.length) throw new Error('Invalid GitHub search page.');
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => `"${term.replace(/["\\]/g, '')}"`)
      .join(' ');
    while (repo < repos.length) {
      const q = encodeURIComponent(
        `${terms} in:title,body repo:${repos[repo]} is:issue`,
      );
      const result = await this.request(
        `/search/issues?q=${q}&per_page=100&page=${page}`,
        { signal },
      );
      const issues = (result.items ?? [])
        .filter((item: any) => !item.pull_request)
        .map((item: any) => ({
          ...parseIssue(item),
          updated: item.updated_at,
        }));
      if (result.total_count > page * 100 && page < 10) page++;
      else {
        repo++;
        page = 1;
      }
      if (issues.length || repo >= repos.length)
        return {
          issues,
          nextPageToken:
            repo < repos.length
              ? Buffer.from(JSON.stringify({ repo, page })).toString(
                  'base64url',
                )
              : undefined,
        };
    }
    throw new Error('Invalid GitHub search page.');
  }
  async priorities(): Promise<Choice[]> {
    return [];
  }
  async priorityOrder(): Promise<string[]> {
    return [];
  }
  async transitions(): Promise<EditOptions['transitions']> {
    return [
      { id: 'open', name: 'Open', requiresFields: false },
      { id: 'closed', name: 'Closed', requiresFields: false },
    ];
  }
  invalidateChoices() {}
  async cachedUsers(): Promise<Choice[]> {
    return [];
  }
  async assignees(key: string, query = '', startAt = 0): Promise<AssigneePage> {
    const { repo } = this.assertSelected(key);
    const users = await this.request(
      `/repos/${repo}/assignees?per_page=100&page=${Math.floor(startAt / 100) + 1}`,
    );
    return {
      users: users
        .filter((item: any) =>
          item.login.toLowerCase().includes(query.toLowerCase()),
        )
        .map((item: any) => ({ id: item.login, name: item.login })),
      nextStartAt: users.length === 100 ? startAt + 100 : undefined,
    };
  }
  async validateAssignee(
    key: string,
    accountId: string,
  ): Promise<Choice | null> {
    const { repo } = this.assertSelected(key);
    const users = await this.all(`/repos/${repo}/assignees`);
    const user = users.find(
      (item) => item.login.toLowerCase() === accountId.toLowerCase(),
    );
    return user ? { id: user.login, name: user.login } : null;
  }
  async labels(key: string): Promise<Choice[]> {
    const { repo } = this.assertSelected(key);
    return (await this.all(`/repos/${repo}/labels`)).map((item) => ({
      id: item.name,
      name: item.name,
    }));
  }
  async update(key: string, patch: IssuePatch): Promise<Issue> {
    if (patch.priorityId !== undefined)
      throw new Error('GitHub issues do not have Jira priority.');
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.title = patch.summary;
    if (patch.assigneeId !== undefined)
      body.assignees = patch.assigneeId ? [patch.assigneeId] : [];
    if (patch.transitionId !== undefined) {
      if (!['open', 'closed'].includes(patch.transitionId))
        throw new Error('Choose Open or Closed.');
      body.state = patch.transitionId;
    }
    if (patch.labels !== undefined) body.labels = patch.labels;
    const raw = await this.request(this.path(key), {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return parseIssue(raw);
  }
  async rank(): Promise<void> {
    throw new Error('GitHub issues do not support ranking.');
  }
}
