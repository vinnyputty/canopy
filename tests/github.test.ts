import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GithubProvider,
  githubDevelopmentUrl,
  githubIssueUrl,
  githubKey,
  githubRootKey,
  githubRootUrl,
} from '../src/main/github';
import { buildIssueTree, visibleTree } from '../src/renderer/tree';
import { Auth } from '../src/main/auth';
import type { Connection } from '../src/shared/types';
import type { Storage } from '../src/main/storage';

const connection: Connection = {
  id: 'github:test',
  provider: 'github',
  name: 'GitHub',
  url: 'https://github.com',
  repositories: ['team/a', 'team/b'],
};
const raw = (
  repo: string,
  number: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `${repo}-${number}`,
  node_id: `${repo}-${number}`,
  html_url: `https://github.com/${repo}/issues/${number}`,
  number,
  title: `${repo} ${number}`,
  state: 'open',
  labels: [],
  ...extra,
});

test('GitHub references accept only issue URLs and owner/repo numbers', () => {
  assert.equal(githubKey(' TEAM/A#12 '), 'team/a#12');
  assert.equal(githubKey('https://github.com/TEAM/B/issues/42'), 'team/b#42');
  assert.equal(
    githubIssueUrl('team/b#42'),
    'https://github.com/team/b/issues/42',
  );
  assert.equal(githubRootKey('https://github.com/TEAM/A'), 'team/a');
  assert.equal(githubRootUrl('team/a'), 'https://github.com/team/a');
  for (const input of [
    'https://evil.example/team/a/issues/1',
    'team/a#0',
    'https://github.com/team/a/pull/1',
  ])
    assert.throws(() => githubKey(input));
});

test('GitHub transitions include destination states for validated Undo', async () => {
  const provider = new GithubProvider(connection, async () => []);
  assert.deepEqual(
    (await provider.transitions()).map((value) => value.to),
    [
      { id: 'open', name: 'Open', category: 'new' },
      { id: 'closed', name: 'Closed', category: 'done' },
    ],
  );
});

test('GitHub development loads timeline associations with safe links and states', async () => {
  const paths: string[] = [];
  const sha = 'a'.repeat(40);
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    if (path.endsWith('/timeline?per_page=100&page=1'))
      return [
        {
          event: 'cross-referenced',
          source: {
            issue: {
              title: 'Fix it',
              state: 'open',
              pull_request: { html_url: 'https://github.com/team/a/pull/7' },
            },
          },
        },
        {
          event: 'cross-referenced',
          source: {
            issue: {
              title: 'Unsafe',
              state: 'closed',
              pull_request: { html_url: 'https://evil.example/team/a/pull/8' },
            },
          },
        },
        {
          event: 'referenced',
          commit_id: sha,
          commit_url: `https://api.github.com/repos/team/a/commits/${sha}`,
        },
        {
          event: 'referenced',
          commit_id: sha,
          commit_url: `https://api.github.com/repos/team/a/commits/${sha}`,
        },
      ];
    throw new Error(path);
  });
  const result = await provider.development('team/a#1');
  assert.deepEqual(paths, [
    '/repos/team/a/issues/1/timeline?per_page=100&page=1',
  ]);
  assert.equal(result.state, 'available');
  assert.deepEqual(result.pullRequests, [
    {
      title: 'Fix it',
      url: 'https://github.com/team/a/pull/7',
      state: 'Open',
    },
  ]);
  assert.deepEqual(result.commits, [
    {
      title: 'aaaaaaa',
      url: `https://github.com/team/a/commit/${sha}`,
      state: 'Referenced',
    },
  ]);
  assert.equal(result.branches.state, 'unavailable');
  assert.throws(() =>
    githubDevelopmentUrl('https://github.com.evil.example/team/a/pull/7'),
  );
  assert.throws(() =>
    githubDevelopmentUrl('https://github.com/team/a/pull/7?x=1'),
  );
});

