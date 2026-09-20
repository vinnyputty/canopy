import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JiraProvider, type JiraRequest } from '../src/main/jira';

function rawIssue(
  key: string,
  parentKey?: string,
  extra: Record<string, any> = {},
): any {
  return {
    id: key.replace(/\D/g, '') || key,
    key,
    fields: {
      summary: `${key} summary`,
      issuetype: { name: parentKey ? 'Task' : 'Epic' },
      ...(parentKey ? { parent: { key: parentKey } } : {}),
      priority: { id: '2', name: 'High' },
      assignee: { accountId: 'account-1', displayName: 'Ada' },
      status: {
        id: '10',
        name: 'In progress',
        statusCategory: { key: 'indeterminate' },
      },
      issuelinks: [],
      ...extra,
    },
  };
}

function body(init?: RequestInit): any {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

function recordingRequest(
  handler: (path: string, init?: RequestInit) => Promise<any> | any,
): JiraRequest & { calls: [string, RequestInit | undefined][] } {
  const calls: [string, RequestInit | undefined][] = [];
  const request = async (path: string, init?: RequestInit): Promise<any> => {
    calls.push([path, init]);
    return handler(path, init);
  };
  return Object.assign(request, { calls });
}

describe('JiraProvider tree', () => {
  it('walks every hierarchy level and every enhanced-search page without following issue links', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/EPIC-1?')) {
        return rawIssue('EPIC-1', undefined, {
          issuelinks: [
            { type: { outward: 'blocks' }, outwardIssue: rawIssue('LINK-9') },
          ],
        });
      }
      const requestBody = body(init);
      if (
        requestBody.jql === 'parent in ("EPIC-1") ORDER BY Rank ASC' &&
        !requestBody.nextPageToken
      ) {
        return {
          issues: [rawIssue('STORY-1', 'EPIC-1')],
          nextPageToken: 'page-2',
          isLast: false,
        };
      }
      if (requestBody.nextPageToken === 'page-2') {
        return { issues: [rawIssue('STORY-2', 'EPIC-1')], isLast: true };
      }
      if (
        requestBody.jql === 'parent in ("STORY-1", "STORY-2") ORDER BY Rank ASC'
      ) {
        return { issues: [rawIssue('TASK-1', 'STORY-1')], isLast: true };
      }
      if (requestBody.jql === 'parent in ("TASK-1") ORDER BY Rank ASC') {
        return { issues: [rawIssue('SUB-1', 'TASK-1')], isLast: true };
      }
      if (requestBody.jql === 'parent in ("SUB-1") ORDER BY Rank ASC')
        return { issues: [], isLast: true };
      throw new Error(
        `Unexpected request: ${path} ${JSON.stringify(requestBody)}`,
      );
    });

    const snapshot = await new JiraProvider(request).tree(' EPIC-1 ');

    assert.equal(snapshot.rootKey, 'EPIC-1');
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.key),
      ['EPIC-1', 'STORY-1', 'STORY-2', 'TASK-1', 'SUB-1'],
    );
    assert.deepEqual(snapshot.issues[0].links, [
      { key: 'LINK-9', summary: 'LINK-9 summary', relationship: 'blocks' },
    ]);
    assert.equal(
      request.calls.some(([path]) => path.includes('LINK-9')),
      false,
    );
    assert.equal(
      request.calls.filter(([path]) => path === '/rest/api/3/search/jql')
        .length,
      5,
    );
  });

  it('reports duplicate or cyclic children and terminates safely', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      const jql = body(init).jql;
      if (jql.includes('"ROOT-1"'))
        return { issues: [rawIssue('CHILD-1', 'ROOT-1')], isLast: true };
      return { issues: [rawIssue('ROOT-1', 'CHILD-1')], isLast: true };
    });

    const snapshot = await new JiraProvider(request).tree('ROOT-1');
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.key),
      ['ROOT-1', 'CHILD-1'],
    );
    assert.deepEqual(snapshot.warnings, [
      'Ignored duplicate or cyclic child ROOT-1.',
    ]);
  });

  it('falls back to key order when Jira explicitly reports that Rank is unavailable', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      const jql = body(init).jql;
      if (jql.endsWith('ORDER BY Rank ASC')) {
        throw new Error(
          "Field 'Rank' does not exist or you do not have permission to view it.",
        );
      }
      assert.equal(jql, 'parent in ("ROOT-1") ORDER BY key ASC');
      return { issues: [], isLast: true };
    });

    const snapshot = await new JiraProvider(request).tree('ROOT-1');
    assert.deepEqual(snapshot.warnings, [
      'Rank ordering is unavailable for this Jira site; children are ordered by issue key.',
    ]);
    assert.equal(snapshot.ranking?.state, 'unsupported');
    assert.deepEqual(snapshot.ranking?.issueKeys, []);
    assert.equal(request.calls.length, 3);
  });

  it('does not treat unrelated search errors as a missing Rank field', async () => {
    const request = recordingRequest((path) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      throw new Error('Jira denied access to search.');
    });

    await assert.rejects(
      new JiraProvider(request).tree('ROOT-1'),
      /denied access/,
    );
    assert.equal(request.calls.length, 2);
  });

  it('fails clearly for inaccessible roots and malformed pagination', async () => {
    const inaccessible = new JiraProvider(async () => {
      throw new Error('404');
    });
    await assert.rejects(
      inaccessible.tree('SECRET-1'),
      /may not exist or you may not have access/,
    );

    const truncated = new JiraProvider(async (path) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      return { issues: [], isLast: false };
    });
    await assert.rejects(truncated.tree('ROOT-1'), /supplied no page token/);
  });
});

