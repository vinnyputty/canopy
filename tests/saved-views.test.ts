import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Issue, TreeSnapshot, Workspace } from '../src/shared/types';
import { validSavedViews } from '../src/shared/views';
import {
  configuredRoots,
  starterViews,
  sourceTabId,
  viewResults,
  viewSources,
} from '../src/renderer/saved-views';

const workspace: Workspace = {
  tabs: [
    {
      id: 'one',
      connectionId: 'a',
      rootKey: 'A-1',
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    },
  ],
  activeTabId: 'one',
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
  pinnedRoots: [{ connectionId: 'a', rootKey: 'A-2' }],
};
function issue(
  id: string,
  key: string,
  assignee: string | null,
  status: string,
): Issue {
  return {
    id,
    key,
    summary: key,
    type: 'Task',
    priority: null,
    assignee: assignee ? { id: assignee, name: assignee } : null,
    status: { id: status, name: status, category: 'new' },
    links: [],
  };
}
function snapshot(rootKey: string, issues: Issue[]): TreeSnapshot {
  return { rootKey, issues, fetchedAt: 1, warnings: [] };
}

describe('saved issue views', () => {
  it('expands selected connections over configured roots and deduplicates overlapping roots', () => {
    const roots = configuredRoots(workspace, [
      { id: 'a', name: 'A', url: '', provider: 'jira' },
      {
        id: 'b',
        name: 'B',
        url: '',
        provider: 'github',
        repositories: ['org/repo'],
      },
    ]);
    const view = {
      ...starterViews()[0],
      roots: [{ connectionId: 'a', rootKey: 'A-1' }],
      connectionIds: ['a'],
    };
    assert.deepEqual(
      viewSources(view, roots).map((source) => source.rootKey),
      ['A-1', 'A-2'],
    );
    assert(roots.some((root) => root.rootKey === 'org/repo'));
  });

  it('uses an open tree tab for source loading and snapshot state', () => {
    const source = viewSources(
      { ...starterViews()[0], roots: [{ connectionId: 'a', rootKey: 'A-1' }] },
      [],
    )[0];
    assert.equal(sourceTabId(source, workspace.tabs), 'one');
    assert.equal(sourceTabId(source, []), source.id);
  });

  it('matches personal and review statuses, deduplicates by provider issue ID, and keeps the first root as context', () => {
    const sources = viewSources(
      {
        ...starterViews()[0],
        roots: [
          { connectionId: 'a', rootKey: 'A-1' },
          { connectionId: 'a', rootKey: 'A-2' },
        ],
        connectionIds: [],
      },
      [],
    );
    const shared = issue('42', 'A-42', 'me', 'In Review');
    const snapshots = {
      [sources[0].id]: snapshot('A-1', [
        shared,
        issue('43', 'A-43', 'other', 'Open'),
      ]),
      [sources[1].id]: snapshot('A-2', [shared]),
    };
    const assigned = viewResults(starterViews()[0], sources, snapshots, {
      a: { id: 'me' },
    });
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].source.rootKey, 'A-1');
    assert.deepEqual(
      viewResults(starterViews()[2], sources, snapshots, {}).map(
        (result) => result.issue.key,
      ),
      ['A-42'],
    );
  });

  it('rejects invalid saved view definitions', () => {
    assert(validSavedViews(starterViews()));
    assert.equal(
      validSavedViews([
        {
          ...starterViews()[0],
          filters: { ...starterViews()[0].filters, statuses: [42] },
        },
      ]),
      false,
    );
  });
});