test('GitHub repository roots preserve sub-issues and hide closed leaves', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path, init) => {
    paths.push(path);
    if (path === '/repos/team/a/issues?state=all&per_page=100&page=1')
      return [
        raw('team/a', 1),
        raw('team/a', 3, { state: 'closed' }),
        raw('team/a', 4, { pull_request: {} }),
      ];
    if (path === '/repos/team/a/issues/1/sub_issues?per_page=100&page=1')
      return [raw('team/a', 3, { state: 'closed' }), raw('team/b', 2)];
    if (path === '/graphql')
      return {
        data: {
          nodes: JSON.parse(String(init?.body)).variables.ids.map(
            (id: string) => ({
              parent:
                id === 'team/a-3' || id === 'team/b-2'
                  ? { url: 'https://github.com/team/a/issues/1' }
                  : null,
              subIssuesSummary: { total: id === 'team/a-1' ? 2 : 0 },
            }),
          ),
        },
      };
    throw new Error(path);
  });
  const snapshot = await provider.tree('team/a');
  assert.deepEqual(
    snapshot.issues.map((issue) => [issue.key, issue.parentKey]),
    [
      ['team/a', undefined],
      ['team/a#1', 'team/a'],
      ['team/a#3', 'team/a#1'],
      ['team/b#2', 'team/a#1'],
    ],
  );
  const root = buildIssueTree(snapshot.issues, snapshot.rootKey)!;
  assert.deepEqual(
    visibleTree(root, true, root.issue.key)!.children[0].children.map(
      (node) => node.issue.key,
    ),
    ['team/b#2'],
  );
  assert.equal(
    paths.includes('/repos/team/b/issues/2/sub_issues?per_page=100&page=1'),
    false,
  );
});

test('GitHub tree follows paginated sub-issues across selected repositories and warns about inaccessible children', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path, init) => {
    paths.push(path);
    if (path === '/repos/team/a/issues/1') return raw('team/a', 1);
    if (path === '/repos/team/a/issues/1/sub_issues?per_page=100&page=1')
      return [raw('team/b', 2), raw('other/hidden', 3)];
    if (path === '/repos/team/b/issues/2/sub_issues?per_page=100&page=1')
      return [
        raw('team/b', 4, { state: 'closed', labels: [{ name: 'ready' }] }),
      ];
    if (path === '/graphql')
      return {
        data: {
          nodes: JSON.parse(String(init?.body)).variables.ids.map(
            (id: string) => ({
              subIssuesSummary: { total: id === 'team/b-2' ? 1 : 0 },
            }),
          ),
        },
      };
    throw new Error(path);
  });
  const tree = await provider.tree('team/a#1');
  assert.deepEqual(
    tree.issues.map((issue) => [issue.key, issue.parentKey]),
    [
      ['team/a#1', undefined],
      ['team/b#2', 'team/a#1'],
      ['team/b#4', 'team/b#2'],
    ],
  );
  assert.equal(tree.issues[2].status.category, 'done');
  assert.deepEqual(tree.issues[2].labels, [{ id: 'ready', name: 'ready' }]);
  assert.match(tree.warnings[0], /outside the selected repositories/);
  assert.equal(
    paths.some((path) => path.includes('other/hidden')),
    false,
  );
  assert.equal(
    paths.some((path) => path.includes('/issues/4/sub_issues')),
    false,
  );
});

test('GitHub search includes selected repositories without an empty next page', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    return {
      total_count: path.includes('repo%3Ateam%2Fa') ? 1 : 0,
      items: path.includes('repo%3Ateam%2Fa') ? [raw('team/a', 1)] : [],
    };
  });
  const result = await provider.search('fix');
  assert.deepEqual(
    result.issues.map((issue) => issue.key),
    ['team/a#1'],
  );
  assert.equal(result.nextPageToken, undefined);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /is%3Aissue/);
});

test('GitHub search paginates when a repository has more matches', async () => {
  const provider = new GithubProvider(connection, async (path) => {
    if (path.includes('repo%3Ateam%2Fb')) return { total_count: 0, items: [] };
    const page = Number(
      new URL(path, 'https://api.github.com').searchParams.get('page'),
    );
    return {
      total_count: 101,
      items:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => raw('team/a', index + 1))
          : [raw('team/a', 101)],
    };
  });
  const first = await provider.search('fix');
  assert.equal(first.issues.length, 100);
  assert.ok(first.nextPageToken);
  const second = await provider.search('fix', first.nextPageToken);
  assert.deepEqual(
    second.issues.map((issue) => issue.key),
    ['team/a#101'],
  );
  assert.equal(second.nextPageToken, undefined);
});

