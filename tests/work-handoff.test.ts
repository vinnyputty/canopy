import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  parseWorkHandoff,
  parseWorkHandoffArguments,
  resolveWorkHandoff,
} from '../src/shared/work-handoff';
import { connection, workspace, snapshot } from './fixtures/work-handoff';

const url =
  'canopy://handoff/issue?connection=account-a&provider=github&host=github.com&root=team%2Frepo&key=team%2Frepo%2342';

it('parses a single bounded command and resolves the exact account and confirmed root', () => {
  const target = parseWorkHandoffArguments(['--canopy-open', url])!;
  assert.deepEqual(
    resolveWorkHandoff(
      target,
      [connection, { ...connection, id: 'account-b' }],
      workspace,
      [{ connectionId: connection.id, snapshot }],
    ),
    target,
  );
  assert.equal(parseWorkHandoffArguments([]), null);
});

it('rejects malformed, duplicate, encoded injection and unsupported fields and channels', () => {
  for (const bad of [
    url + '&token=secret',
    url + '&key=team%2Frepo%2343',
    url + '#fragment',
    url.replace('canopy:', 'https:'),
    url.replace('handoff/', 'user:secret@handoff/'),
    url.replace('github.com', 'evil.example'),
    url.replace('%2342', '%252342'),
    url.replace('account-a', 'account-a%0Acommand'),
    url.replace('team%2Frepo%2342', 'other%2Frepo%2342'),
    url.replace('/issue', '/launch'),
    url.replace('/issue', '/launch/../issue'),
    url + ' '.repeat(2048),
  ])
    assert.throws(() => parseWorkHandoff(bad), Error, bad);
  for (const args of [
    [url],
    ['--canopy-open', url, url],
    ['--canopy-open=' + url],
    ['--token', url],
  ])
    assert.throws(() => parseWorkHandoffArguments(args));
});

it('never substitutes another account, host, root or unconfirmed issue', () => {
  const target = parseWorkHandoff(url);
  const data = [{ connectionId: connection.id, snapshot }];
  assert.throws(() =>
    resolveWorkHandoff(
      target,
      [{ ...connection, id: 'account-b' }],
      workspace,
      data,
    ),
  );
  assert.throws(() =>
    resolveWorkHandoff(target, [connection, connection], workspace, data),
  );
  for (const connectionUrl of [
    'https://evil.example',
    'https://user:secret@github.com',
    'https://github.com?token=secret',
    'http://github.com',
  ])
    assert.throws(() =>
      resolveWorkHandoff(
        target,
        [{ ...connection, url: connectionUrl }],
        workspace,
        data,
      ),
    );
  assert.throws(() =>
    resolveWorkHandoff(
      target,
      [connection],
      { ...workspace, pinnedRoots: [] },
      data,
    ),
  );
  assert.throws(() => resolveWorkHandoff(target, [connection], workspace, []));
  assert.throws(() =>
    resolveWorkHandoff(target, [connection], workspace, [
      { connectionId: 'account-b', snapshot },
    ]),
  );
});

it('accepts provider-qualified Jira identity and rejects a mismatched provider', () => {
  const target = parseWorkHandoff(
    'canopy://handoff/issue?connection=jira-a&provider=jira&host=jira.example.com&root=CAN-1&key=CAN-42',
  );
  const jira = {
    ...connection,
    id: 'jira-a',
    provider: 'jira' as const,
    url: 'https://jira.example.com',
  };
  const state = {
    ...workspace,
    pinnedRoots: [{ connectionId: jira.id, rootKey: 'CAN-1' }],
  };
  const data = [
    {
      connectionId: jira.id,
      snapshot: {
        ...snapshot,
        rootKey: 'CAN-1',
        issues: [{ ...snapshot.issues[0], key: 'CAN-42' }],
      },
    },
  ];
  assert.deepEqual(resolveWorkHandoff(target, [jira], state, data), target);
  assert.throws(() =>
    resolveWorkHandoff(target, [{ ...jira, provider: 'github' }], state, data),
  );
});

