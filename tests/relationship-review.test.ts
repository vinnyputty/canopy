import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { nextTasks } from '../src/renderer/next-tasks';
import { JiraProvider } from '../src/main/jira';
import { GithubProvider } from '../src/main/github';
import { relationshipBlockers } from '../src/renderer/relationships';
import { issueWorkBrief } from '../src/renderer/copy-issue';
import type { Issue, IssueRelationships } from '../src/shared/types';

const issue = (
  key: string,
  category: Issue['status']['category'] = 'new',
): Issue => ({
  id: key,
  key,
  summary: key,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: category, name: category, category },
  links: [],
});
const jira = (fields: Record<string, unknown>) =>
  new JiraProvider(async (path) =>
    path.includes('/issue/')
      ? { key: 'A-1', fields }
      : { isLast: true, issues: [] },
  );
const depends = {
  name: 'Depends',
  outward: 'depends on',
  inward: 'is depended on by',
};

test('held cancellation evaluate passes Electron namespace first and held request second', async () => {
  const source = readFileSync(
    new URL('../tools/smoke-relationships.mjs', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'audit.mjs',
    source,
    ts.ScriptTarget.Latest,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'app.evaluate' &&
      node.arguments[1]?.getText(parsed) === 'held'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(calls.length, 1);
  const held = {
    call: { connection: 'work', key: 'team/a#1', requestId: 'held-request' },
    cancelledBefore: 1,
  };
  const exact = { connection: 'work', requestId: 'held-request' };
  const context = {
    held,
    relationshipAudit: { cancelled: [exact] },
    app: {
      // ElectronApplication.evaluate invokes the callback with the Electron
      // namespace first, followed by the supplied argument. Execute the actual
      // call expression so both callback parameters and payload wiring matter.
      evaluate: async (
        callback: (electron: object, arg: typeof held) => boolean,
        arg: typeof held,
      ) => callback({ ipcMain: {} }, structuredClone(arg)),
    },
  };
  const evaluate = () => runInNewContext(calls[0].getText(parsed), context);
  assert.equal(await evaluate(), false, 'earlier exact cancel is excluded');
  context.relationshipAudit.cancelled.push({ ...exact, connection: 'other' });
  assert.equal(
    await evaluate(),
    false,
    'new cancel on another account is excluded',
  );
  context.relationshipAudit.cancelled.push({
    ...exact,
    requestId: 'other-request',
  });
  assert.equal(
    await evaluate(),
    false,
    'new cancel for another request is excluded',
  );
  context.relationshipAudit.cancelled.push(exact);
  assert.equal(
    await evaluate(),
    true,
    'new exact held-request cancel is accepted',
  );
});

test('documented Jira Depends end directions populate blockers and blocked issues', async () => {
  const graph = await jira({
    parent: null,
    issuelinks: [
      {
        type: depends,
        outwardIssue: {
          key: 'B-2',
          fields: {
            summary: 'Required work',
            status: { statusCategory: { key: 'new' } },
          },
        },
      },
      {
        type: depends,
        inwardIssue: {
          key: 'B-3',
          fields: {
            summary: 'Waiting work',
            status: { statusCategory: { key: 'done' } },
          },
        },
      },
    ],
  }).relationships('A-1');
  assert.deepEqual(
    graph.groups[0].items.map((link) => [
      link.key,
      link.relationship,
      link.direction,
    ]),
    [['B-2', 'depends on', 'outward']],
  );
  assert.deepEqual(
    graph.groups[1].items.map((link) => [
      link.key,
      link.relationship,
      link.direction,
    ]),
    [['B-3', 'is depended on by', 'inward']],
  );
  assert.equal(relationshipBlockers(issue('A-1'), graph).blocker, 'blocked');
  assert.equal(graph.groups[2].items.length, 0);
});

test('uninterpreted Jira custom relationships keep dependency state unknown and preserve wording', async () => {
  const graph = await jira({
    parent: null,
    issuelinks: [
      {
        type: {
          name: 'Custom dependency',
          outward: 'requires approval from',
          inward: 'is required for',
        },
        outwardIssue: {
          key: 'B-2',
          fields: {
            summary: 'Possible dependency',
            status: { statusCategory: { key: 'done' } },
          },
        },
      },
    ],
  }).relationships('A-1');
  const state = relationshipBlockers(issue('A-1'), graph);
  assert.equal(state.blocker, 'unknown');
  assert.equal(state.incomplete, true);
  assert.equal(graph.groups[0].state, 'partial');
  assert.equal(graph.groups[2].items[0].relationship, 'requires approval from');
  assert.equal(graph.groups[2].items[0].direction, 'outward');
});

test('fresh missing GitHub blocker status cannot inherit stale completed tree status', async () => {
  const provider = new GithubProvider(
    {
      id: 'gh',
      provider: 'github',
      name: 'Mock',
      url: 'https://github.com',
      repositories: ['team/a'],
    },
    async (path, init) => {
      if (path.includes('blocked_by'))
        return [
          {
            html_url: 'https://github.com/team/a/issues/2',
            title: 'Required work',
          },
        ];
      if (path === '/graphql')
        return {
          data: {
            repository: {
              issue: JSON.parse(String(init?.body)).query.includes('relatesTo')
                ? {
                    relatesTo: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  }
                : { parent: null },
            },
          },
        };
      return [];
    },
  );
  const graph = await provider.relationships('team/a#1');
  const state = relationshipBlockers(
    issue('team/a#1'),
    graph,
    new Map([['team/a#2', issue('team/a#2', 'done')]]),
  );
  assert.equal(state.blocker, 'unknown');
  assert.equal(state.incomplete, true);
  assert.equal(state.blockerDetails[0].key, 'team/a#2');
  assert.equal(state.blockerDetails[0].statusCategory, undefined);
  // Snapshot-only Jira links may still use another row in the same tree.
  assert.equal(
    relationshipBlockers(
      {
        ...issue('A-1'),
        linksAvailable: true,
        links: [
          { key: 'A-2', summary: 'Blocker', relationship: 'is blocked by' },
        ],
      },
      undefined,
      new Map([['A-2', issue('A-2')]]),
    ).blocker,
    'blocked',
  );
});

test('incomplete Jira parent object is unavailable while explicit null is visibly empty', async () => {
  for (const parent of [{ id: '10001' }, {}, { key: '' }, undefined]) {
    const graph = await jira({ parent, issuelinks: [] }).relationships('A-1');
    const group = graph.groups.find((value) => value.kind === 'parent')!;
    assert.equal(group.state, 'unavailable');
    assert.match(group.reason!, /unknown/i);
    assert.equal(group.items.length, 0);
  }
  const absent = (
    await jira({ parent: null, issuelinks: [] }).relationships('A-1')
  ).groups.find((value) => value.kind === 'parent')!;
  assert.equal(absent.state, 'visible');
  assert.equal(absent.items.length, 0);
  const known = (
    await jira({
      parent: { id: '10001', key: 'P-1' },
      issuelinks: [],
    }).relationships('A-1')
  ).groups.find((value) => value.kind === 'parent')!;
  assert.equal(known.state, 'visible');
  assert.equal(known.items[0].key, 'P-1');
});

test('lazy GitHub preview exports uninspected dependencies honestly', async () => {
  const preview = await new GithubProvider(
    {
      id: 'gh',
      provider: 'github',
      name: 'Mock',
      url: 'https://github.com',
      repositories: ['team/a'],
    },
    async (path) =>
      path.includes('/comments')
        ? []
        : {
            html_url: 'https://github.com/team/a/issues/1',
            title: 'Task',
            state: 'open',
            comments: 0,
            labels: [],
          },
  ).preview('team/a#1');
  const brief = issueWorkBrief({
    preview,
    provider: 'github',
    sourceUrl: 'https://github.com/team/a/issues/1',
    knownIssues: [],
  });
  assert.doesNotMatch(brief, /## Dependency links\n\nNone/);
  assert.match(brief, /Uninspected/);
});

// The fourth finding also requires typed results to reach the export consumer.
test('work brief retains inspected typed direction and partial/access states without private error details', () => {
  const relationships: IssueRelationships = {
    key: 'team/a#1',
    groups: [
      {
        kind: 'blockers',
        state: 'partial',
        reason: 'secret private transport',
        items: [
          {
            key: 'team/b#2',
            summary: 'Required work',
            relationship: 'blocked by',
            direction: 'inward',
            access: 'outside-connection',
            crossRepository: true,
          },
        ],
      },
      { kind: 'related', state: 'visible', items: [] },
      {
        kind: 'parent',
        state: 'unavailable',
        reason: 'secret private parent',
        items: [],
      },
    ],
  };
  const brief = issueWorkBrief({
    preview: {
      issue: issue('team/a#1'),
      description: '',
      comments: [],
      totalComments: 0,
    },
    provider: 'github',
    knownIssues: [],
    relationships,
  });
  assert.match(brief, /Required work/);
  assert.match(brief, /Incoming/);
  assert.match(brief, /Status unknown/);
  assert.match(brief, /Cross-repository/);
  assert.match(brief, /Outside selected repositories/);
  assert.match(brief, /Partial/);
  assert.match(brief, /- Parent path: Unknown/);
  assert.match(brief, /No visible related links returned/);
  assert.doesNotMatch(brief, /secret|private transport|private parent/);
});

test('snapshot-only Depends and custom links have the same blocker semantics', async () => {
  const payloads = [
    {
      type: depends,
      outwardIssue: {
        key: 'B-2',
        fields: {
          summary: 'Required',
          status: { statusCategory: { key: 'new' } },
        },
      },
    },
    {
      type: { outward: 'needs a decision from', inward: 'decides for' },
      inwardIssue: { key: 'B-3' },
    },
  ];
  const preview = await jira({
    issuelinks: payloads,
    parent: { id: '10001' },
  }).preview('A-1');
  const state = relationshipBlockers(preview.issue);
  assert.equal(state.blocker, 'blocked');
  assert.equal(state.incomplete, true);
  assert.deepEqual(state.blockers, ['B-2']);
  assert.ok(preview.issue.unavailableFields?.includes('parent'));
  assert.match(
    issueWorkBrief({ preview, provider: 'jira', knownIssues: [] }),
    /- Parent path: Unknown/,
  );
  const uncertain = await jira({
    issuelinks: [payloads[1]],
    parent: null,
  }).preview('A-1');
  assert.equal(relationshipBlockers(uncertain.issue).blocker, 'unknown');
});

test('a visible typed empty graph exports visible results rather than unknown or global absence', () => {
  const relationships: IssueRelationships = {
    key: 'team/a#1',
    groups: ['blockers', 'blocked', 'related', 'parent', 'children'].map(
      (kind) => ({
        kind: kind as IssueRelationships['groups'][number]['kind'],
        state: 'visible',
        items: [],
      }),
    ),
  };
  const brief = issueWorkBrief({
    preview: {
      issue: issue('team/a#1'),
      description: '',
      comments: [],
      totalComments: 0,
    },
    provider: 'github',
    knownIssues: [],
    relationships,
  });
  assert.match(brief, /No visible blockers returned/);
  assert.match(brief, /No visible parent returned/);
  assert.match(brief, /inaccessible issues may be omitted/);
  assert.doesNotMatch(brief, /Uninspected|Dependency links\n\nNone/);
  const otherIssue = issueWorkBrief({
    preview: {
      issue: issue('team/a#99'),
      description: '',
      comments: [],
      totalComments: 0,
    },
    provider: 'github',
    knownIssues: [],
    relationships,
  });
  assert.match(otherIssue, /Uninspected/);
  assert.doesNotMatch(otherIssue, /No visible blockers returned/);
});

for (const [name, parent] of [
  ['omitted', undefined],
  ['id-only', { id: '10001' }],
  ['invalid key', { key: 'invalid' }],
  ['explicit null', null],
] as const) {
  test(`fresh Jira ${name} parent overrides the stale snapshot in an uninspected brief`, async () => {
    const preview = await jira({ parent, issuelinks: [] }).preview('A-1');
    const brief = issueWorkBrief({
      preview,
      provider: 'jira',
      knownIssues: [{ ...issue('A-1'), parentKey: 'OLD-1' }, issue('OLD-1')],
    });
    assert.match(
      brief,
      parent === null ? /- Parent path: None/ : /- Parent path: Unknown/,
    );
    assert.doesNotMatch(brief, /OLD-1|→ invalid/);
  });
}

test('a usable fresh Jira parent keeps snapshot ancestors, while snapshot-only export retains its parent', async () => {
  const knownIssues = [
    { ...issue('A-1'), parentKey: 'OLD-1' },
    issue('OLD-1'),
    { ...issue('NEW-1'), parentKey: 'ROOT-1' },
    issue('ROOT-1'),
  ];
  const preview = await jira({
    parent: { key: 'NEW-1' },
    issuelinks: [],
  }).preview('A-1');
  assert.match(
    issueWorkBrief({ preview, provider: 'jira', knownIssues }),
    /- Parent path: ROOT-1 → NEW-1/,
  );
  assert.match(
    issueWorkBrief({ issueKey: 'A-1', provider: 'jira', knownIssues }),
    /- Parent path: OLD-1/,
  );
});

test('desktop missing-status fixture exercises the same-snapshot completed blocker fallback', async () => {
  // Execute only the actual IPC fixture installer, without importing Playwright
  // or starting the desktop audit. Keep the owning/account fixtures intact.
  const source = readFileSync(
    new URL('../tools/smoke-relationships.mjs', import.meta.url),
    'utf8',
  );
  const start =
    source.indexOf('await app.evaluate(') + 'await app.evaluate('.length;
  const end = source.indexOf('\n  });\n  try', start) + '\n  }'.length;
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  const context = {
    ipcMain: {
      _invokeHandlers: handlers,
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    },
    relationshipAudit: undefined as unknown as {
      includeCompletedBlocker: boolean;
      mode: string;
    },
  };
  runInNewContext(`(${source.slice(start, end)})({ ipcMain })`, context);
  const tree = handlers.get('canopy:tree');
  const original = tree(null, 'work', 'team/a#1');
  assert.equal(original.issues.length, 1);
  const workspace = handlers.get('canopy:loadWorkspace')();
  assert.equal(
    workspace.tabs.find((tab: { id: string }) => tab.id === 'owner')
      .connectionId,
    'work',
  );
  assert.equal(
    workspace.tabs.find((tab: { id: string }) => tab.id === 'wrong')
      .connectionId,
    'other',
  );
  assert.equal(
    tree(null, 'work', 'team/a#10').issues.find(
      (row: Issue) => row.key === 'team/a#11',
    ).status.category,
    'done',
  );
  context.relationshipAudit.includeCompletedBlocker = true;
  context.relationshipAudit.mode = 'missing-status';
  const snapshot = tree(null, 'work', 'team/a#1');
  assert.equal(snapshot.rootKey, 'team/a#1');
  const staleTarget = snapshot.issues.find(
    (row: Issue) => row.key === 'team/a#11',
  );
  assert.equal(staleTarget.parentKey, 'team/a#1');
  assert.equal(staleTarget.status.category, 'done');
  const graph = await handlers.get('canopy:relationships')(
    null,
    'work',
    'team/a#1',
    'audit-request',
  );
  const tasks = nextTasks(
    snapshot,
    'github',
    'blocked',
    undefined,
    false,
    undefined,
    { 'team/a#1': graph },
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].issue.key, 'team/a#1');
  assert.equal(tasks[0].blocker, 'unknown');
  assert.equal(tasks[0].incomplete, true);
  assert.equal(tasks[0].blockerDetails[0].key, 'team/a#11');
  assert.equal(tasks[0].blockerDetails[0].statusCategory, undefined);
});
