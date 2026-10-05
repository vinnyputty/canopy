import { relationshipFailure } from '../shared/relationships';
import { TreeLoad, type TreeLoadOptions } from './tree-load';
import type {
  AssigneePage,
  Choice,
  CommentPage,
  Connection,
  DevelopmentLinks,
  EditOptions,
  Issue,
  IssuePatch,
  IssuePreview,
  IssueRelationships,
  Relationship,
  RelationshipGroup,
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
export function githubDevelopmentUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(?:pull\/[1-9]\d*|commit\/[a-f0-9]{7,64})\/?$/i.test(
      url.pathname,
    )
  )
    throw new Error('Invalid GitHub development link.');
  return url.href;
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
    linksAvailable: false,
    ...(Number.isSafeInteger(raw.comments) && raw.comments >= 0
      ? { commentCount: raw.comments }
      : {}),
    unavailableFields: [
      'priority',
      ...(raw.labels === undefined ? ['labels'] : []),
      ...(raw.title === undefined ? ['summary'] : []),
      ...(raw.state === undefined ? ['status'] : []),
      ...(raw.assignee === undefined && raw.assignees === undefined
        ? ['assignee']
        : []),
    ],
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
  private async all(
    path: string,
    load?: TreeLoad,
    accept?: (batch: any[]) => void,
  ): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const fetch = () =>
        this.request(
          `${path}${separator}per_page=100&page=${page}`,
          load?.options.signal ? { signal: load.options.signal } : undefined,
        );
      const batch = await (load ? load.read(fetch) : fetch());
      if (!Array.isArray(batch))
        throw new Error('GitHub returned an invalid page.');
      if (accept) accept(batch);
      else items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub returned more than 10,000 issues for this view.');
  }
  private async childMetadata(
    candidates: { key: string; nodeId: string }[],
    load?: TreeLoad,
  ): Promise<ChildMetadata[]> {
    const metadata: ChildMetadata[] = [];
    for (let start = 0; start < candidates.length; start += 100) {
      const batch = candidates.slice(start, start + 100);
      const fetch = () =>
        this.request('/graphql', {
          signal: load?.options.signal,
          method: 'POST',
          body: JSON.stringify({
            query:
              'query($ids:[ID!]!){nodes(ids:$ids){... on Issue{parent{url} subIssuesSummary{total}}}}',
            variables: { ids: batch.map((item) => item.nodeId) },
          }),
        });
      const result = await (load ? load.read(fetch) : fetch());
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
  private repositoryRoot(repo: string): Issue {
    return {
      id: `repository:${repo}`,
      key: repo,
      summary: 'Repository',
      type: 'Repository',
      priority: null,
      assignee: null,
      status: { id: 'repository', name: 'Repository', category: 'new' },
      links: [],
    };
  }
  async tree(
    rootKey: string,
    options: TreeLoadOptions = {},
  ): Promise<TreeSnapshot> {
    const root = githubRootKey(rootKey);
    const repoRoot = !root.includes('#');
    const load = new TreeLoad(options);
    if (repoRoot && !this.selected.has(root))
      throw new Error(
        `Repository ${root} is outside this GitHub connection. Add it to the connection and token selection.`,
      );
    const raw = repoRoot
      ? undefined
      : await load.read(() =>
          this.request(this.path(root), { signal: options.signal }),
        );
    if (raw?.pull_request)
      throw new Error('This reference is a pull request. Open a GitHub issue.');
    const first = repoRoot ? this.repositoryRoot(root) : parseIssue(raw);
    const issues = new Map<string, Issue>([[root, first]]);
    const warnings: string[] = [];
    const snapshot = (): TreeSnapshot => ({
      rootKey: root,
      issues: [...issues.values()],
      fetchedAt: Date.now(),
      warnings: [...warnings],
      ranking: {
        state: 'unsupported',
        reason: 'GitHub issues have no Jira rank.',
        issueKeys: [],
      },
    });
    const progress = () => load.emit(snapshot);
    progress();
    const accept = (
      batch: any[],
      parent: string,
      candidates: { key: string; nodeId: string }[],
      fallback: string[],
    ) => {
      for (const raw of batch) {
        if (raw.pull_request) continue;
        const key = rawKey(raw);
        if (!this.selected.has(parts(key).repo)) {
          warnings.push(
            `${key} is outside the selected repositories. Add that repository to read this subtree.`,
          );
          continue;
        }
        const existing = issues.get(key);
        if (existing) {
          if (repoRoot && key !== root) existing.parentKey = parent;
          else warnings.push(`Ignored duplicate or cyclic child ${key}.`);
          continue;
        }
        load.checkSize(issues.size);
        issues.set(key, parseIssue(raw, parent));
        if (typeof raw.node_id === 'string')
          candidates.push({ key, nodeId: raw.node_id });
        else fallback.push(key);
      }
      progress();
    };
    try {
      let frontier = [root];
      if (repoRoot) {
        const candidates: { key: string; nodeId: string }[] = [];
        const fallback: string[] = [];
        await this.all(`/repos/${root}/issues?state=all`, load, (batch) =>
          accept(batch, root, candidates, fallback),
        );
        const metadata = await this.childMetadata(candidates, load);
        for (const item of metadata) {
          if (item.parentKey && issues.has(item.parentKey))
            issues.get(item.key)!.parentKey = item.parentKey;
        }
        frontier = [
          ...fallback,
          ...metadata.filter((item) => item.count > 0).map((item) => item.key),
        ];
        progress();
      }
      const walked = new Set<string>();
      while (frontier.length) {
        const candidates: { key: string; nodeId: string }[] = [];
        const fallback: string[] = [];
        for (const parent of frontier) {
          if (walked.has(parent)) continue;
          walked.add(parent);
          await this.all(this.path(parent, '/sub_issues'), load, (batch) =>
            accept(batch, parent, candidates, fallback),
          );
        }
        frontier = [
          ...fallback,
          ...(await this.childMetadata(candidates, load))
            .filter((item) => item.count > 0)
            .map((item) => item.key),
        ];
      }
      return snapshot();
    } catch (error) {
      return load.partial(root, [...issues.values()], warnings, error);
    }
  }
  async olderComments(key: string, page: number): Promise<CommentPage> {
    if (!Number.isSafeInteger(page) || page < 1)
      throw new Error('Invalid GitHub comment page.');
    const items = await this.request(
      `${this.path(key, '/comments')}?per_page=100&page=${page}`,
    );
    if (!Array.isArray(items) || items.length > 100)
      throw new Error('GitHub returned an invalid comment page.');
    return {
      comments: items.map((item: any) => ({
        id: String(item.id),
        author: item.user?.login ?? 'Unknown',
        created: item.created_at,
        body: String(item.body ?? ''),
      })),
      start: items.length ? (page - 1) * 100 + 1 : 0,
      end: items.length ? (page - 1) * 100 + items.length : 0,
      olderPage: page > 1 ? page - 1 : undefined,
    };
  }
  async preview(key: string): Promise<IssuePreview> {
    const raw = await this.request(this.path(key));
    const issue = parseIssue(raw);
    const latestPage = Math.max(1, Math.ceil((issue.commentCount ?? 0) / 100));
    const commentsResult = await this.olderComments(key, latestPage).then(
      (value) => ({ value, error: '' }),
      (error: unknown) => ({ value: undefined, error: String(error) }),
    );
    return {
      issue,
      metadata: {
        reporter: raw.user?.login ?? (raw.user === null ? null : undefined),
        created: raw.created_at,
        updated: raw.updated_at,
        milestone:
          raw.milestone?.title ?? (raw.milestone === null ? null : undefined),
      },
      description: String(raw.body ?? ''),
      descriptionMarkdown: String(raw.body ?? ''),
      comments: commentsResult.value?.comments ?? [],
      commentPage: commentsResult.value && {
        start: commentsResult.value.start,
        end: commentsResult.value.end,
        olderPage: commentsResult.value.olderPage,
      },
      totalComments: raw.comments ?? commentsResult.value?.comments.length ?? 0,
      commentsError: commentsResult.error || undefined,
    };
  }
  async relationships(
    key: string,
    signal?: AbortSignal,
  ): Promise<IssueRelationships> {
    const source = this.assertSelected(key);
    const item = (
      raw: any,
      relationship: string,
      direction: Relationship['direction'],
    ): Relationship => {
      const target = rawKey(raw);
      return {
        key: target,
        summary: String(raw.title ?? target),
        relationship,
        direction,
        statusCategory:
          raw.state === 'closed'
            ? 'done'
            : raw.state === 'open'
              ? 'new'
              : undefined,
        access: this.selected.has(parts(target).repo)
          ? 'available'
          : 'outside-connection',
        crossRepository: parts(target).repo !== source.repo,
      };
    };
    const list = async (
      kind: RelationshipGroup['kind'],
      suffix: string,
      label: string,
      direction: Relationship['direction'],
    ): Promise<RelationshipGroup> => {
      const items: Relationship[] = [];
      try {
        for (let page = 1; page <= 2; page++) {
          signal?.throwIfAborted();
          const raw = await this.request(
            `${this.path(key, suffix)}?per_page=100&page=${page}`,
            { signal },
          );
          signal?.throwIfAborted();
          if (!Array.isArray(raw) || raw.length > 100)
            throw new Error('Invalid relationship page');
          for (const value of raw) items.push(item(value, label, direction));
          if (raw.length < 100) return { kind, state: 'visible', items };
        }
        return {
          kind,
          state: 'partial',
          problem: 'limit',
          reason: 'Showing at most 200 relationships; more may exist.',
          items,
        };
      } catch (error) {
        return {
          kind,
          state: items.length ? 'partial' : 'unavailable',
          ...relationshipFailure(error, signal),
          items,
        };
      }
    };
    const parent = async (): Promise<RelationshipGroup> => {
      try {
        signal?.throwIfAborted();
        // GraphQL distinguishes an accessible issue with no parent from an inaccessible node.
        const result = await this.request('/graphql', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            query:
              'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{url title state}}}}',
            variables: {
              owner: source.repo.split('/')[0],
              repo: source.repo.split('/')[1],
              number: Number(source.number),
            },
          }),
        });
        signal?.throwIfAborted();
        const issue = result.data?.repository?.issue;
        if (result.errors?.length || !issue || !('parent' in issue))
          throw new Error('Incomplete parent data');
        const raw = issue.parent;
        return {
          kind: 'parent',
          state: 'visible',
          items: raw
            ? [
                item(
                  {
                    html_url: raw.url,
                    title: raw.title,
                    state: raw.state?.toLowerCase(),
                  },
                  'child of',
                  'inward',
                ),
              ]
            : [],
        };
      } catch (error) {
        return {
          kind: 'parent',
          state: 'unavailable',
          ...relationshipFailure(error, signal),
          items: [],
        };
      }
    };
    const related = async (): Promise<RelationshipGroup> => {
      const items: Relationship[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 2; page++) {
          signal?.throwIfAborted();
          const result = await this.request('/graphql', {
            method: 'POST',
            signal,
            body: JSON.stringify({
              query:
                'query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){issue(number:$number){relatesTo(first:100,after:$after){nodes{url title state} pageInfo{hasNextPage endCursor}}}}}',
              variables: {
                owner: source.repo.split('/')[0],
                repo: source.repo.split('/')[1],
                number: Number(source.number),
                after: cursor ?? null,
              },
            }),
          });
          signal?.throwIfAborted();
          const links = result.data?.repository?.issue?.relatesTo;
          if (
            result.errors?.length ||
            !Array.isArray(links?.nodes) ||
            links.nodes.length > 100 ||
            typeof links.pageInfo?.hasNextPage !== 'boolean'
          )
            throw new Error('Incomplete related data');
          for (const raw of links.nodes)
            items.push(
              item(
                {
                  html_url: raw.url,
                  title: raw.title,
                  state: raw.state?.toLowerCase(),
                },
                'relates to',
                'outward',
              ),
            );
          if (!links.pageInfo.hasNextPage)
            return { kind: 'related', state: 'visible', items };
          const next = links.pageInfo.endCursor;
          if (typeof next !== 'string' || !next || next === cursor)
            throw new Error('Invalid related cursor');
          cursor = next;
        }
        return {
          kind: 'related',
          state: 'partial',
          problem: 'limit',
          reason: 'Showing at most 200 related issues; more may exist.',
          items,
        };
      } catch (error) {
        return {
          kind: 'related',
          state: items.length ? 'partial' : 'unavailable',
          ...relationshipFailure(error, signal),
          items,
        };
      }
    };
    const groups = await Promise.all([
      list('blockers', '/dependencies/blocked_by', 'blocked by', 'inward'),
      list('blocked', '/dependencies/blocking', 'blocks', 'outward'),
      related(),
      parent(),
      list('children', '/sub_issues', 'parent of', 'outward'),
    ]);
    signal?.throwIfAborted();

    return { key, groups };
  }
  async development(key: string): Promise<DevelopmentLinks> {
    const events = await this.all(this.path(key, '/timeline'));
    const pullRequests = new Map<
      string,
      DevelopmentLinks['pullRequests'][number]
    >();
    const commits = new Map<string, DevelopmentLinks['commits'][number]>();
    for (const event of events) {
      if (
        event.event === 'cross-referenced' &&
        event.source?.issue?.pull_request
      ) {
        const source = event.source.issue;
        try {
          const url = githubDevelopmentUrl(
            String(source.pull_request.html_url ?? source.html_url),
          );
          if (!/\/pull\//.test(new URL(url).pathname)) continue;
          pullRequests.set(url, {
            title: String(
              source.title || `Pull request #${source.number ?? ''}`,
            ),
            url,
            state: source.pull_request.merged_at
              ? 'Merged'
              : source.state === 'closed'
                ? 'Closed'
                : source.state === 'open'
                  ? 'Open'
                  : 'State unavailable',
          });
        } catch {}
      }
      if (
        event.event === 'referenced' &&
        /^[a-f0-9]{7,64}$/i.test(String(event.commit_id ?? ''))
      ) {
        const api =
          /^https:\/\/api\.github\.com\/repos\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/commits\/([a-f0-9]{7,64})$/i.exec(
            String(event.commit_url ?? ''),
          );
        if (!api) continue;
        const url = githubDevelopmentUrl(
          `https://github.com/${api[1]}/${api[2]}/commit/${api[3]}`,
        );
        commits.set(url, {
          title: api[3].slice(0, 7),
          url,
          state: 'Referenced',
        });
      }
    }
    return {
      state: 'available',
      source: 'github-timeline',
      branches: {
        state: 'unavailable',
        reason:
          'GitHub does not expose issue branch associations through this connection.',
      },
      pullRequests: [...pullRequests.values()],
      commits: [...commits.values()],
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
    const issues: SearchPage['issues'] = [];
    const boundaries: NonNullable<SearchPage['boundaries']> = [];
    let searched = 0;
    while (repo < repos.length && searched < 10) {
      const q = encodeURIComponent(
        `${terms} in:title,body repo:${repos[repo]} is:issue`,
      );
      const result = await this.request(
        `/search/issues?q=${q}&per_page=100&page=${page}`,
        { signal },
      );
      searched++;
      if (result.total_count > 1000)
        boundaries.push({ repository: repos[repo], reason: 'limit' });
      if (result.incomplete_results === true)
        boundaries.push({ repository: repos[repo], reason: 'incomplete' });
      issues.push(
        ...(result.items ?? [])
          .filter((item: any) => !item.pull_request)
          .map((item: any) => ({
            ...parseIssue(item),
            updated: item.updated_at,
          })),
      );
      if (result.total_count > page * 100 && page < 10) {
        return {
          issues,
          boundaries,
          nextPageToken: Buffer.from(
            JSON.stringify({ repo, page: page + 1 }),
          ).toString('base64url'),
          nextPageKind: 'issues',
        };
      }
      repo++;
      page = 1;
    }
    return repo < repos.length
      ? {
          issues,
          boundaries,
          nextPageToken: Buffer.from(JSON.stringify({ repo, page })).toString(
            'base64url',
          ),
          nextPageKind: 'repositories',
        }
      : { issues, boundaries };
  }
  async priorities(): Promise<Choice[]> {
    return [];
  }
  async priorityOrder(): Promise<string[]> {
    return [];
  }
  async transitions(): Promise<EditOptions['transitions']> {
    return [
      {
        id: 'open',
        name: 'Open',
        requiresFields: false,
        to: { id: 'open', name: 'Open', category: 'new' },
      },
      {
        id: 'closed',
        name: 'Closed',
        requiresFields: false,
        to: { id: 'closed', name: 'Closed', category: 'done' },
      },
    ];
  }
  invalidateChoices() {}
  async cachedUsers(): Promise<Choice[]> {
    return [];
  }
  async assignees(key: string, query = '', startAt = 0): Promise<AssigneePage> {
    const { repo } = this.assertSelected(key);
    if (!Number.isSafeInteger(startAt) || startAt < 0 || startAt % 100)
      throw new Error('Invalid GitHub assignee cursor.');
    const normalized = query.trim().toLowerCase();
    const matches: Choice[] = [];
    // REST has no assignee query filter. Bound each scan, including network time;
    // the cursor always points to the first page we have not fully consumed.
    const signal = AbortSignal.timeout(5_000);
    let cursor = startAt;
    for (let page = 0; page < (normalized ? 5 : 1); page++) {
      let users: any;
      try {
        users = await this.request(
          `/repos/${repo}/assignees?per_page=100&page=${cursor / 100 + 1}`,
          { signal },
        );
      } catch (error) {
        // Fetch rejects with the signal reason before headers, or AbortError
        // during body consumption. An elapsed deadline alone is not an error type.
        if (
          signal.aborted &&
          (error === signal.reason ||
            (error instanceof DOMException && error.name === 'AbortError'))
        )
          return { users: matches, nextStartAt: cursor };
        throw error;
      }
      if (
        !Array.isArray(users) ||
        users.length > 100 ||
        users.some((user) => typeof user?.login !== 'string')
      )
        throw new Error('GitHub returned an invalid assignee page.');
      matches.push(
        ...users
          .filter((user) => user.login.toLowerCase().includes(normalized))
          .map((user) => ({ id: user.login, name: user.login })),
      );
      if (users.length < 100) return { users: matches };
      cursor += 100;
      if (signal.aborted) break;
    }
    return { users: matches, nextStartAt: cursor };
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
