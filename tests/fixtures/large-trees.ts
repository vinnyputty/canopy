import { JiraProvider } from '../../src/main/jira';
import { GithubProvider } from '../../src/main/github';

export type Shape = 'wide' | 'tiered' | 'deep';
/** Deterministic wire fixtures; transport only, all parsing/traversal is production code. */
export function largeProvider(
  kind: 'jira' | 'github',
  shape: Shape,
  size: number,
  root = 0,
  latency = 0,
  implementations = { JiraProvider, GithubProvider },
) {
  const repo = `sample/project-${root}`;
  const key = (i: number) =>
    kind === 'jira' ? `PERF${root}-${i + 1}` : `${repo}#${i + 1}`;
  const parent = (i: number) =>
    i === 0
      ? undefined
      : shape === 'wide'
        ? 0
        : shape === 'deep'
          ? i - 1
          : i <= 100
            ? 0
            : 1 + ((i - 101) % 100);
  const raw = Array.from({ length: size }, (_, i) =>
    kind === 'jira'
      ? {
          id: String(root * 100000 + i + 1),
          key: key(i),
          fields: {
            summary: `Service ${i % 37}: investigate queue saturation and retry budget for region ${i % 9}`,
            issuetype: { id: '10001', name: i === 0 ? 'Epic' : 'Task' },
            project: { id: '10000' },
            parent: parent(i) === undefined ? null : { key: key(parent(i)!) },
            priority: {
              id: String(1 + (i % 4)),
              name: ['Highest', 'High', 'Medium', 'Low'][i % 4],
            },
            assignee:
              i % 7
                ? {
                    accountId: `user-${i % 25}`,
                    displayName: `Engineer ${i % 25}`,
                  }
                : null,
            status: {
              id: String(i % 3),
              name: ['Open', 'In progress', 'Done'][i % 3],
              statusCategory: { key: ['new', 'indeterminate', 'done'][i % 3] },
            },
            updated: '2026-09-30T12:00:00.000Z',
            comment: { total: i % 13 },
            issuelinks:
              i % 5
                ? []
                : [
                    {
                      type: { outward: 'blocks' },
                      outwardIssue: {
                        key: `OTHER-${i + 1}`,
                        fields: {
                          summary: 'Regional rollout dependency',
                          status: { statusCategory: { key: 'new' } },
                        },
                      },
                    },
                  ],
          },
        }
      : {
          id: root * 100000 + i + 1,
          node_id: `node-${i}`,
          number: i + 1,
          html_url: `https://github.com/${repo}/issues/${i + 1}`,
          title: `Service ${i % 37}: investigate queue saturation and retry budget for region ${i % 9}`,
          state: i % 3 === 2 ? 'closed' : 'open',
          assignee: i % 7 ? { login: `engineer-${i % 25}` } : null,
          labels: [{ name: 'performance' }, { name: `region-${i % 9}` }],
          comments: i % 13,
          body: 'Investigation context and reproduction notes. '.repeat(30),
          updated_at: '2026-09-30T12:00:00Z',
        },
  );
  const children = new Map<string, any[]>();
  for (let i = 1; i < size; i++) {
    const p = key(parent(i)!);
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(raw[i]);
  }
  let calls = 0;
  let failAt = Infinity;
  let onCall: (() => void) | undefined;
  const request = async (path: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    calls++;
    onCall?.();
    if (latency) await new Promise((r) => setTimeout(r, latency));
    init?.signal?.throwIfAborted();
    if (calls >= failAt) throw new Error('Offline fixture transport');
    if (kind === 'jira') {
      if (path.startsWith('/rest/api/3/issue/'))
        return raw.find(
          (x) =>
            x.key ===
            decodeURIComponent(path.split('/issue/')[1].split('?')[0]),
        );
      const body = JSON.parse(String(init?.body));
      if (path === '/rest/api/3/permissions/check')
        return {
          projectPermissions: ['SCHEDULE_ISSUES', 'EDIT_ISSUES'].map(
            (permission) => ({
              permission,
              issues: body.projectPermissions[0].issues,
            }),
          ),
        };
      const parents = [...body.jql.matchAll(/"([^"]+)"/g)].map(
        (m: any) => m[1],
      );
      const items = parents.flatMap((p: string) => children.get(p) ?? []);
      const start = Number(body.nextPageToken ?? 0);
      return {
        issues: items.slice(start, start + 100),
        isLast: start + 100 >= items.length,
        ...(start + 100 < items.length
          ? { nextPageToken: String(start + 100) }
          : {}),
      };
    }
    if (path === '/graphql') {
      const body = JSON.parse(String(init?.body));
      return {
        data: {
          nodes: body.variables.ids.map((id: string) => {
            const i = Number(id.slice(5));
            return {
              parent:
                parent(i) === undefined
                  ? null
                  : {
                      url: `https://github.com/${repo}/issues/${parent(i)! + 1}`,
                    },
              subIssuesSummary: { total: children.get(key(i))?.length ?? 0 },
            };
          }),
        },
      };
    }
    const url = new URL(path, 'https://api.github.com');
    const page = Number(url.searchParams.get('page') ?? 1);
    const match = url.pathname.match(/\/issues\/(\d+)(\/sub_issues)?$/);
    if (!match) return raw.slice((page - 1) * 100, page * 100);
    if (!match[2]) return raw[Number(match[1]) - 1];
    return (children.get(key(Number(match[1]) - 1)) ?? []).slice(
      (page - 1) * 100,
      page * 100,
    );
  };
  const provider =
    kind === 'jira'
      ? new implementations.JiraProvider(request)
      : new implementations.GithubProvider(
          {
            id: `github-${root}`,
            provider: 'github',
            name: 'Fixture',
            url: 'https://github.com',
            repositories: [repo],
          },
          request,
        );
  return {
    provider,
    request,
    rootKey: key(0),
    repository: repo,
    calls: () => calls,
    fail: (at: number) => {
      failAt = at;
    },
    onCall: (fn: () => void) => {
      onCall = fn;
    },
  };
}