describe('JiraProvider search and editing', () => {
  it('escapes user input and returns each page on demand', async () => {
    const request = recordingRequest((_path, init) => {
      const requestBody = body(init);
      if (!requestBody.nextPageToken)
        return {
          issues: [rawIssue('ONE-1')],
          nextPageToken: 'next',
          isLast: false,
        };
      return { issues: [rawIssue('TWO-2')], isLast: true };
    });

    const result = await new JiraProvider(request).search('a"b\\c+');
    assert.deepEqual(
      result.issues.map((issue) => issue.key),
      ['ONE-1'],
    );
    assert.equal(
      body(request.calls[0][1]).jql,
      'summary ~ "a\\"b\\\\\\\\c\\\\+" ORDER BY updated DESC, key ASC',
    );
    assert.equal(request.calls.length, 1);
    assert.equal(result.nextPageToken, 'next');
    assert.equal(body(request.calls[0][1]).maxResults, 25);
    const second = await new JiraProvider(request).search(
      'a\"b\\c+',
      result.nextPageToken,
    );
    assert.deepEqual(
      second.issues.map((issue) => issue.key),
      ['TWO-2'],
    );
    assert.equal(body(request.calls[1][1]).nextPageToken, 'next');
  });

  it('adds exact-key matching only for issue-key-shaped searches', async () => {
    const request = recordingRequest(() => ({ issues: [], isLast: true }));
    await new JiraProvider(request).search('ABC-123');
    const jql = body(request.calls[0][1]).jql;
    assert.ok(jql.startsWith('(key = "ABC-123" OR (summary ~ '));
    assert.ok(jql.includes('123*"'));
  });

  it('adds only a generated suffix wildcard and forwards request cancellation', async () => {
    const controller = new AbortController();
    const request = recordingRequest(() => ({ issues: [], isLast: true }));
    await new JiraProvider(request).search(
      'platf',
      undefined,
      controller.signal,
    );
    assert.equal(
      body(request.calls[0][1]).jql,
      '(summary ~ "platf" OR summary ~ "platf*") ORDER BY updated DESC, key ASC',
    );
    assert.equal(request.calls[0][1]?.signal, controller.signal);
    controller.abort();
    await assert.rejects(
      new JiraProvider(request).search(
        'platform',
        undefined,
        controller.signal,
      ),
      /abort/i,
    );
    assert.equal(request.calls.length, 1);
    await new JiraProvider(request).search('plat*');
    assert.equal(body(request.calls[1][1]).jql.includes(' OR '), false);
    assert.equal(body(request.calls[1][1]).jql.includes('\\\\*'), true);
  });

  it('reports malformed and repeated pagination instead of dropping matches', async () => {
    for (const page of [
      { issues: [], isLast: false },
      { issues: [], nextPageToken: 'same' },
      { unexpected: [] },
    ]) {
      const provider = new JiraProvider(async () => page);
      await assert.rejects(
        provider.search('query', 'same'),
        /page token|invalid response/,
      );
    }
  });

  it('loads independent priorities, assignable users, and transition requirements', async () => {
    const request = recordingRequest((path) => {
      if (path.endsWith('/editmeta')) {
        return {
          fields: {
            priority: { allowedValues: [{ id: '1', name: 'Highest' }] },
          },
        };
      }
      if (path.includes('/user/assignable/search')) {
        assert.match(path, /issueKey=ABC-1&query=ad%20a/);
        return [{ accountId: 'user-1', displayName: 'Ada' }];
      }
      if (path.includes('/transitions?')) {
        return {
          transitions: [
            {
              id: '2',
              name: 'Start',
              fields: {},
              to: {
                id: '10',
                name: 'In progress',
                statusCategory: { key: 'indeterminate' },
              },
            },
            {
              id: '3',
              name: 'Resolve',
              fields: { resolution: { required: true } },
            },
          ],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const provider = new JiraProvider(request);
    assert.deepEqual(
      {
        priorities: await provider.priorities('ABC-1'),
        assignees: (await provider.assignees('ABC-1', 'ad a')).users,
        transitions: await provider.transitions('ABC-1'),
      },
      {
        priorities: [{ id: '1', name: 'Highest' }],
        assignees: [{ id: 'user-1', name: 'Ada' }],
        transitions: [
          {
            id: '2',
            name: 'Start',
            requiresFields: false,
            to: { id: '10', name: 'In progress', category: 'indeterminate' },
          },
          { id: '3', name: 'Resolve', requiresFields: true },
        ],
      },
    );
  });

  it('updates fields, performs a supported transition, and returns the refreshed issue', async () => {
    const request = recordingRequest((path, init) => {
      if (path.includes('/transitions?'))
        return { transitions: [{ id: '3', name: 'Done', fields: {} }] };
      if (init?.method === 'PUT') {
        assert.deepEqual(body(init), {
          fields: {
            summary: 'New summary',
            priority: { id: '1' },
            assignee: null,
          },
        });
        return {};
      }
      if (init?.method === 'POST') {
        assert.deepEqual(body(init), { transition: { id: '3' } });
        return {};
      }
      return rawIssue('ABC-1', undefined, { summary: 'New summary' });
    });

    const issue = await new JiraProvider(request).update('ABC-1', {
      summary: 'New summary',
      priorityId: '1',
      assigneeId: null,
      transitionId: '3',
    });
    assert.equal(issue.summary, 'New summary');
    assert.deepEqual(
      request.calls.slice(0, 3).map(([path]) => path),
      [
        '/rest/api/3/issue/ABC-1/transitions?expand=transitions.fields',
        '/rest/api/3/issue/ABC-1?returnIssue=true',
        '/rest/api/3/issue/ABC-1/transitions',
      ],
    );
    assert.match(request.calls[3][0], /^\/rest\/api\/3\/issue\/ABC-1\?fields=/);
  });

  it('rejects transitions with required fields before applying another edit', async () => {
    const request = recordingRequest(() => ({
      transitions: [
        {
          id: '3',
          name: 'Resolve',
          fields: { resolution: { name: 'Resolution', required: true } },
        },
      ],
    }));

    await assert.rejects(
      new JiraProvider(request).update('ABC-1', {
        summary: 'Must not save',
        transitionId: '3',
      }),
      /requires fields Canopy cannot edit: Resolution/,
    );
    assert.equal(request.calls.length, 1);
  });
});

describe('JiraProvider ranking', () => {
  it('ranks one sibling immediately before another', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/ONE-1?'))
        return rawIssue('ONE-1', 'PARENT-1');
      if (path.startsWith('/rest/api/3/issue/TWO-2?'))
        return rawIssue('TWO-2', 'PARENT-1');
      assert.equal(path, '/rest/agile/1.0/issue/rank');
      assert.equal(init?.method, 'PUT');
      assert.deepEqual(body(init), {
        issues: ['ONE-1'],
        rankBeforeIssue: 'TWO-2',
      });
      return {};
    });

    await new JiraProvider(request).rank('ONE-1', 'TWO-2');
    assert.equal(request.calls.length, 3);
  });

  it('restores a sibling after its former predecessor', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/ONE-1?'))
        return rawIssue('ONE-1', 'PARENT-1');
      if (path.startsWith('/rest/api/3/issue/TWO-2?'))
        return rawIssue('TWO-2', 'PARENT-1');
      assert.deepEqual(body(init), {
        issues: ['ONE-1'],
        rankAfterIssue: 'TWO-2',
      });
      return {};
    });
    await new JiraProvider(request).rank('ONE-1', 'TWO-2', 'after');
  });

  it('surfaces partial failures returned by Jira ranking', async () => {
    const request = recordingRequest((path) => {
      if (path.startsWith('/rest/api/3/issue/ONE-1?'))
        return rawIssue('ONE-1', 'PARENT-1');
      if (path.startsWith('/rest/api/3/issue/TWO-2?'))
        return rawIssue('TWO-2', 'PARENT-1');
      return {
        entries: [
          {
            issueKey: 'ONE-1',
            status: 503,
            errors: ['Ranking is temporarily unavailable.'],
          },
        ],
      };
    });

    await assert.rejects(
      new JiraProvider(request).rank('ONE-1', 'TWO-2'),
      /could not rank ONE-1.*temporarily unavailable/,
    );
  });

  it('rejects roots and cross-parent moves without calling rank', async () => {
    const rootRequest = recordingRequest((path) =>
      path.includes('ROOT-1')
        ? rawIssue('ROOT-1')
        : rawIssue('CHILD-1', 'ROOT-1'),
    );
    await assert.rejects(
      new JiraProvider(rootRequest).rank('ROOT-1', 'CHILD-1'),
      /Root issue ROOT-1/,
    );
    assert.equal(rootRequest.calls.length, 2);

    const siblingRequest = recordingRequest((path) =>
      path.includes('ONE-1')
        ? rawIssue('ONE-1', 'PARENT-1')
        : rawIssue('TWO-2', 'PARENT-2'),
    );
    await assert.rejects(
      new JiraProvider(siblingRequest).rank('ONE-1', 'TWO-2'),
      /must have the same parent/,
    );
    assert.equal(siblingRequest.calls.length, 2);
  });
});

