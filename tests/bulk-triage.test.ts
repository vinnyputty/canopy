import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bulkChoices,
  copySelectedIssues,
  executeBulkIssue,
  planBulk,
} from '../src/renderer/bulk-triage';
import type {
  CanopyAPI,
  Connection,
  EditOptions,
  Issue,
} from '../src/shared/types';

const jira: Connection = {
  id: 'jira-a',
  name: 'Jira',
  url: 'https://jira.example',
  provider: 'jira',
};
const github: Connection = {
  id: 'github-a',
  name: 'GitHub',
  url: 'https://github.com',
  provider: 'github',
};
const issue = (key: string): Issue => ({
  id: key,
  key,
  summary: key,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
});
const transition = (
  id: string,
  toId: string,
  name = 'Done',
  category: Issue['status']['category'] = 'done',
  requiresFields = false,
): EditOptions['transitions'][number] => ({
  id,
  name,
  requiresFields,
  to: { id: toId, name, category },
});
const api = (overrides: Partial<CanopyAPI>): CanopyAPI =>
  overrides as CanopyAPI;

describe('bulk triage eligibility', () => {
  it('uses each Jira issue’s transition ID for the same destination status', async () => {
    const calls: string[] = [];
    const client = api({
      transitions: async (connection, key) => {
        calls.push(`${connection}:${key}`);
        return key === 'A-1'
          ? [transition('11', 'done')]
          : [transition('93', 'done')];
      },
    });
    const issues = [issue('A-1'), issue('A-2')];
    const choices = await bulkChoices(client, jira, issues, 'status');
    assert.deepEqual(choices, [{ id: 'done', name: 'Done', category: 'done' }]);
    const candidates = await planBulk(
      client,
      jira,
      issues,
      'status',
      choices[0],
    );
    assert.deepEqual(
      candidates.map((value) => value.patch?.transitionId),
      ['11', '93'],
    );
    assert.deepEqual(calls, [
      'jira-a:A-1',
      'jira-a:A-2',
      'jira-a:A-1',
      'jira-a:A-2',
    ]);
  });

  it('rejects same named destinations with different IDs or categories and required-field transitions', async () => {
    const client = api({
      transitions: async (_connection, key) =>
        key === 'A-1'
          ? [
              transition('11', 'done-1'),
              transition('12', 'blocked', 'Blocked', 'indeterminate', true),
            ]
          : [
              transition('93', 'done-2'),
              transition('94', 'blocked', 'Blocked', 'indeterminate'),
            ],
    });
    assert.deepEqual(
      await bulkChoices(client, jira, [issue('A-1'), issue('A-2')], 'status'),
      [],
    );
    const plan = await planBulk(client, jira, [issue('A-1')], 'status', {
      id: 'blocked',
      name: 'Blocked',
      category: 'indeterminate',
    });
    assert.match(plan[0].reason ?? '', /No valid transition/);
  });

  it('shows per-issue priority and assignee failures without creating patches', async () => {
    const client = api({
      priorities: async (_connection, key) =>
        key === 'A-1' ? [{ id: 'high', name: 'High' }] : [],
      validateAssignee: async (_connection, key, id) =>
        key === 'A-1' ? { id, name: 'Ada' } : null,
    });
    const issues = [issue('A-1'), issue('A-2')];
    const priority = await planBulk(client, jira, issues, 'priority', {
      id: 'high',
      name: 'High',
    });
    assert.equal(priority[0].patch?.priorityId, 'high');
    assert.match(priority[1].reason ?? '', /unavailable/);
    const assignee = await planBulk(client, jira, issues, 'assignee', {
      id: 'ada',
      name: 'Ada',
    });
    assert.equal(assignee[0].patch?.assigneeId, 'ada');
    assert.match(assignee[1].reason ?? '', /not assignable/);
  });

  it('keeps GitHub assignment repository-specific and excludes Jira priority', async () => {
    const client = api({
      validateAssignee: async (_connection, key, id) =>
        key.startsWith('one/') ? { id, name: id } : null,
      transitions: async () => [
        { id: 'open', name: 'Open', requiresFields: false },
        { id: 'closed', name: 'Closed', requiresFields: false },
      ],
    });
    const issues = [issue('one/repo#1'), issue('two/repo#2')];
    const assigned = await planBulk(client, github, issues, 'assignee', {
      id: 'ada',
      name: 'Ada',
    });
    assert.equal(assigned[0].patch?.assigneeId, 'ada');
    assert.equal(assigned[1].patch, undefined);
    assert.equal(
      (
        await planBulk(client, github, issues, 'priority', {
          id: 'high',
          name: 'High',
        })
      )[0].patch,
      undefined,
    );
    assert.deepEqual(
      (
        await planBulk(client, github, issues, 'status', {
          id: 'closed',
          name: 'Closed',
        })
      ).map((value) => value.patch?.transitionId),
      ['closed', 'closed'],
    );
  });

  it('records per-issue validation and write failures while later eligible issues proceed', async () => {
    const client = api({
      priorities: async (_connection, key) => {
        if (key === 'A-1') throw new Error('Metadata unavailable');
        return [{ id: 'high', name: 'High' }];
      },
    });
    const calls: string[] = [];
    const update = async (key: string) => {
      calls.push(key);
      if (key === 'A-2') throw new Error('Write failed');
      return true;
    };
    const choice = { id: 'high', name: 'High' };
    const results = [];
    for (const key of ['A-1', 'A-2', 'A-3'])
      results.push(
        await executeBulkIssue(
          client,
          jira,
          issue(key),
          'priority',
          choice,
          update,
        ),
      );
    assert.deepEqual(
      results.map((result) => result.state),
      ['failed', 'failed', 'saved'],
    );
    assert.match(results[0].reason ?? '', /Metadata unavailable/);
    assert.match(results[1].reason ?? '', /Write failed/);
    assert.deepEqual(calls, ['A-2', 'A-3']);
  });

  it('copies selected identities with success or a handled error', async () => {
    let text = '';
    assert.deepEqual(
      await copySelectedIssues(
        api({
          copyText: async (value) => {
            text = value;
          },
        }),
        [issue('A-1'), issue('A-2')],
      ),
      { ok: true },
    );
    assert.equal(text, 'A-1 A-1\nA-2 A-2');
    assert.deepEqual(
      await copySelectedIssues(
        api({
          copyText: async () => {
            throw new Error('Clipboard unavailable');
          },
        }),
        [issue('A-1')],
      ),
      { ok: false, error: 'Clipboard unavailable' },
    );
  });
});