test('GitHub search bounds repository requests and labels the continuation', async () => {
  const many: Connection = {
    ...connection,
    repositories: Array.from(
      { length: 12 },
      (_, index) => `team/repo-${index}`,
    ),
  };
  const paths: string[] = [];
  const provider = new GithubProvider(many, async (path) => {
    paths.push(path);
    return { total_count: 0, items: [] };
  });
  const first = await provider.search('fix');
  assert.equal(first.issues.length, 0);
  assert.equal(first.nextPageKind, 'repositories');
  assert.ok(first.nextPageToken);
  assert.equal(paths.length, 10);
  const second = await provider.search('fix', first.nextPageToken);
  assert.equal(second.nextPageToken, undefined);
  assert.equal(paths.length, 12);
});

test('GitHub search skips empty repositories before showing the first matches', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    return path.includes('repo%3Ateam%2Fa')
      ? { total_count: 0, items: [] }
      : {
          total_count: 3,
          items: [raw('team/b', 2), raw('team/b', 3), raw('team/b', 4)],
        };
  });
  const page = await provider.search('feature');
  assert.deepEqual(
    page.issues.map((issue) => issue.key),
    ['team/b#2', 'team/b#3', 'team/b#4'],
  );
  assert.equal(page.nextPageToken, undefined);
  assert.equal(paths.length, 2);
});

test('GitHub writes map title, assignee, labels, and state without Jira fields', async () => {
  let body: any;
  const provider = new GithubProvider(connection, async (_path, init) => {
    body = JSON.parse(String(init?.body));
    return raw('team/a', 1, {
      title: body.title,
      state: body.state,
      assignees: [{ login: body.assignees[0] }],
      labels: body.labels.map((name: string) => ({ name })),
    });
  });
  const issue = await provider.update('team/a#1', {
    summary: 'Done',
    assigneeId: 'alex',
    labels: ['ready'],
    transitionId: 'closed',
  });
  assert.deepEqual(body, {
    title: 'Done',
    assignees: ['alex'],
    state: 'closed',
    labels: ['ready'],
  });
  assert.equal(issue.status.category, 'done');
  await assert.rejects(
    provider.update('team/a#1', { priorityId: '1' }),
    /priority/,
  );
  await assert.rejects(
    provider.update('other/repo#1', { summary: 'No' }),
    /outside this GitHub connection/,
  );
});