describe('Jira table capabilities', () => {
  it('checks issue-specific ranking permissions without assuming a project type', async () => {
    const request = recordingRequest((path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      if (path === '/rest/api/3/permissions/check') {
        assert.deepEqual(body(init).projectPermissions, [
          { issues: [2, 3], permissions: ['SCHEDULE_ISSUES', 'EDIT_ISSUES'] },
        ]);
        return {
          projectPermissions: [
            { permission: 'SCHEDULE_ISSUES', issues: [2, 3] },
            { permission: 'EDIT_ISSUES', issues: [2] },
          ],
        };
      }
      return {
        issues: body(init).jql.includes('"ROOT-1"')
          ? [rawIssue('CHILD-2', 'ROOT-1'), rawIssue('CHILD-3', 'ROOT-1')]
          : [],
        isLast: true,
      };
    });
    const snapshot = await new JiraProvider(request).tree('ROOT-1');
    assert.deepEqual(snapshot.ranking, {
      state: 'supported',
      issueKeys: ['CHILD-2'],
    });
  });
  it('marks denied ranking permissions unsupported and excludes every issue', async () => {
    const provider = new JiraProvider(async (path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      if (path === '/rest/api/3/permissions/check')
        return { projectPermissions: [] };
      return {
        issues: body(init).jql.includes('"ROOT-1"')
          ? [rawIssue('CHILD-2', 'ROOT-1')]
          : [],
        isLast: true,
      };
    });
    const snapshot = await provider.tree('ROOT-1');
    assert.equal(snapshot.ranking?.state, 'unsupported');
    assert.match(snapshot.ranking!.reason!, /Schedule issues and Edit issues/);
    assert.deepEqual(snapshot.ranking?.issueKeys, []);
  });
  it('batches ranking permission checks at the API limit without losing the last issues', async () => {
    const sizes: number[] = [];
    const provider = new JiraProvider(async (path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      const request = body(init);
      if (path === '/rest/api/3/permissions/check') {
        const ids = request.projectPermissions[0].issues;
        sizes.push(ids.length);
        return {
          projectPermissions: ['SCHEDULE_ISSUES', 'EDIT_ISSUES'].map(
            (permission) => ({ permission, issues: ids }),
          ),
        };
      }
      return {
        issues: request.jql.includes('"ROOT-1"')
          ? Array.from({ length: 1001 }, (_, index) =>
              rawIssue(`CHILD-${index + 2}`, 'ROOT-1'),
            )
          : [],
        isLast: true,
      };
    });
    const snapshot = await provider.tree('ROOT-1');
    assert.deepEqual(sizes, [1000, 1]);
    assert.equal(snapshot.ranking?.issueKeys.length, 1001);
    assert.ok(snapshot.ranking?.issueKeys.includes('CHILD-1002'));
  });
  it('reports unknown permissions without failing tree loading', async () => {
    const provider = new JiraProvider(async (path, init) => {
      if (path.startsWith('/rest/api/3/issue/ROOT-1?'))
        return rawIssue('ROOT-1');
      if (path === '/rest/api/3/permissions/check') throw new Error('403');
      return {
        issues: body(init).jql.includes('"ROOT-1"')
          ? [rawIssue('CHILD-2', 'ROOT-1')]
          : [],
        isLast: true,
      };
    });
    const snapshot = await provider.tree('ROOT-1');
    assert.equal(snapshot.issues.length, 2);
    assert.equal(snapshot.ranking?.state, 'unknown');
    assert.deepEqual(snapshot.ranking?.issueKeys, []);
  });
  it('loads configured priority order through paginated JQL and rejects missing representatives', async () => {
    const provider = new JiraProvider(async (_path, init) => {
      assert.equal(
        body(init).jql,
        'key in ("A-2", "A-3") ORDER BY priority DESC',
      );
      return body(init).nextPageToken
        ? {
            issues: [
              rawIssue('A-2', undefined, {
                priority: { id: '20', name: 'Urgent' },
              }),
            ],
            isLast: true,
          }
        : {
            issues: [
              rawIssue('A-3', undefined, {
                priority: { id: '90', name: 'Highest' },
              }),
            ],
            nextPageToken: 'next',
            isLast: false,
          };
    });
    assert.deepEqual(await provider.priorityOrder(['A-2', 'A-3']), [
      '90',
      '20',
    ]);
    const missing = new JiraProvider(async () => ({
      issues: [],
      isLast: true,
    }));
    await assert.rejects(missing.priorityOrder(['A-2']), /could not be read/);
  });
});

