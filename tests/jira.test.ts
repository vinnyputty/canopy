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
  it('escapes user input in JQL and follows nextPageToken', async () => {
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
      result.map((issue) => issue.key),
      ['ONE-1', 'TWO-2'],
    );
    assert.equal(
      body(request.calls[0][1]).jql,
      'summary ~ "a\\"b\\\\\\\\c\\\\+" ORDER BY updated DESC',
    );
    assert.equal(body(request.calls[1][1]).nextPageToken, 'next');
  });

  it('adds exact-key matching only for issue-key-shaped searches', async () => {
    const request = recordingRequest(() => ({ issues: [], isLast: true }));
    await new JiraProvider(request).search('ABC-123');
    assert.equal(
      body(request.calls[0][1]).jql,
      '(key = "ABC-123" OR summary ~ "ABC\\\\-123") ORDER BY updated DESC',
    );
  });

  it('combines editable priorities, assignable users, and transition requirements', async () => {
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
            { id: '2', name: 'Start', fields: {} },
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

    assert.deepEqual(
      await new JiraProvider(request).editOptions('ABC-1', 'ad a'),
      {
        priorities: [{ id: '1', name: 'Highest' }],
        assignees: [{ id: 'user-1', name: 'Ada' }],
        transitions: [
          { id: '2', name: 'Start', requiresFields: false },
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
