import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Issue, TreeSnapshot } from '../src/shared/types';
import {
  buildIssueTree,
  filterTree,
  expansionKeys,
  ancestorPath,
  childCounts,
  defaultShortcuts,
  eventShortcut,
  flattenVisible,
  parseIssueKey,
  reconcileSnapshot,
  shortcutCollisions,
  visibleTree,
} from '../src/renderer/tree';

function issue(
  key: string,
  parentKey?: string,
  category: Issue['status']['category'] = 'new',
): Issue {
  return {
    id: key,
    key,
    parentKey,
    summary: key,
    type: 'Task',
    priority: null,
    assignee: null,
    status: { id: category, name: category, category },
    links: [],
  };
}

describe('renderer tree helpers', () => {
  it('builds the Jira parent hierarchy and flattens only expanded branches', () => {
    const root = buildIssueTree(
      [issue('A-1'), issue('A-2', 'A-1'), issue('A-3', 'A-2')],
      'A-1',
    );
    assert.equal(root?.children[0].issue.key, 'A-2');
    assert.deepEqual(
      flattenVisible(root, new Set(['A-1'])).map((node) => node.issue.key),
      ['A-1', 'A-2'],
    );
  });

  it('does not create recursive trees from malformed parent cycles', () => {
    const root = buildIssueTree(
      [issue('A-1', 'A-2'), issue('A-2', 'A-1')],
      'A-1',
    );
    assert.deepEqual(
      flattenVisible(root, new Set(['A-1', 'A-2'])).map(
        (node) => node.issue.key,
      ),
      ['A-1'],
    );
  });

  it('hides done leaves while retaining a done ancestor with unfinished descendants', () => {
    const root = buildIssueTree(
      [
        issue('A-1'),
        issue('A-2', 'A-1', 'done'),
        issue('A-3', 'A-2'),
        issue('A-4', 'A-1', 'done'),
      ],
      'A-1',
    )!;
    const shown = visibleTree(root, true)!;
    assert.deepEqual(
      shown.children.map((node) => node.issue.key),
      ['A-2'],
    );
    assert.equal(shown.children[0].children[0].issue.key, 'A-3');
  });

  it('keeps object identity for issues unchanged by a refresh', () => {
    const stable = issue('A-1');
    const changed = issue('A-2', 'A-1');
    const previous: TreeSnapshot = {
      rootKey: 'A-1',
      issues: [stable, changed],
      fetchedAt: 1,
      warnings: [],
    };
    const next: TreeSnapshot = {
      rootKey: 'A-1',
      issues: [{ ...stable }, { ...changed, summary: 'Updated' }],
      fetchedAt: 2,
      warnings: [],
    };
    const reconciled = reconcileSnapshot(previous, next);
    assert.equal(reconciled.issues[0], stable);
    assert.notEqual(reconciled.issues[1], changed);
  });

  it('accepts issue keys and Jira browse URLs', () => {
    assert.equal(parseIssueKey(' canopy-42 '), 'CANOPY-42');
    assert.equal(
      parseIssueKey(
        'https://example.atlassian.net/browse/CNP-9?focusedCommentId=1',
      ),
      'CNP-9',
    );
    assert.equal(parseIssueKey('not a key'), null);
  });

  it('normalizes shortcuts and reports every collision', () => {
    assert.equal(
      eventShortcut({
        key: 'Shift',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
      '',
    );
    assert.equal(
      eventShortcut({
        key: 'p',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
      'Meta+Shift+P',
    );
    assert.deepEqual(
      [
        ...shortcutCollisions({
          open: 'Meta+P',
          search: 'Meta+P',
          close: 'Meta+W',
        }).values(),
      ],
      [['open', 'search']],
    );
    assert.equal(defaultShortcuts('Win32').quickOpen, 'Ctrl+P');
    assert.equal(defaultShortcuts('MacIntel').toggleSidebar, 'Meta+B');
    assert.equal(defaultShortcuts('Win32').selectTab9, 'Ctrl+9');
  });
});

describe('tree navigation', () => {
  const issues = [
    issue('A-1'),
    issue('A-2', 'A-1', 'done'),
    issue('A-3', 'A-2'),
    issue('A-4', 'A-1'),
  ];
  issues[2] = {
    ...issues[2],
    summary: 'Needle title',
    assignee: { id: 'me', name: 'Same Name' },
    priority: { id: 'high', name: 'High' },
  };
  issues[3] = { ...issues[3], assignee: { id: 'other', name: 'Same Name' } };
  const root = buildIssueTree(issues, 'A-1')!;
  it('reveals matching descendant paths while retaining completed ancestors', () => {
    const filtered = filterTree(root, 'NEEDLE', {}, true);
    assert.deepEqual(expansionKeys(filtered), ['A-1', 'A-2', 'A-3']);
    assert.deepEqual(expansionKeys(filterTree(root, 'a-3', {}, false)), [
      'A-1',
      'A-2',
      'A-3',
    ]);
    assert.equal(filterTree(root, 'missing', {}, false), null);
    assert.deepEqual(expansionKeys(root, 1), ['A-1']);
    assert.deepEqual(expansionKeys(root, 2), ['A-1', 'A-2', 'A-4']);
  });
  it('combines filters and compares account IDs rather than names', () => {
    assert.deepEqual(
      expansionKeys(
        filterTree(
          root,
          '',
          { assignee: 'me', status: 'new', priority: 'high' },
          true,
          'me',
        ),
      ),
      ['A-1', 'A-2', 'A-3'],
    );
    assert.equal(filterTree(root, '', { assignee: 'me' }, false), null);
    assert.equal(
      filterTree(root, '', { assignee: 'me', status: 'done' }, false, 'me'),
      null,
    );
    assert.deepEqual(
      expansionKeys(filterTree(root, '', { assignee: 'unassigned' }, false)),
      ['A-1', 'A-2'],
    );
  });
  it('filters null priorities and respects completed leaves without pruning matching ancestors', () => {
    assert.deepEqual(
      expansionKeys(filterTree(root, '', { priority: '__none__' }, false)),
      ['A-1', 'A-2', 'A-4'],
    );
    assert.deepEqual(
      expansionKeys(filterTree(root, '', { status: 'done' }, false)),
      ['A-1', 'A-2'],
    );
    assert.equal(filterTree(root, '', { status: 'done' }, true), null);
    assert.deepEqual(expansionKeys(root.children[0], 0), []);
    assert.deepEqual(expansionKeys(root.children[0]), ['A-2', 'A-3']);
    assert.deepEqual(expansionKeys(root), ['A-1', 'A-2', 'A-3', 'A-4']);
  });
  it('reveals an excluded selection and keeps only its ancestor path', () => {
    assert.deepEqual(
      expansionKeys(filterTree(root, 'missing', {}, true, undefined, 'A-3')),
      ['A-1', 'A-2', 'A-3'],
    );
    assert.deepEqual(
      ancestorPath(root, 'A-3').map((node) => node.issue.key),
      ['A-1', 'A-2', 'A-3'],
    );
    assert.deepEqual(ancestorPath(root, 'A-99'), []);
  });
  it('distinguishes direct open/total children from all descendants', () => {
    assert.deepEqual(childCounts(root), { open: 1, total: 2, descendants: 3 });
  });
});
