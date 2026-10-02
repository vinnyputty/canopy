import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GithubProvider } from '../src/main/github';
import { JiraProvider } from '../src/main/jira';
import { DemoProvider } from '../src/main/demo-provider';
import {
  relationshipBlockers,
  relationshipDestination,
} from '../src/renderer/relationships';
import { nextTasks } from '../src/renderer/next-tasks';
import { RelationshipGroups } from '../src/renderer/RelationshipGroups';
import {
  buildIssueTree,
  filterTree,
  flattenVisible,
} from '../src/renderer/tree';
import type {
  Connection,
  Issue,
  IssueRelationships,
  TabState,
  TreeSnapshot,
} from '../src/shared/types';

const connection: Connection = {
  id: 'gh',
  name: 'Work',
  url: 'https://github.com',
  provider: 'github',
  repositories: ['team/a', 'team/b'],
};
const raw = (repo: string, number: number, state = 'open') => ({
  html_url: `https://github.com/${repo}/issues/${number}`,
  title: `Issue ${number}`,
  state,
});
const issue = (key: string, patch: Partial<Issue> = {}): Issue => ({
  id: key,
  key,
  summary: key,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
  ...patch,
});
const graph = (
  state: 'visible' | 'partial' | 'unavailable',
  items: IssueRelationships['groups'][number]['items'] = [],
): IssueRelationships => ({
  key: 'team/a#1',
  groups: [{ kind: 'blockers', state, items }],
});
const blocker = {
  key: 'team/b#2',
  summary: 'Actual blocker',
  relationship: 'blocked by',
  direction: 'inward' as const,
  access: 'available' as const,
  statusCategory: 'new' as const,
};