describe('JiraProvider preview', () => {
  it('loads recent comments and preserves relationship direction separately from hierarchy', async () => {
    const request = recordingRequest((path) => {
      if (path.includes('/comment?')) {
        assert.ok(path.includes('maxResults=10&orderBy=-created'));
        return {
          total: 20,
          comments: [
            {
              id: '1',
              author: { displayName: 'Ada' },
              created: '2026-01-01T12:00:00Z',
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Recent comment' }],
                  },
                ],
              },
            },
          ],
        };
      }
      assert.ok(decodeURIComponent(path).includes('description'));
      return rawIssue('TEST-1', 'PARENT-1', {
        description: 'Details',
        issuelinks: [
          {
            type: { outward: 'blocks', inward: 'is blocked by' },
            outwardIssue: rawIssue('TEST-2'),
          },
          {
            type: { outward: 'blocks', inward: 'is blocked by' },
            inwardIssue: rawIssue('TEST-3'),
          },
        ],
      });
    });
    const result = await new JiraProvider(request).preview('TEST-1');
    assert.equal(result.description, 'Details');
    assert.equal(result.comments[0].body, 'Recent comment');
    assert.equal(result.totalComments, 20);
    assert.deepEqual(
      result.issue.links.map((link) => link.relationship),
      ['blocks', 'is blocked by'],
    );
    assert.equal(result.issue.parentKey, 'PARENT-1');
  });
  it('retains issue details when comments fail and can retry', async () => {
    let fails = true;
    const provider = new JiraProvider(async (path) => {
      if (!path.includes('/comment?'))
        return rawIssue('TEST-1', undefined, {
          description: 'Still available',
        });
      if (fails) throw new Error('No comment access');
      return { total: 0, comments: [] };
    });
    const partial = await provider.preview('TEST-1');
    assert.equal(partial.description, 'Still available');
    assert.match(partial.commentsError!, /No comment access/);
    fails = false;
    assert.equal((await provider.preview('TEST-1')).commentsError, undefined);
  });
});