test('GitHub connection verifies issue access and honors secondary rate-limit retry time', async () => {
  const original = globalThis.fetch;
  const saved: unknown[] = [];
  const auth = new Auth(
    {
      assertSecure() {},
      async writeSecrets(value: unknown) {
        saved.push(structuredClone(value));
      },
    } as unknown as Storage,
    async () => {},
  );
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/user') return Response.json({ login: 'alex' });
    if (path.endsWith('/issues')) return Response.json([]);
    if (path.endsWith('/issues/1'))
      return new Response('{"message":"secondary rate limit"}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '5',
          'x-ratelimit-reset': String(
            Math.ceil((Date.now() + 3_600_000) / 1000),
          ),
          'retry-after': '2',
        },
      });
    throw new Error(path);
  };
  try {
    const connected = await auth.connectGithub({
      token: 'secret-token',
      repositories: ['team/a', 'team/b'],
    });
    assert.equal(connected[0].provider, 'github');
    assert.equal(JSON.stringify(connected).includes('secret-token'), false);
    assert.equal(saved.length, 1);
    await assert.rejects(
      auth.githubRequest(connected[0].id, '/repos/team/a/issues/1'),
      /rate limit/,
    );
    const retryAt = auth.githubSyncStatus(connected[0].id).retryAt;
    assert.ok(retryAt && retryAt > Date.now());
    assert.ok(retryAt < Date.now() + 3_000);
    await assert.rejects(
      auth.githubRequest(connected[0].id, '/repos/team/a/issues/1'),
      /rate limit/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('GitHub connection distinguishes an empty repository from missing issue access', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  const auth = new Auth(
    {
      assertSecure() {},
      async writeSecrets() {
        writes++;
      },
    } as unknown as Storage,
    async () => {},
  );
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/user') return Response.json({ login: 'alex' });
    if (path.includes('/team/empty/')) return Response.json([]);
    return new Response('{}', { status: 404 });
  };
  try {
    await assert.rejects(
      auth.connectGithub({
        token: 'secret-token',
        repositories: ['team/empty', 'team/missing'],
      }),
      /verifying.*team\/missing/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(auth.connections(), []);
    await auth.connectGithub({
      token: 'secret-token',
      repositories: ['team/empty'],
    });
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('GitHub typed assignee search finds later pages and distinguishes exhausted results', async () => {
  const paths: string[] = [];
  let matchPage = 2;
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    const page = Number(
      new URL(path, 'https://api.github.com').searchParams.get('page'),
    );
    return page < matchPage
      ? Array.from({ length: 100 }, (_, index) => ({
          login: `other-${page}-${index}`,
        }))
      : [{ login: 'LateAda' }];
  });
  assert.deepEqual(await provider.assignees('team/a#1', '  lateADA  '), {
    users: [{ id: 'LateAda', name: 'LateAda' }],
  });
  assert.equal(paths.length, 2);
  matchPage = 3;
  paths.length = 0;
  assert.deepEqual(await provider.assignees('team/a#1', 'lateada'), {
    users: [{ id: 'LateAda', name: 'LateAda' }],
  });
  assert.equal(paths.length, 3);
  assert.deepEqual(await provider.assignees('team/a#1', 'missing'), {
    users: [],
  });
  assert.deepEqual(await provider.assignees('team/a#1', 'LateAda', 100), {
    users: [{ id: 'LateAda', name: 'LateAda' }],
  });
});

test('GitHub assignee scans bound requests and continue past unmatched windows', async () => {
  const pages: number[] = [];
  const provider = new GithubProvider(connection, async (path) => {
    const page = Number(
      new URL(path, 'https://api.github.com').searchParams.get('page'),
    );
    pages.push(page);
    return page <= 5
      ? Array.from({ length: 100 }, (_, index) => ({
          login: `other-${page}-${index}`,
        }))
      : [{ login: 'Ada' }];
  });
  const first = await provider.assignees('team/a#1', 'ada');
  assert.deepEqual(first, { users: [], nextStartAt: 500 });
  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    await provider.assignees('team/a#1', 'ada', first.nextStartAt),
    {
      users: [{ id: 'Ada', name: 'Ada' }],
    },
  );
  pages.length = 0;
  assert.equal((await provider.assignees('team/a#1')).nextStartAt, 100);
  assert.deepEqual(pages, [1]);
  for (const cursor of [-100, 1, NaN, Infinity])
    await assert.rejects(
      () => provider.assignees('team/a#1', 'ada', cursor),
      /cursor/,
    );
  assert.deepEqual(pages, [1]);
});

test('GitHub assignee deadline preserves matches and retries the interrupted page', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5_000);
    return controller.signal;
  });
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path, init) => {
    paths.push(path);
    assert.equal(init?.signal, controller.signal);
    if (paths.length === 1)
      return Array.from({ length: 100 }, (_, index) => ({
        login: `Ada-${index}`,
      }));
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    throw controller.signal.reason;
  });
  const result = await provider.assignees('team/a#1', 'ada');
  assert.equal(result.users.length, 100);
  assert.equal(result.nextStartAt, 100);
  assert.equal(paths.length, 2);
});

