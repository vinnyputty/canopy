import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubProvider, githubIssueUrl, githubKey } from '../src/main/github';
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
  for (const input of [
    'https://evil.example/team/a/issues/1',
    'team/a#0',
    'https://github.com/team/a/pull/1',
  ])
    assert.throws(() => githubKey(input));
});

test('GitHub tree follows paginated sub-issues across selected repositories and warns about inaccessible children', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    if (path === '/repos/team/a/issues/1') return raw('team/a', 1);
    if (path === '/repos/team/a/issues/1/sub_issues?per_page=100&page=1')
      return [raw('team/b', 2), raw('other/hidden', 3)];
    if (path === '/repos/team/b/issues/2/sub_issues?per_page=100&page=1')
      return [
        raw('team/b', 4, { state: 'closed', labels: [{ name: 'ready' }] }),
      ];
    if (path === '/repos/team/b/issues/4/sub_issues?per_page=100&page=1')
      return [];
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
});

test('GitHub search paginates selected repositories and preserves repository identity', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(connection, async (path) => {
    paths.push(path);
    return {
      total_count: 1,
      items: [raw(path.includes('repo%3Ateam%2Fa') ? 'team/a' : 'team/b', 1)],
    };
  });
  const first = await provider.search('fix');
  assert.equal(first.issues[0].key, 'team/a#1');
  const second = await provider.search('fix', first.nextPageToken);
  assert.equal(second.issues[0].key, 'team/b#1');
  assert.equal(second.nextPageToken, undefined);
  assert.match(paths[0], /is%3Aissue/);
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

test('GitHub connection verifies issue access before saving and rate limits requests', async () => {
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
      return new Response('{}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil((Date.now() + 60_000) / 1000)),
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
    assert.ok(auth.githubSyncStatus(connected[0].id).retryAt);
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