it('resolves a saved view only by existing unique identity with live connections', () => {
  const target = parseWorkHandoff('canopy://handoff/view?view=triage');
  const view = {
    id: 'triage',
    name: 'Triage',
    roots: workspace.pinnedRoots!,
    connectionIds: [connection.id],
    filters: {
      assignee: 'any' as const,
      statuses: [],
      priority: '',
      hideDone: false,
    },
    sort: { column: 'key' as const, direction: 'asc' as const },
  };
  assert.deepEqual(
    resolveWorkHandoff(
      target,
      [connection],
      { ...workspace, savedViews: [view] },
      [{ connectionId: connection.id, snapshot }],
    ),
    target,
  );
  assert.throws(() =>
    resolveWorkHandoff(
      target,
      [connection],
      { ...workspace, savedViews: [view] },
      [],
    ),
  );
  assert.throws(() =>
    resolveWorkHandoff(
      target,
      [connection],
      {
        ...workspace,
        savedViews: [
          {
            ...view,
            roots: [{ connectionId: connection.id, rootKey: 'deleted/repo' }],
          },
        ],
      },
      [{ connectionId: connection.id, snapshot }],
    ),
  );
  assert.throws(() => resolveWorkHandoff(target, [connection], workspace, []));
  assert.throws(() =>
    resolveWorkHandoff(target, [], { ...workspace, savedViews: [view] }, []),
  );
  assert.throws(() =>
    resolveWorkHandoff(
      target,
      [connection],
      { ...workspace, savedViews: [view, view] },
      [],
    ),
  );
});

it('rejects entire dot segments in decoded GitHub roots and issue identities', () => {
  const payload = (root: string, key: string) =>
    `canopy://handoff/issue?connection=account-a&provider=github&host=github.com&root=${root}&key=${key}`;
  for (const owner of ['.', '..', '%2E', '%2e%2E', '%252E', '%252e%252E']) {
    for (const separator of ['/', '%2F']) {
      const repository = `${owner}${separator}repo`;
      assert.throws(() =>
        parseWorkHandoff(payload(repository, `${repository}%2342`)),
      );
      assert.throws(() =>
        parseWorkHandoff(payload('team/repo', `${repository}%2342`)),
      );
      assert.throws(() =>
        parseWorkHandoff(payload(repository, 'team/repo%2342')),
      );
    }
  }
  for (const name of ['.', '..', '%2E', '%2e%2E', '%252E', '%252e%252E']) {
    const repository = `team%2F${name}`;
    for (const root of [repository, `${repository}%237`]) {
      assert.throws(() =>
        parseWorkHandoff(payload(root, `${repository}%2342`)),
      );
    }
    assert.throws(() =>
      parseWorkHandoff(payload('team/repo', `${repository}%2342`)),
    );
  }
});

it('retains partial dotted names with matching repository and exact confirmed membership', () => {
  for (const repository of [
    'team.name/repo.name',
    '.team/repo.',
    'team/..repo',
    'team/repo..',
  ]) {
    for (const root of [repository, `${repository}#7`]) {
      const target = parseWorkHandoff(
        `canopy://handoff/issue?${new URLSearchParams({ connection: connection.id, provider: 'github', host: 'github.com', root, key: `${repository}#42` })}`,
      );
      const state = {
        ...workspace,
        pinnedRoots: [{ connectionId: connection.id, rootKey: root }],
      };
      const data = [
        {
          connectionId: connection.id,
          snapshot: {
            ...snapshot,
            rootKey: root,
            issues: [{ ...snapshot.issues[0], key: `${repository}#42` }],
          },
        },
      ];
      assert.deepEqual(
        resolveWorkHandoff(target, [connection], state, data),
        target,
      );
      assert.throws(() =>
        resolveWorkHandoff(target, [connection], workspace, [
          { connectionId: connection.id, snapshot },
        ]),
      );
    }
  }
});