test('GitHub assignee failures remain errors and selection rechecks the selected repository', async () => {
  const paths: string[] = [];
  let eligible = true;
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    if (path.startsWith('/repos/team/b/')) throw new Error('Access denied');
    return eligible ? [{ login: 'Ada' }] : [];
  });
  assert.deepEqual((await provider.assignees('team/a#1', 'ada')).users, [
    { id: 'Ada', name: 'Ada' },
  ]);
  eligible = false;
  assert.equal(await provider.validateAssignee('team/a#1', 'Ada'), null);
  eligible = true;
  assert.deepEqual(await provider.validateAssignee('team/a#2', 'ada'), {
    id: 'Ada',
    name: 'Ada',
  });
  assert.equal(paths.length, 3);
  await assert.rejects(
    () => provider.assignees('team/b#1', 'ada'),
    /Access denied/,
  );
  await assert.rejects(
    () => provider.validateAssignee('team/b#1', 'Ada'),
    /Access denied/,
  );
  await assert.rejects(
    () => provider.assignees('elsewhere/repo#1', 'ada'),
    /outside/,
  );
});

test('GitHub rejects malformed assignee pages instead of reporting no match', async () => {
  for (const response of [null, {}, [null], [{ login: 42 }]]) {
    const provider = new GithubProvider(connection, async () => response);
    await assert.rejects(
      () => provider.assignees('team/a#1', 'ada'),
      /invalid assignee page/,
    );
  }
});

test('GitHub assignee deadline overlap preserves HTTP errors and rate-limit reset', async (t) => {
  let scanController: AbortController;
  let status = 429;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) =>
    milliseconds === 5_000 ? scanController.signal : timeout(milliseconds),
  );
  const reset = Math.ceil((Date.now() + 3_600_000) / 1000);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/user') return Response.json({ login: 'tester' });
    if (path.endsWith('/issues')) return Response.json([]);
    assert.equal(path, '/repos/team/a/assignees');
    const response = new Response('{}', {
      status,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
    });
    // Headers have arrived, but the deadline interrupts the error body read.
    t.mock.method(response, 'clone', () => ({
      async json() {
        scanController.abort(new DOMException('Timed out', 'TimeoutError'));
        throw scanController.signal.reason;
      },
    }));
    return response;
  });
  for (status of [429, 401, 503]) {
    scanController = new AbortController();
    const auth = new Auth(
      { assertSecure() {}, async writeSecrets() {} } as unknown as Storage,
      async () => {},
    );
    const [connected] = await auth.connectGithub({
      token: 'synthetic-token',
      repositories: ['team/a'],
    });
    const provider = new GithubProvider(connected, (path, init) =>
      auth.githubRequest(connected.id, path, init),
    );
    const expected =
      status === 429
        ? `GitHub rate limit reached. Retry after ${new Date(reset * 1000).toLocaleTimeString()}.`
        : status === 401
          ? 'GitHub authorization expired or was revoked. Reconnect this account.'
          : 'GitHub returned 503 for /repos/team/a/assignees?per_page=100&page=1.';
    await assert.rejects(() => provider.assignees('team/a#1', 'ada'), {
      message: expected,
    });
    assert.equal(scanController.signal.aborted, true);
    if (status === 429) {
      assert.equal(auth.githubSyncStatus(connected.id).retryAt, reset * 1000);
      await assert.rejects(() => provider.assignees('team/a#1', 'ada'), {
        message: expected,
      });
    }
  }
});

test('GitHub assignee deadline overlap preserves a network rejection', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const failure = new TypeError('fetch failed');
  const provider = new GithubProvider(connection, async () => {
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    throw failure;
  });
  await assert.rejects(
    () => provider.assignees('team/a#1', 'ada'),
    (error) => error === failure,
  );
});

test('GitHub actual scan timeouts preserve matches and the interrupted cursor for fetch and body rejections', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5_000);
    return timeout(5);
  });
  for (const bodyRead of [false, true]) {
    let requests = 0;
    const provider = new GithubProvider(connection, async (_path, init) => {
      requests++;
      if (requests === 1)
        return Array.from({ length: 100 }, (_, index) => ({
          login: `Ada-${index}`,
        }));
      // A referenced timer lets the real AbortSignal deadline fire in Node tests.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(init?.signal?.aborted, true);
      assert.equal(init.signal.reason.name, 'TimeoutError');
      if (bodyRead) throw new DOMException('Body read aborted', 'AbortError');
      throw init.signal.reason;
    });
    const page = await provider.assignees('team/a#1', 'ada');
    assert.equal(page.users.length, 100);
    assert.equal(page.nextStartAt, 100);
    assert.equal(requests, 2);
  }
});
