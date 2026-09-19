import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  nextEditableCell,
  retainEditingOrder,
} from '../src/renderer/edit-navigation';
import {
  buildIssueTree,
  filterTree,
  flattenVisible,
  ancestorPath,
} from '../src/renderer/tree';
import { sortIssueTree } from '../src/renderer/table-view';
import type { Issue } from '../src/shared/types';

const issue = (key: string, summary = key, parentKey?: string): Issue => ({
  id: key,
  key,
  summary,
  parentKey,
  type: 'Task',
  status: { id: 'open', name: 'Open', category: 'new' },
  priority: null,
  assignee: null,
  links: [],
});
const tree = () =>
  buildIssueTree(
    [
      issue('A-1'),
      issue('A-2', 'Zulu', 'A-1'),
      issue('A-3', 'Alpha', 'A-1'),
      issue('A-4', 'Middle', 'A-1'),
    ],
    'A-1',
  )!;

it('traverses visible reordered columns over the sorted focused filtered rows', () => {
  const filtered = filterTree(tree(), 'a-', {}, false)!;
  const sorted = sortIssueTree(filtered, { column: 'issue', direction: 'asc' });
  const rows = flattenVisible(sorted, new Set(['A-1']));
  const columns = ['issue', 'status', 'assignee'] as const;
  assert.deepEqual(nextEditableCell(rows, [...columns], 'A-3', 'summary', 1), {
    key: 'A-3',
    field: 'status',
  });
  assert.deepEqual(nextEditableCell(rows, [...columns], 'A-3', 'assignee', 1), {
    key: 'A-4',
    field: 'summary',
  });
  assert.deepEqual(nextEditableCell(rows, [...columns], 'A-4', 'summary', -1), {
    key: 'A-3',
    field: 'assignee',
  });
  assert.equal(
    nextEditableCell(rows, [...columns], 'A-3', 'priority', 1),
    null,
  );
  assert.deepEqual(nextEditableCell(rows, ['issue'], 'A-3', 'summary', 1), {
    key: 'A-4',
    field: 'summary',
  });
  const focused = flattenVisible(sorted.children[0], new Set());
  assert.equal(
    nextEditableCell(focused, [...columns], 'A-3', 'assignee', 1),
    null,
  );
  assert.equal(
    nextEditableCell(rows, [...columns], 'A-1', 'summary', -1),
    null,
  );
});

it('retains multiple edited/pending filtered-out rows with their ancestor paths', () => {
  const root = buildIssueTree(
    [
      issue('A-1'),
      issue('A-2', 'parent', 'A-1'),
      {
        ...issue('A-3', 'edited', 'A-2'),
        status: { id: 'done', name: 'Done', category: 'done' as const },
      },
      issue('A-4', 'pending', 'A-1'),
      issue('A-5', 'unrelated', 'A-1'),
    ],
    'A-1',
  )!;
  const retained = filterTree(
    root,
    'does not match',
    { assignee: 'unassigned', priority: 'high' },
    true,
    undefined,
    undefined,
    new Set(['A-3', 'A-4']),
  );
  assert.deepEqual(
    flattenVisible(retained, new Set(['A-1', 'A-2'])).map(
      (node) => node.issue.key,
    ),
    ['A-1', 'A-2', 'A-3', 'A-4'],
  );
  assert.equal(filterTree(root, 'does not match', {}, true), null);
});

it('pins edited rows and ancestors while other rows sort, then permits settled rows to move', () => {
  const before = tree();
  const sorted = sortIssueTree(before, { column: 'issue', direction: 'asc' });
  const pinned = retainEditingOrder(
    sorted,
    before,
    new Set(ancestorPath(before, 'A-2').map((node) => node.issue.key)),
  )!;
  assert.deepEqual(
    pinned.children.map((node) => node.issue.key),
    ['A-2', 'A-3', 'A-4'],
  );
  assert.deepEqual(
    retainEditingOrder(sorted, pinned, new Set())!.children.map(
      (node) => node.issue.key,
    ),
    ['A-3', 'A-4', 'A-2'],
  );
  assert.equal(
    retainEditingOrder(sorted.children[0], before, new Set(['A-2'])),
    sorted.children[0],
  );
});
