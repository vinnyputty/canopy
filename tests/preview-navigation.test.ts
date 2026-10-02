import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Connection, TabState } from '../src/shared/types';
import { previewTarget } from '../src/renderer/preview-navigation';
import { travel, visit } from '../src/renderer/workspace';
import type { ViewResult } from '../src/renderer/saved-views';

const connections: Connection[] = ['first', 'second'].map((id) => ({
  id,
  name: id,
  url: `https://${id}.invalid`,
  provider: 'jira',
}));
const tab = (id: string, selectedKey = 'TEST-2'): TabState => ({
  id,
  connectionId: id,
  rootKey: 'TEST-1',
  selectedKey,
  expanded: ['TEST-1'],
  hideDone: false,
  scrollTop: 0,
});
const target = (
  value: TabState | null,
  override: Parameters<typeof previewTarget>[5] = null,
) => previewTarget(value, connections, false, [], null, override);

describe('preview navigation', () => {
  it('restores each tab selection and scopes linked previews to the originating selection', () => {
    const first = tab('first');
    const second = tab('second', 'TEST-3');
    const linked = {
      tabId: first.id,
      selectedKey: first.selectedKey,
      key: 'LINK-9',
    };
    assert.equal(target(first, linked)?.key, 'LINK-9');
    assert.deepEqual(target(second, linked), {
      ...second,
      key: 'TEST-3',
      provider: 'jira',
    });
    assert.equal(target(first)?.key, 'TEST-2');
    assert.equal(
      target({ ...first, selectedKey: 'TEST-4' }, linked)?.key,
      'TEST-4',
    );
  });
  it('uses restored Back/Forward selection and connection', () => {
    const first = tab('first');
    const second = tab('second', 'TEST-3');
    const history = visit({ back: [], forward: [] }, first, second);
    const back = travel(history, second, 'back');
    assert.equal(target(back.tab!)?.connectionId, 'first');
    assert.equal(target(back.tab!)?.key, 'TEST-2');
    const forward = travel(back.history, back.tab!, 'forward');
    assert.equal(target(forward.tab!)?.key, 'TEST-3');
  });
  it('uses selected saved results with connection-qualified identity and clears missing results', () => {
    const results = connections.map((connection) => ({
      source: {
        id: connection.id,
        connectionId: connection.id,
        rootKey: 'TEST-1',
      },
      issue: { id: 'shared', key: 'TEST-2' },
    })) as ViewResult[];
    const selected = JSON.stringify(['second', 'shared']);
    assert.equal(
      previewTarget(tab('first'), connections, true, results, selected, null)
        ?.connectionId,
      'second',
    );
    assert.equal(
      previewTarget(tab('first'), connections, true, [], selected, null),
      null,
    );
    assert.equal(
      previewTarget(tab('first'), connections, true, results, null, null),
      null,
    );
  });
  it('uses an unselected Jira root and leaves repository-only GitHub routes empty', () => {
    assert.equal(
      target({ ...tab('first'), selectedKey: undefined })?.key,
      'TEST-1',
    );
    const github: Connection = { ...connections[0], provider: 'github' };
    const repo = {
      ...tab('first'),
      rootKey: 'team/repo',
      selectedKey: undefined,
    };
    assert.equal(previewTarget(repo, [github], false, [], null, null), null);
    assert.equal(
      previewTarget(
        { ...repo, selectedKey: 'team/repo#4' },
        [github],
        false,
        [],
        null,
        null,
      )?.key,
      'team/repo#4',
    );
    assert.equal(target(null), null);
    assert.equal(previewTarget(tab('first'), [], false, [], null, null), null);
  });
});