it('caps preview comments at ten, retains author/date, and supports absent content', async () => {
  const provider = new JiraProvider(async (path) =>
    path.includes('/comment?')
      ? {
          total: 12,
          comments: Array.from({ length: 12 }, (_, index) => ({
            id: String(index),
            created: '2026-01-01T00:00:00Z',
            author: { displayName: 'Ada' },
            body: index ? null : 'Latest',
          })),
        }
      : rawIssue('TEST-1'),
  );
  const preview = await provider.preview('TEST-1');
  assert.equal(preview.description, '');
  assert.equal(preview.comments.length, 10);
  assert.equal(preview.totalComments, 12);
  assert.deepEqual(preview.comments[0], {
    id: '0',
    author: 'Ada',
    created: '2026-01-01T00:00:00Z',
    body: 'Latest',
  });
  assert.equal(preview.comments[1].body, '');
});

it('isolates malformed comment responses and rejects inaccessible preview issues', async () => {
  const malformed = new JiraProvider(async (path) =>
    path.includes('/comment?') ? { comments: null } : rawIssue('TEST-1'),
  );
  assert.match(
    (await malformed.preview('TEST-1')).commentsError!,
    /invalid comments/,
  );
  const inaccessible = new JiraProvider(async (path) => {
    if (path.includes('/comment?')) return { comments: [], total: 0 };
    throw new Error('Issue not accessible');
  });
  await assert.rejects(
    inaccessible.preview('TEST-1'),
    /load preview for TEST-1.*Issue not accessible/,
  );
});