function githubRequest(path: string, init?: RequestInit): Promise<any> {
  if (path === '/graphql') {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.query.startsWith('query('));
    assert.deepEqual(
      { ...body.variables, after: undefined },
      { owner: 'team', repo: 'a', number: 1, after: undefined },
    );
    return Promise.resolve({
      data: {
        repository: {
          issue: body.query.includes('relatesTo')
            ? {
                relatesTo: {
                  nodes: [
                    {
                      url: 'https://github.com/team/b/issues/3',
                      title: 'Typed related',
                      state: 'OPEN',
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
            : { parent: null },
        },
      },
    });
  }
  assert.equal(init?.method ?? 'GET', 'GET');
  if (path.includes('/dependencies/blocked_by'))
    return Promise.resolve([raw('team/b', 2), raw('other/private', 7)]);
  if (path.includes('/dependencies/blocking'))
    return Promise.resolve([raw('team/a', 4, 'closed')]);
  if (path.includes('/sub_issues')) return Promise.resolve([raw('team/b', 5)]);
  throw new Error(`Unexpected ${path}`);
}

test('GitHub returns true typed dependencies, related links and hierarchy with source direction and repository access', async () => {
  const result = await new GithubProvider(
    connection,
    githubRequest,
  ).relationships('team/a#1');
  assert.deepEqual(
    result.groups.map((group) => group.kind),
    ['blockers', 'blocked', 'related', 'parent', 'children'],
  );
  assert.ok(result.groups.every((group) => group.state === 'visible'));
  assert.equal(result.groups[0].items[0].direction, 'inward');
  assert.equal(result.groups[0].items[0].crossRepository, true);
  assert.equal(result.groups[0].items[1].access, 'outside-connection');
  assert.equal(result.groups[1].items[0].relationship, 'blocks');
  assert.equal(result.groups[1].items[0].statusCategory, 'done');
  assert.equal(result.groups[2].items[0].summary, 'Typed related');
  assert.equal(result.groups[3].items.length, 0);
  assert.equal(result.groups[4].items[0].relationship, 'parent of');
});

test('GitHub bounds reads, retains earlier pages on errors and redacts private response details', async () => {
  const calls: string[] = [];
  const provider = new GithubProvider(connection, async (path, init) => {
    calls.push(path);
    if (path.includes('blocked_by'))
      return Array.from({ length: 100 }, (_, i) => raw('team/b', i + 1));
    if (path.includes('/blocking'))
      throw new Error('GitHub 403: secret https://private.invalid/payload');
    return githubRequest(path, init);
  });
  const result = await provider.relationships('team/a#1');
  assert.equal(result.groups[0].state, 'partial');
  assert.equal(result.groups[0].items.length, 200);
  assert.equal(result.groups[0].problem, 'limit');
  assert.equal(calls.filter((path) => path.includes('blocked_by')).length, 2);
  assert.equal(result.groups[1].problem, 'inaccessible');
  assert.doesNotMatch(JSON.stringify(result), /secret|private.invalid/);
  assert.equal(
    relationshipBlockers(issue(result.key), result).blocker,
    'blocked',
  );
  assert.equal(
    relationshipBlockers(issue(result.key), result).incomplete,
    true,
  );
  const partial = await new GithubProvider(connection, async (path, init) => {
    if (path.includes('blocked_by')) {
      if (path.endsWith('page=2')) throw new Error('network failure');
      return Array.from({ length: 100 }, (_, i) =>
        raw('team/a', i + 10, 'closed'),
      );
    }
    return githubRequest(path, init);
  }).relationships('team/a#1');
  assert.equal(partial.groups[0].items.length, 100);
  assert.equal(partial.groups[0].state, 'partial');
  assert.equal(
    relationshipBlockers(issue(partial.key), partial).blocker,
    'unknown',
  );
});

test('GraphQL errors and null targets remain unknown, never successful empty results', async () => {
  const result = await new GithubProvider(connection, async (path, init) =>
    path === '/graphql'
      ? {
          errors: [{ message: 'private' }],
          data: { repository: { issue: null } },
        }
      : githubRequest(path, init),
  ).relationships('team/a#1');
  assert.equal(result.groups[2].state, 'unavailable');
  assert.equal(result.groups[3].state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private"/);
});

test('cancelled relationship reads cannot complete or start additional pages', async () => {
  const controller = new AbortController();
  let count = 0;
  const provider = new GithubProvider(connection, async (_path, init) => {
    assert.equal(init?.signal, controller.signal);
    count++;
    controller.abort();
    return [];
  });
  await assert.rejects(provider.relationships('team/a#1', controller.signal), {
    name: 'AbortError',
  });
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(provider.relationships('outside/repo#1'), /outside/);
  assert.equal(count, 0);
});

test('Jira respects inward/outward link ends and parent search semantics', async () => {
  const calls: string[] = [];
  const provider = new JiraProvider(async (path, init) => {
    calls.push(path);
    if (path.startsWith('/rest/api/3/issue/'))
      return {
        key: 'A-1',
        fields: {
          summary: 'Root',
          parent: { key: 'P-1', fields: { summary: 'Parent' } },
          issuelinks: [
            {
              type: {
                name: 'Blocks',
                inward: 'is blocked by',
                outward: 'blocks',
              },
              inwardIssue: {
                key: 'B-2',
                fields: {
                  summary: 'Blocker',
                  status: { statusCategory: { key: 'new' } },
                },
              },
            },
            {
              type: {
                name: 'Blocks',
                inward: 'is blocked by',
                outward: 'blocks',
              },
              outwardIssue: { key: 'B-3', fields: { summary: 'Blocked' } },
            },
            {
              type: { inward: 'is duplicated by', outward: 'duplicates' },
              outwardIssue: { key: 'B-4' },
            },
          ],
        },
      };
    assert.equal(path, '/rest/api/3/search/jql');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.jql, 'parent = "A-1"');
    assert.equal(body.maxResults, 100);
    return {
      isLast: true,
      issues: [
        {
          key: 'A-2',
          fields: {
            summary: 'Child',
            parent: { key: 'A-1' },
            status: { statusCategory: { key: 'done' } },
          },
        },
      ],
    };
  });
  const result = await provider.relationships('A-1');
  assert.equal(calls.length, 2);
  assert.equal(result.groups[0].items[0].key, 'B-2');
  assert.equal(result.groups[0].items[0].direction, 'inward');
  assert.equal(result.groups[1].items[0].direction, 'outward');
  assert.equal(result.groups[2].items[0].relationship, 'duplicates');
  assert.equal(result.groups[3].items[0].key, 'P-1');
  assert.equal(result.groups[4].items[0].statusCategory, 'done');
});

test('Jira omitted links/parent, malformed links and incomplete child pages are explicit', async () => {
  for (const fields of [
    { summary: 'Missing' },
    { issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' } }] },
  ]) {
    const result = await new JiraProvider(async (path) =>
      path.includes('/issue/')
        ? { key: 'A-1', fields }
        : { issues: [], isLast: false },
    ).relationships('A-1');
    assert.notEqual(result.groups[0].state, 'visible');
    assert.equal(result.groups[3].state, 'unavailable');
    assert.equal(result.groups[4].state, 'unavailable');
    assert.equal(relationshipBlockers(issue('A-1'), result).blocker, 'unknown');
  }
});

test('known active blockers win over partial data; completed or absent links require successful reads', () => {
  const target = issue('team/a#1');
  assert.equal(relationshipBlockers(target).blocker, 'unknown');
  assert.equal(relationshipBlockers(target, graph('visible')).blocker, 'clear');
  assert.equal(
    relationshipBlockers(target, graph('partial')).blocker,
    'unknown',
  );
  assert.equal(
    relationshipBlockers(target, graph('unavailable')).blocker,
    'unknown',
  );
  assert.equal(
    relationshipBlockers(
      target,
      graph('visible', [{ ...blocker, statusCategory: 'done' }]),
    ).blocker,
    'clear',
  );
  assert.equal(
    relationshipBlockers(
      target,
      graph('visible', [{ ...blocker, statusCategory: undefined }]),
    ).blocker,
    'unknown',
  );
  assert.equal(
    relationshipBlockers(target, graph('partial', [blocker])).blocker,
    'blocked',
  );
  assert.equal(
    relationshipBlockers(
      target,
      graph('visible', [{ ...blocker, statusCategory: undefined }]),
      new Map([
        [blocker.key, issue(blocker.key, { unavailableFields: ['status'] })],
      ]),
    ).blocker,
    'unknown',
  );
});

test('relationship jumps reuse owning connection and reveal collapsed, hidden, filtered descendants', () => {
  const tabs: TabState[] = ['other', 'owner'].map((id) => ({
    id,
    connectionId: id,
    rootKey: 'A-1',
    selectedKey: 'A-1',
    focusKey: 'A-3',
    expanded: [],
    hideDone: true,
    filters: { status: 'missing' },
    scrollTop: 99,
  }));
  const snapshot: TreeSnapshot = {
    rootKey: 'A-1',
    issues: [
      issue('A-1'),
      issue('A-2', {
        parentKey: 'A-1',
        status: { id: 'done', name: 'Done', category: 'done' },
      }),
      issue('A-3', { parentKey: 'A-1' }),
    ],
    warnings: [],
    fetchedAt: 1,
  };
  const destination = relationshipDestination(
    'owner',
    'A-2',
    tabs,
    { other: snapshot, owner: snapshot },
    'other',
  );
  assert.equal(destination?.id, 'owner');
  assert.equal(destination?.selectedKey, 'A-2');
  assert.equal(destination?.focusKey, undefined);
  const visible = filterTree(
    buildIssueTree(snapshot.issues, snapshot.rootKey),
    'no match',
    destination!.filters!,
    true,
    undefined,
    destination!.selectedKey,
  );
  assert.ok(
    flattenVisible(visible, new Set(destination!.expanded)).some(
      (row) => row.issue.key === 'A-2',
    ),
  );
  assert.equal(
    relationshipDestination('unknown-account', 'A-2', tabs, {
      owner: snapshot,
    }),
    null,
  );
  assert.equal(
    relationshipDestination('owner', 'OUT-1', tabs, { owner: snapshot }),
    null,
  );
});

test('actual relationship UI exposes identity, direction, incomplete and outside-selection states', () => {
  const html = renderToStaticMarkup(
    React.createElement(RelationshipGroups, {
      graph: graph('partial', [
        blocker,
        {
          ...blocker,
          key: 'private/repo#1',
          access: 'outside-connection',
          crossRepository: true,
        },
      ]),
      identity: 'GitHub · Work account',
      onPreview() {},
      onJump() {},
    }),
  );
  assert.match(html, /GitHub · Work account/);
  assert.match(html, /Incoming/);
  assert.match(html, /Blockers · partial/);
  assert.match(html, /Cross-repository/);
  assert.match(html, /Outside this connection/);
  assert.doesNotMatch(html, /Show private\/repo#1 in tree/);
  assert.match(html, /inaccessible issues may be omitted/);
});

test('sample provider supplies hierarchy and true link context without network', async () => {
  const result = await new DemoProvider().relationships('CAN-108');
  assert.ok(result.groups.every((group) => group.state === 'visible'));
  assert.ok(
    result.groups.find((group) => group.kind === 'parent')?.items.length,
  );
});

test('fresh relationship status takes precedence over an older owning tree', () => {
  const known = new Map([
    [
      blocker.key,
      issue(blocker.key, {
        status: { id: 'done', name: 'Done', category: 'done' },
      }),
    ],
  ]);
  assert.equal(
    relationshipBlockers(issue('team/a#1'), graph('visible', [blocker]), known)
      .blocker,
    'blocked',
  );
});

test('GitHub related pagination is bounded and parent identity is preserved', async () => {
  let relatedCalls = 0;
  const result = await new GithubProvider(connection, async (path, init) => {
    if (path !== '/graphql') return githubRequest(path, init);
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('parent{'))
      return {
        data: {
          repository: {
            issue: {
              parent: {
                url: 'https://github.com/team/b/issues/99',
                title: 'Parent',
                state: 'OPEN',
              },
            },
          },
        },
      };
    relatedCalls++;
    assert.equal(body.variables.after, relatedCalls === 1 ? null : 'cursor1');
    return {
      data: {
        repository: {
          issue: {
            relatesTo: {
              nodes: [
                {
                  url: 'https://github.com/team/b/issues/3',
                  title: 'Related',
                  state: 'CLOSED',
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: `cursor${relatedCalls}`,
              },
            },
          },
        },
      },
    };
  }).relationships('team/a#1');
  assert.equal(relatedCalls, 2);
  assert.equal(result.groups[2].state, 'partial');
  assert.equal(result.groups[2].items.length, 2);
  assert.equal(result.groups[3].items[0].key, 'team/b#99');
  assert.equal(result.groups[3].items[0].direction, 'inward');
  assert.equal(result.groups[3].items[0].crossRepository, true);
});

test('Jira bounded hierarchy retains children when the next page fails', async () => {
  let pages = 0;
  const result = await new JiraProvider(async (path, init) => {
    if (path.includes('/issue/'))
      return { key: 'A-1', fields: { issuelinks: [], parent: null } };
    const body = JSON.parse(String(init?.body));
    pages++;
    if (pages === 2) {
      assert.equal(body.nextPageToken, 'next');
      throw new Error('Jira 403 private payload');
    }
    return {
      isLast: false,
      nextPageToken: 'next',
      issues: [{ key: 'A-2', fields: { summary: 'Known child' } }],
    };
  }).relationships('A-1');
  assert.equal(pages, 2);
  assert.equal(result.groups[3].state, 'visible');
  assert.equal(result.groups[3].items.length, 0);
  assert.equal(result.groups[4].state, 'partial');
  assert.equal(result.groups[4].items[0].key, 'A-2');
  assert.equal(result.groups[4].problem, 'inaccessible');
  assert.doesNotMatch(JSON.stringify(result), /private payload/);
});

test('GitHub preview leaves relationship requests lazy', async () => {
  const paths: string[] = [];
  const preview = await new GithubProvider(connection, async (path) => {
    paths.push(path);
    return path.includes('/comments')
      ? []
      : { ...raw('team/a', 1), comments: 0, labels: [] };
  }).preview('team/a#1');
  assert.equal(paths.length, 2);
  assert.ok(
    paths.every((path) => !/dependencies|graphql|sub_issues/.test(path)),
  );
  assert.equal(preview.issue.linksAvailable, false);
  assert.equal(relationshipBlockers(preview.issue).blocker, 'unknown');
});

test('Jira incomplete target status stays unknown in Next tasks despite a status object', async () => {
  const provider = new JiraProvider(async (path) =>
    path.includes('/issue/')
      ? { key: 'A-1', fields: { status: {}, issuelinks: [], parent: null } }
      : { isLast: true, issues: [] },
  );
  const target = (await provider.preview('A-1')).issue;
  assert.ok(target.unavailableFields?.includes('status'));
  const result = relationshipBlockers(
    issue('A-2'),
    {
      key: 'A-2',
      groups: [
        {
          kind: 'blockers',
          state: 'visible',
          items: [{ ...blocker, key: 'A-1', statusCategory: undefined }],
        },
      ],
    },
    new Map([['A-1', target]]),
  );
  assert.equal(result.blocker, 'unknown');
  assert.equal(result.blockerDetails[0].statusCategory, undefined);
});

test('Next tasks consumes inspected GitHub blockers and preserves unknown tasks before blocked tasks', () => {
  const snapshot: TreeSnapshot = {
    rootKey: 'team/a#1',
    issues: [
      issue('team/a#1'),
      issue('team/a#2', {
        parentKey: 'team/a#1',
        labels: [{ id: 'blocked', name: 'blocked' }],
      }),
      issue('team/a#3', { parentKey: 'team/a#1' }),
    ],
    fetchedAt: 1,
    warnings: [],
  };
  const tasks = nextTasks(
    snapshot,
    'github',
    'blocked',
    undefined,
    false,
    undefined,
    {
      'team/a#1': graph('visible'),
      'team/a#3': {
        key: 'team/a#3',
        groups: [{ kind: 'blockers', state: 'partial', items: [blocker] }],
      },
    },
  );
  assert.deepEqual(
    tasks.map((task) => [task.issue.key, task.blocker]),
    [
      ['team/a#1', 'clear'],
      ['team/a#2', 'unknown'],
      ['team/a#3', 'blocked'],
    ],
  );
  assert.equal(tasks[2].blockerDetails[0].summary, 'Actual blocker');
  assert.equal(tasks[2].incomplete, true);
});
