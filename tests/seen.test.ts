import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Issue, TreeSnapshot } from '../src/shared/types';
import {
  boundRoots,
  markIssueSeen,
  markRootSeen,
  reconcileOwnEdit,
  seedOrExtend,
  seenRootKey,
  unseenChanges,
} from '../src/renderer/seen';

const issue = (summary = 'First', commentCount?: number): Issue => ({
  id: '1',
  key: 'ONE-1',
  summary,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
  commentCount,
});
const tree = (current: Issue, fetchedAt = 100): TreeSnapshot => ({
  rootKey: 'ONE-1',
  issues: [current],
  fetchedAt,
  warnings: [],
});

describe('last-seen issue baselines', () => {
  it('seeds the first successful tree and preserves differences across serialization and refreshes', () => {
    const first = seedOrExtend(undefined, tree(issue('First', 2)));
    assert.equal(
      unseenChanges(first.issues['ONE-1'], issue('First', 2)).fields.length,
      0,
    );
    const saved = JSON.parse(JSON.stringify(first));
    const changed = issue('Second', 3);
    const refreshed = seedOrExtend(saved, tree(changed, 200));
    assert.deepEqual(unseenChanges(refreshed.issues['ONE-1'], changed), {
      fields: [{ name: 'Summary', before: 'First', after: 'Second' }],
      comments: 1,
    });
    assert.deepEqual(
      unseenChanges(
        markIssueSeen(refreshed, changed, 250).issues['ONE-1'],
        changed,
      ),
      { fields: [], comments: 0 },
    );
  });

  it('reconciles only a confirmed own field, leaving unrelated remote changes unread', () => {
    const key = seenRootKey('jira', 'ONE-1');
    const baseline = markRootSeen(tree(issue('First', 2)));
    const pending = issue('Draft', 3);
    assert.equal(
      unseenChanges(baseline.issues['ONE-1'], pending).fields.length,
      1,
    );
    const roots = reconcileOwnEdit({ [key]: baseline }, 'jira', pending, [
      'Summary',
    ]);
    assert.deepEqual(unseenChanges(roots[key].issues['ONE-1'], pending), {
      fields: [],
      comments: 1,
    });
    assert.equal(
      unseenChanges(baseline.issues['ONE-1'], issue('First', 2)).comments,
      0,
    );
  });

  it('fills previously unavailable data without treating it as a change', () => {
    const partial = { ...issue('First'), unavailableFields: ['summary'] };
    const baseline = seedOrExtend(undefined, tree(partial));
    assert.equal('Summary' in baseline.issues['ONE-1'].fields, false);
    const full = seedOrExtend(baseline, tree(issue('First', 2), 200));
    assert.equal(full.issues['ONE-1'].fields.Summary, 'First');
    assert.equal(full.issues['ONE-1'].commentCount, 2);
    const unavailableAgain = {
      ...issue('Different'),
      unavailableFields: ['summary'],
    };
    assert.equal(
      unseenChanges(full.issues['ONE-1'], unavailableAgain).fields.length,
      0,
    );
  });

  it('keeps baselines for issues missing from a later partial tree', () => {
    const original = markRootSeen({
      ...tree(issue()),
      issues: [issue(), { ...issue(), key: 'ONE-2' }],
    });
    const marked = markRootSeen(tree(issue('Updated')), original, 300);
    assert.equal(marked.issues['ONE-2'].fields.Summary, 'First');
    assert.equal(marked.issues['ONE-1'].fields.Summary, 'Updated');
  });

  it('bounds retained roots and issues', () => {
    const many = {
      ...tree(issue()),
      issues: Array.from({ length: 1100 }, (_, index) => ({
        ...issue(),
        key: `ONE-${index}`,
      })),
    };
    assert.equal(Object.keys(markRootSeen(many).issues).length, 1000);
    const roots = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        String(index),
        { touchedAt: index, issues: {} },
      ]),
    );
    assert.equal(Object.keys(boundRoots(roots)).length, 12);
    assert.equal('0' in boundRoots(roots), false);
  });

  it('retains a baseline in every recent root when the byte limit is reached', () => {
    const roots = Object.fromEntries(
      Array.from({ length: 12 }, (_, root) => [
        String(root),
        {
          touchedAt: root,
          issues: Object.fromEntries(
            Array.from({ length: 500 }, (_, index) => [
              `ONE-${index}`,
              {
                seenAt: index,
                fields: {
                  Summary: 'x'.repeat(300),
                  Type: 'x'.repeat(300),
                },
              },
            ]),
          ),
        },
      ]),
    );
    const bounded = boundRoots(roots);
    assert.ok(Object.keys(bounded['0'].issues).length > 0);
    assert.ok(Object.keys(bounded['11'].issues).length > 0);
  });

  it('uses Jira last activity to flag comment-only changes without tree comment bodies', () => {
    const initial = { ...issue(), updated: '2026-09-25T00:00:00Z' };
    const baseline = markRootSeen(tree(initial));
    const changed = { ...initial, updated: '2026-09-26T00:00:00Z' };
    assert.deepEqual(unseenChanges(baseline.issues['ONE-1'], changed), {
      fields: [
        {
          name: 'Last activity',
          before: initial.updated,
          after: changed.updated,
        },
      ],
      comments: 0,
    });
    const reconciled = reconcileOwnEdit(
      { 'jira:ONE-1': baseline },
      'jira',
      changed,
      ['Summary'],
    );
    assert.deepEqual(
      unseenChanges(reconciled['jira:ONE-1'].issues['ONE-1'], changed),
      { fields: [], comments: 0 },
    );
  });
});