describe('connection picker caches', () => {
  it('deduplicates independent field reads and keeps unrelated choices after searches and edits', async () => {
    const request = recordingRequest((path) => {
      if (path.endsWith('/editmeta'))
        return {
          fields: { priority: { allowedValues: [{ id: '1', name: 'High' }] } },
        };
      if (path.includes('/transitions')) return { transitions: [] };
      if (path.includes('/user/assignable/')) return [];
      return rawIssue('ABC-1');
    });
    const provider = new JiraProvider(request);
    await Promise.all([
      provider.priorities('ABC-1'),
      provider.priorities('ABC-1'),
      provider.transitions('ABC-1'),
      provider.transitions('ABC-1'),
    ]);
    assert.equal(request.calls.length, 2);
    await provider.assignees('ABC-1', 'Ada');
    await provider.assignees('ABC-1', 'Sam');
    await provider.update('ABC-1', { summary: 'New' });
    await provider.priorities('ABC-1');
    // The first observed status replaces the previously unknown transition context.
    await provider.transitions('ABC-1');
    await provider.transitions('ABC-1');
    assert.equal(
      request.calls.filter(([path]) => path.endsWith('/editmeta')).length,
      1,
    );
    assert.equal(
      request.calls.filter(([path]) => path.includes('/transitions')).length,
      2,
    );
  });

  it('does not hide priority errors or poison successful independent reads', async () => {
    let fail = true;
    const request = recordingRequest((path) => {
      if (path.endsWith('/editmeta')) {
        if (fail) throw new Error('Metadata unavailable');
        return { fields: {} };
      }
      if (path.includes('/user/assignable/'))
        throw new Error('Users unavailable');
      return { transitions: [] };
    });
    const provider = new JiraProvider(request);
    const results = await Promise.allSettled([
      provider.priorities('ABC-1'),
      provider.assignees('ABC-1'),
      provider.transitions('ABC-1'),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected', 'fulfilled'],
    );
    await assert.rejects(provider.priorities('ABC-1'), /Metadata unavailable/);
    fail = false;
    await assert.rejects(
      provider.priorities('ABC-1'),
      /Priority cannot be edited/,
    );
    assert.deepEqual(await provider.transitions('ABC-1'), []);
    assert.equal(
      request.calls.filter(([path]) => path.includes('/transitions')).length,
      1,
    );
  });

  it('bounds recent identities to 100, updates recency, and isolates provider connections', async () => {
    let users = Array.from({ length: 110 }, (_, i) => ({
      accountId: `user-${i}`,
      displayName: `Person ${i}`,
    }));
    const provider = new JiraProvider(async () => users);
    await provider.assignees('ABC-1');
    assert.equal((await provider.cachedUsers()).length, 100);
    assert.equal((await provider.cachedUsers()).at(-1)?.id, 'user-10');
    users = [{ accountId: 'user-10', displayName: 'Renamed' }];
    await provider.assignees('ABC-2');
    assert.deepEqual((await provider.cachedUsers())[0], {
      id: 'user-10',
      name: 'Renamed',
    });
    assert.deepEqual(await new JiraProvider(async () => []).cachedUsers(), []);
  });

  it('seeds identities from issues without treating them as assignment eligibility', async () => {
    const request = recordingRequest((path) =>
      path.includes('/user/assignable/')
        ? []
        : { issues: [rawIssue('ABC-1')], isLast: true },
    );
    const provider = new JiraProvider(request);
    await provider.search('ABC');
    assert.deepEqual(await provider.cachedUsers(), [
      { id: 'account-1', name: 'Ada' },
    ]);
    assert.equal(await provider.validateAssignee('ABC-2', 'account-1'), null);
    assert.equal(
      request.calls.filter(([path]) => path.includes('accountId=account-1'))
        .length,
      1,
    );
  });

  it('advances candidate windows even on empty pages and stops at 1,000', async () => {
    const request = recordingRequest(() => []);
    const provider = new JiraProvider(request);
    let start: number | undefined = 0;
    while (start !== undefined)
      start = (await provider.assignees('ABC-1', 'a b', start)).nextStartAt;
    assert.equal(request.calls.length, 10);
    assert.match(
      request.calls[9][0],
      /query=a%20b&startAt=900&maxResults=100$/,
    );
    assert.throws(
      () => provider.assignees('ABC-1', '', 1000),
      /Invalid assignee/,
    );
    await provider.assignees('ABC-1', 'a b', 0);
    assert.equal(request.calls.length, 11);
  });

  it('refreshes all issue metadata on observed status changes and only a rejected field otherwise', async () => {
    let status = '10';
    let rejectPriority = false;
    const request = recordingRequest((path, init) => {
      if (init?.method === 'PUT' && rejectPriority)
        throw new Error('Priority rejected');
      if (path.endsWith('/editmeta'))
        return { fields: { priority: { allowedValues: [] } } };
      if (path.includes('/transitions')) return { transitions: [] };
      if (path.includes('/user/assignable/')) return [];
      if (path === '/rest/api/3/search/jql')
        return {
          issues: [rawIssue('ABC-1', undefined, { status: { id: status } })],
          isLast: true,
        };
      return rawIssue('ABC-1', undefined, { status: { id: status } });
    });
    const provider = new JiraProvider(request);
    await provider.search('ABC');
    const load = () =>
      Promise.all([
        provider.priorities('ABC-1'),
        provider.transitions('ABC-1'),
        provider.assignees('ABC-1'),
      ]);
    await load();
    status = '20';
    await provider.search('ABC');
    await load();
    assert.equal(
      request.calls.filter(([path]) => path.endsWith('/editmeta')).length,
      2,
    );
    assert.equal(
      request.calls.filter(([path]) => path.includes('/transitions')).length,
      2,
    );
    assert.equal(
      request.calls.filter(([path]) => path.includes('/user/assignable'))
        .length,
      2,
    );
    rejectPriority = true;
    await assert.rejects(
      provider.update('ABC-1', { priorityId: '9' }),
      /Priority rejected/,
    );
    await load();
    assert.equal(
      request.calls.filter(([path]) => path.endsWith('/editmeta')).length,
      3,
    );
    assert.equal(
      request.calls.filter(([path]) => path.includes('/transitions')).length,
      2,
    );
    await Promise.all([
      provider.transitions('ABC-1', true),
      provider.transitions('ABC-1', true),
    ]);
    assert.equal(
      request.calls.filter(([path]) => path.includes('/transitions')).length,
      3,
    );
  });

  it('keeps eligibility issue-specific and revalidates when explicitly refreshed', async () => {
    const request = recordingRequest((path) =>
      path.includes('issueKey=ABC-1')
        ? [{ accountId: 'ada', displayName: 'Ada' }]
        : [],
    );
    const provider = new JiraProvider(request);
    await Promise.all([
      provider.validateAssignee('ABC-1', 'ada'),
      provider.validateAssignee('ABC-1', 'ada'),
    ]);
    assert.equal(request.calls.length, 1);
    assert.equal(await provider.validateAssignee('ABC-2', 'ada'), null);
    await provider.validateAssignee('ABC-1', 'ada', true);
    assert.equal(request.calls.length, 3);
  });
});

it('shares pending assignee pages but searches again after completion', async () => {
  let finish!: (value: unknown[]) => void;
  let calls = 0;
  const provider = new JiraProvider(async () => {
    calls++;
    return new Promise<unknown[]>((resolve) => {
      finish = resolve;
    });
  });
  const a = provider.assignees('ABC-1', 'Ada');
  const b = provider.assignees('ABC-1', 'Ada');
  assert.equal(calls, 1);
  finish([{ accountId: 'ada', displayName: 'Ada' }]);
  await Promise.all([a, b]);
  const changed = provider.assignees('ABC-1', 'Ada');
  assert.equal(calls, 2);
  finish([]);
  assert.deepEqual((await changed).users, []);
});

it('checks fresh required fields before submitting a cached transition and invalidates rejection', async () => {
  let required = false;
  const request = recordingRequest((path, init) => {
    if (path.includes('/transitions?'))
      return {
        transitions: [
          {
            id: 'finish',
            name: 'Finish',
            fields: { resolution: { required } },
          },
        ],
      };
    if (init?.method === 'POST')
      throw new Error('A transition requiring fields must not be submitted');
    return rawIssue('ABC-1');
  });
  const provider = new JiraProvider(request);
  assert.equal((await provider.transitions('ABC-1'))[0].requiresFields, false);
  required = true;
  await assert.rejects(
    provider.update('ABC-1', { transitionId: 'finish' }),
    /requires fields/,
  );
  assert.equal((await provider.transitions('ABC-1'))[0].requiresFields, true);
  assert.equal(request.calls.length, 3);
});
