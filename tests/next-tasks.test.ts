import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Issue, TreeSnapshot } from '../src/shared/types';
import { nextTasks } from '../src/renderer/next-tasks';

function issue(
  key: string,
  parentKey?: string,
  patch: Partial<Issue> = {},
): Issue {
  return {
    id: key,
    key,
    parentKey,
    summary: key,
    type: 'Task',
    priority: null,
    assignee: null,
    status: { id: 'new', name: 'To Do', category: 'new' },
    links: [],
    ...patch,
  };
}
function snapshot(issues: Issue[]): TreeSnapshot {
  return { rootKey: 'A-1', issues, fetchedAt: 1, warnings: [] };
}

describe('next tasks', () => {
  it('includes unfinished parents and descendants, keeps parent context, and excludes done issues', () => {
    const tasks = nextTasks(
      snapshot([
        issue('A-1'),
        issue('A-2', 'A-1'),
        issue('A-3', 'A-2', {
          status: { id: 'done', name: 'Done', category: 'done' },
        }),
        issue('A-4', 'A-3'),
      ]),
      'jira',
      'rank',
    );
    assert.deepEqual(
      tasks.map((task) => task.issue.key),
      ['A-1', 'A-2', 'A-4'],
    );
    assert.deepEqual(
      tasks[2].parents.map((parent) => parent.key),
      ['A-1', 'A-2', 'A-3'],
    );
  });

  it('uses each issue’s own Jira priority and keeps blocked issues behind unknown and clear issues', () => {
    const tasks = nextTasks(
      snapshot([
        issue('A-1', undefined, {
          priority: { id: 'urgent', name: 'Urgent' },
        }),
        issue('A-2', 'A-1', {
          priority: { id: 'low', name: 'Low' },
        }),
        issue('A-3', 'A-1', {
          priority: { id: 'urgent', name: 'Urgent' },
          links: [
            {
              key: 'X-1',
              summary: 'Blocker',
              relationship: 'is blocked by',
              statusCategory: 'new',
            },
          ],
        }),
      ]),
      'jira',
      'priority',
      undefined,
      false,
      ['urgent', 'low'],
    );
    assert.deepEqual(
      tasks.map((task) => task.issue.key),
      ['A-1', 'A-2', 'A-3'],
    );
    assert.equal(tasks[2].blocker, 'blocked');
  });

  it('distinguishes completed, unreadable, and active blockers', () => {
    const tasks = nextTasks(
      snapshot([
        issue('A-1'),
        issue('A-2', 'A-1', {
          links: [
            {
              key: 'X-2',
              summary: 'Completed',
              relationship: 'is blocked by',
              statusCategory: 'done',
            },
          ],
        }),
        issue('A-3', 'A-1', {
          links: [
            {
              key: 'X-3',
              summary: 'Unreadable',
              relationship: 'is blocked by',
            },
          ],
        }),
        issue('A-5', 'A-1', { linksAvailable: false }),
        issue('A-4', 'A-1', {
          links: [
            { key: 'X-4', summary: 'Active', relationship: 'is blocked by' },
          ],
        }),
        issue('X-4', 'A-1'),
      ]),
      'jira',
      'blocked',
    );
    assert.equal(
      tasks.find((task) => task.issue.key === 'A-2')?.blocker,
      'clear',
    );
    assert.equal(
      tasks.find((task) => task.issue.key === 'A-3')?.blocker,
      'unknown',
    );
    assert.equal(
      tasks.find((task) => task.issue.key === 'A-5')?.blocker,
      'unknown',
    );
    assert.deepEqual(tasks.find((task) => task.issue.key === 'A-4')?.blockers, [
      'X-4',
    ]);
  });

  it('keeps GitHub blocker state unknown and filters assigned-to-me issues', () => {
    const tasks = nextTasks(
      snapshot([
        issue('A-1', undefined, { type: 'Repository' }),
        issue('A-2', 'A-1', { assignee: { id: 'me', name: 'Me' } }),
        issue('A-3', 'A-1', { assignee: { id: 'other', name: 'Other' } }),
      ]),
      'github',
      'assignment',
      'me',
      true,
    );
    assert.deepEqual(
      tasks.map((task) => task.issue.key),
      ['A-2'],
    );
    assert.equal(tasks[0].blocker, 'unknown');
  });
});
