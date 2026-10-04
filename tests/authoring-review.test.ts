import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth } from '../src/main/auth';
import { GithubProvider } from '../src/main/github';
import {
  JiraAuthoring,
  editDocumentFragments,
  plainDocument,
} from '../src/main/authoring';
import { authoringAction } from '../src/shared/authoring';
import type { Connection } from '../src/shared/types';
import type { Storage } from '../src/main/storage';
import { richAuthoringFixture } from './fixtures/rich-authoring';

async function githubAuthFixture() {
  const connection: Connection = {
    id: 'disposable',
    provider: 'github',
    name: 'Fixture',
    accountName: 'author',
    url: 'https://github.com',
    repositories: ['team/a', 'team/b'],
  };
  const auth = new Auth(
    {
      readSecrets: async () => ({
        grants: [],
        accounts: [],
        githubAccounts: [{ connection, token: 'fixture-token' }],
      }),
      writeSecrets: async () => {},
    } as unknown as Storage,
    async () => {
      throw new Error('Browser forbidden');
    },
  );
  await auth.load();
  return {
    auth,
    connection,
    provider: new GithubProvider(connection, (path, init) =>
      auth.githubRequest(connection.id, path, init),
    ),
  };
}

test('real Auth and GitHub provider authoring authorize selected metadata/milestone reads and dispatch native writes', async () => {
  const { auth, provider, connection } = await githubAuthFixture();
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string }[] = [];
  const issues = new Map<string, any>([
    [
      'team/a#1',
      {
        id: 1,
        body: 'Original',
        user: { login: 'author' },
        html_url: 'https://github.com/team/a/issues/1',
        title: 'Parent',
        milestone: null,
      },
    ],
    [
      'team/b#2',
      {
        id: 2,
        body: '',
        title: 'Destination',
        html_url: 'https://github.com/team/b/issues/2',
      },
    ],
  ]);
  const parents = new Map<string, string>();
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Bearer fixture-token',
    );
    const path = parsed.pathname + parsed.search,
      method = init?.method ?? 'GET';
    calls.push({ path, method });
    if (/^\/repos\/team\/[ab]$/.test(path))
      return Response.json({ permissions: { push: true }, has_issues: true });
    if (/^\/repos\/team\/[ab]\/milestones\?state=all&per_page=100$/.test(path))
      return Response.json([{ number: 7, title: 'Release' }]);
    const match = path.match(/^\/repos\/(team\/[ab])\/issues(?:\/(\d+)(.*))?$/);
    assert.ok(match, path);
    const key = `${match[1]}#${match[2]}`,
      suffix = match[3] ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (suffix === '/parent') {
      const parent = parents.get(key);
      return parent
        ? Response.json(issues.get(parent))
        : Response.json({}, { status: 404 });
    }
    if (method === 'GET') return Response.json(issues.get(key));
    if (suffix === '/comments') return Response.json({ id: 50 });
    if (method === 'PATCH') {
      Object.assign(
        issues.get(key),
        'milestone' in body
          ? { milestone: body.milestone ? { number: body.milestone } : null }
          : body,
      );
      return Response.json(issues.get(key));
    }
    if (suffix === '/sub_issues') {
      const child = [...issues].find(
        ([, issue]) => issue.id === body.sub_issue_id,
      )!;
      parents.set(child[0], key);
      return Response.json(child[1]);
    }
    if (suffix === '/sub_issue') {
      parents.delete('team/a#1');
      return Response.json(issues.get('team/a#1'));
    }
    const child = {
      id: 3,
      body: body.body,
      title: body.title,
      html_url: 'https://github.com/team/a/issues/3',
    };
    issues.set('team/a#3', child);
    return Response.json(child);
  };
  try {
    const options = await provider.authoring.options('team/a#1');
    assert.equal(options.fields[0].choices?.[0].id, '7');
    assert.equal(
      (
        await provider.authoring.write('team/a#1', {
          kind: 'description',
          value: '**Changed**',
          revision: options.description.revision,
        })
      ).state,
      'saved',
    );
    assert.equal(
      (
        await provider.authoring.write('team/a#1', {
          kind: 'comment',
          value: 'Comment',
        })
      ).state,
      'saved',
    );
    assert.equal(
      (
        await provider.authoring.write('team/a#1', {
          kind: 'field',
          id: 'milestone',
          previous: '',
          value: '7',
        })
      ).state,
      'saved',
    );
    const plan = await provider.authoring.plan('team/a#1', 'team/b#2');
    assert.equal(
      (await provider.authoring.write('team/a#1', { kind: 'parent', plan }))
        .state,
      'saved',
    );
    assert.equal(parents.get('team/a#1'), 'team/b#2');
    const remove = await provider.authoring.plan('team/a#1', null);
    assert.equal(
      (
        await provider.authoring.write('team/a#1', {
          kind: 'parent',
          plan: remove,
        })
      ).state,
      'saved',
    );
    assert.equal(
      (
        await provider.authoring.write('team/a#1', {
          kind: 'child',
          summary: 'Child',
          description: 'Body',
        })
      ).state,
      'saved',
    );
    assert.equal(parents.get('team/a#3'), 'team/a#1');
    const count = calls.length;
    for (const [path, method] of [
      ['/repos/team/unselected', 'GET'],
      ['/repos/team/unselected/milestones?state=all&per_page=100', 'GET'],
      ['/repos/team/a', 'PATCH'],
      ['/repos/team/a/milestones?state=all&per_page=100', 'POST'],
      ['/repos/team/a/milestones/7', 'GET'],
      ['/repos/team/a/milestones?state=all&per_page=100&extra=yes', 'GET'],
      ['https://evil.example/repos/team/a', 'GET'],
      ['//evil.example/repos/team/a', 'GET'],
      ['/repos/team/a/../b', 'GET'],
    ])
      await assert.rejects(
        auth.githubRequest(connection.id, path, { method }),
        /Invalid GitHub API path|outside/,
      );
    await assert.rejects(
      provider.authoring.options('team/unselected#1'),
      /outside/,
    );
    assert.equal(calls.length, count);
    await auth.disconnect(connection.id);
    await assert.rejects(
      auth.githubRequest(connection.id, '/repos/team/a'),
      /unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validated reordered native text removals retain mentions, media, siblings and unknown properties', () => {
  const mention = { type: 'mention', attrs: { id: 'KEEP' } },
    media = { type: 'media', attrs: { id: 'MEDIA' } };
  const doc = {
    type: 'doc',
    version: 1,
    nativeFuture: 'retain',
    content: [
      {
        type: 'paragraph',
        nativeParagraph: 'retain',
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
          mention,
          media,
          { type: 'text', text: 'C', nativeText: 'retain' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'D' }, mention] },
    ],
  };
  const action = authoringAction({
    kind: 'description',
    value: '',
    revision: JSON.stringify(doc),
    fragments: [
      { id: '0.1', value: '' },
      { id: '1.0', value: '' },
      { id: '0.0', value: '' },
      { id: '0.4', value: 'Edited C' },
    ],
  });
  assert.equal(action.kind, 'description');
  if (action.kind !== 'description') return;
  const changed = editDocumentFragments(doc, action.fragments!) as typeof doc;
  assert.deepEqual(changed.content[0].content, [
    mention,
    media,
    { type: 'text', text: 'Edited C', nativeText: 'retain' },
  ]);
  assert.deepEqual(changed.content[1].content, [mention]);
  assert.equal(changed.nativeFuture, 'retain');
  assert.equal(changed.content[0].nativeParagraph, 'retain');
  assert.equal(JSON.stringify(changed).includes('"text":""'), false);
});

test('unknown properties on otherwise plain ADF route through native-preserving text edits', async () => {
  const doc = {
    type: 'doc',
    version: 1,
    nativeFuture: 'retain',
    content: [
      {
        type: 'paragraph',
        nativeParagraph: 'retain',
        content: [{ type: 'text', text: 'Original', nativeText: 'retain' }],
      },
    ],
  };
  assert.equal(plainDocument(doc), false);
  let current = structuredClone(doc);
  const author = new JiraAuthoring(async (path, init) => {
    if (path.includes('/mypermissions?'))
      return { permissions: { EDIT_ISSUES: { havePermission: true } } };
    if (path.endsWith('/editmeta'))
      return { fields: { description: { operations: ['set'] } } };
    if (init?.method === 'PUT') {
      current = JSON.parse(String(init.body)).fields.description;
      return undefined;
    }
    return { fields: { description: current } };
  });
  const options = await author.options('ABC-1');
  assert.ok(options.description.fragments);
  assert.equal(
    (
      await author.write('ABC-1', {
        kind: 'description',
        value: '',
        revision: options.description.revision,
        fragments: [{ id: '0.0', value: 'Changed' }],
      })
    ).state,
    'saved',
  );
  assert.equal(current.nativeFuture, 'retain');
  assert.equal(current.content[0].nativeParagraph, 'retain');
  assert.equal(current.content[0].content[0].nativeText, 'retain');
});

test('actual RichAuthoring reopened pane cannot acknowledge a running attempt and preserves its new draft after old settlement', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Comment draft', 'Old attempted comment');
  old.button('Post comment').onClick();
  old.render();
  old.unmount();
  const next = f.mount();
  await next.open();
  next.acknowledge();
  assert.equal(next.button('Allow a new write after review').disabled, true);
  next.button('Allow a new write after review').onClick();
  next.render();
  assert.equal(next.button('Post comment').disabled, true);
  assert.equal(next.input('Comment draft').disabled, false);
  next.change('Comment draft', 'NEW unsent draft');
  assert.equal(JSON.parse(f.storage.get(f.key())!).comment, 'NEW unsent draft');
  f.requests[0].settle({ state: 'saved', message: 'Old comment saved' });
  await f.flush();
  next.render();
  assert.equal(JSON.parse(f.storage.get(f.key())!).comment, 'NEW unsent draft');
  assert.equal(next.button('Post comment').disabled, false);
  next.unmount();
  const reopened = f.mount();
  await reopened.open();
  assert.equal(reopened.input('Comment draft').value, 'NEW unsent draft');
  reopened.unmount();
});

test('actual RichAuthoring old settlement cannot replace a newer durable pending attempt or result', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Comment draft', 'Old');
  old.button('Post comment').onClick();
  old.unmount();
  const newer = {
    comment: 'New',
    pending: 'description',
    attemptId: 'newer-attempt',
    result: { state: 'unknown', message: 'Newer outcome' },
  };
  f.storage.set(f.key(), JSON.stringify(newer));
  f.requests[0].settle({ state: 'saved', message: 'Old result' });
  await f.flush();
  assert.deepEqual(JSON.parse(f.storage.get(f.key())!), newer);
});

test('actual RichAuthoring retains equal-text edits with a new draft revision and clears unchanged completed text', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Comment draft', 'Same');
  old.button('Post comment').onClick();
  old.unmount();
  const next = f.mount();
  await next.open();
  next.change('Comment draft', 'Same');
  f.requests[0].settle({ state: 'saved', message: 'Saved original' });
  await f.flush();
  next.render();
  assert.equal(next.input('Comment draft').value, 'Same');
  next.button('Post comment').onClick();
  next.unmount();
  f.requests[1].settle({ state: 'saved', message: 'Saved new draft' });
  await f.flush();
  const reopened = f.mount();
  await reopened.open();
  assert.equal(reopened.input('Comment draft').value, '');
  reopened.unmount();
});

test('actual RichAuthoring equal description text on a newly reviewed native revision survives an old write', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Draft description', 'Same text');
  old.button('Save description').onClick();
  old.unmount();
  f.options.description = {
    editable: true,
    value: 'Provider current text',
    revision: '"new native revision"',
  };
  const next = f.mount();
  await next.open();
  next.button('I reviewed the current description; keep my draft').onClick();
  next.render();
  f.requests[0].settle({ state: 'saved', message: 'Old description saved' });
  await f.flush();
  next.render();
  assert.equal(next.input('Draft description').value, 'Same text');
  assert.equal(
    JSON.parse(f.storage.get(f.key())!).revision,
    '"new native revision"',
  );
  next.unmount();
});

test('actual RichAuthoring guards same-tick duplicate calls, account/key boundaries and persistence before dispatch', async () => {
  const f = richAuthoringFixture(),
    a = f.mount();
  await a.open();
  a.change('Comment draft', 'Account A');
  const click = a.button('Post comment').onClick;
  click();
  click();
  assert.equal(f.requests.length, 1);
  const b = f.mount('other-account');
  await b.open();
  assert.equal(b.input('Comment draft').value, '');
  b.change('Comment draft', 'Account B');
  b.button('Post comment').onClick();
  const c = f.mount('account', 'team/a#2');
  await c.open();
  assert.equal(c.input('Comment draft').value, '');
  c.change('Comment draft', 'Other key');
  c.button('Post comment').onClick();
  f.requests[0].settle({ state: 'saved', message: 'A saved' });
  f.requests[1].settle({ state: 'unknown', message: 'B uncertain' });
  f.requests[2].settle({ state: 'rejected', message: 'C rejected' });
  await f.flush();
  assert.equal(
    JSON.parse(f.storage.get(f.key('other-account'))!).comment,
    'Account B',
  );
  assert.equal(
    JSON.parse(f.storage.get(f.key('other-account'))!).pending,
    'comment',
  );
  assert.equal(
    JSON.parse(f.storage.get(f.key('account', 'team/a#2'))!).comment,
    'Other key',
  );
  a.unmount();
  b.unmount();
  c.unmount();
  const blocked = f.mount('disk-account');
  await blocked.open();
  blocked.change('Comment draft', 'Do not lose');
  f.failStorage();
  blocked.button('Post comment').onClick();
  await f.flush();
  assert.equal(f.requests.length, 3);
  blocked.unmount();
});

test('real Auth retains connection lifecycle checks around newly allowed repository reads', async () => {
  const { auth, connection } = await githubAuthFixture();
  const original = globalThis.fetch;
  let release!: (response: Response) => void;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.github.com/repos/team/a');
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  try {
    const pending = auth.githubRequest(connection.id, '/repos/team/a');
    await auth.disconnect(connection.id);
    release(Response.json({ permissions: { push: true } }));
    await assert.rejects(pending, /connection changed/);
  } finally {
    globalThis.fetch = original;
  }
});

test('actual RichAuthoring acknowledgment preserves a newer child draft after partial creation', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Sub-issue title', 'Old child');
  old.change('Sub-issue description', 'Old body');
  old.button('Create sub-issue').onClick();
  old.unmount();
  const next = f.mount();
  await next.open();
  next.change('Sub-issue title', 'NEW child draft');
  next.change('Sub-issue description', 'NEW body');
  f.requests[0].settle({
    state: 'partial',
    key: 'team/a#3',
    message: 'Old child created; link not confirmed',
  });
  await f.flush();
  next.render();
  next.acknowledge();
  assert.equal(next.button('Allow a new write after review').disabled, false);
  next.button('Allow a new write after review').onClick();
  next.render();
  assert.equal(next.input('Sub-issue title').value, 'NEW child draft');
  assert.equal(next.input('Sub-issue description').value, 'NEW body');
  assert.equal(JSON.parse(f.storage.get(f.key())!).pending, undefined);
  next.unmount();
});

test('actual RichAuthoring acknowledgment cannot clear an unreviewed newer durable result', async () => {
  const f = richAuthoringFixture(),
    pane = f.mount();
  await pane.open();
  pane.change('Comment draft', 'Old');
  pane.button('Post comment').onClick();
  f.requests[0].settle({ state: 'unknown', message: 'Old unknown' });
  await f.flush();
  pane.render();
  pane.acknowledge();
  const next = {
    comment: 'New',
    pending: 'comment',
    attemptId: 'new-id',
    result: { state: 'partial', message: 'New unreviewed result' },
  };
  f.storage.set(f.key(), JSON.stringify(next));
  pane.button('Allow a new write after review').onClick();
  assert.deepEqual(JSON.parse(f.storage.get(f.key())!), next);
  pane.unmount();
});

test('actual RichAuthoring recovers a durable pending marker in a new renderer process without replaying it', async () => {
  const oldProcess = richAuthoringFixture(),
    pane = oldProcess.mount();
  await pane.open();
  pane.change('Comment draft', 'Pending before restart');
  pane.button('Post comment').onClick();
  pane.unmount();
  const newProcess = richAuthoringFixture();
  for (const [key, value] of oldProcess.storage)
    newProcess.storage.set(key, value);
  const restored = newProcess.mount();
  await restored.open();
  assert.equal(restored.input('Comment draft').value, 'Pending before restart');
  assert.equal(restored.button('Post comment').disabled, true);
  assert.equal(newProcess.requests.length, 0);
  restored.acknowledge();
  assert.equal(
    restored.button('Allow a new write after review').disabled,
    false,
  );
  restored.button('Allow a new write after review').onClick();
  restored.render();
  assert.equal(restored.input('Comment draft').value, 'Pending before restart');
  assert.equal(restored.button('Post comment').disabled, false);
  restored.unmount();
});

test('actual RichAuthoring requires provider acknowledgment after the running attempt settles as unknown', async () => {
  const f = richAuthoringFixture(),
    old = f.mount();
  await old.open();
  old.change('Comment draft', 'Attempt');
  old.button('Post comment').onClick();
  old.unmount();
  const next = f.mount();
  await next.open();
  next.acknowledge();
  assert.equal(next.button('Allow a new write after review').disabled, true);
  f.requests[0].settle({
    state: 'unknown',
    message: 'Check the final provider outcome',
  });
  await f.flush();
  next.render();
  assert.equal(next.button('Allow a new write after review').disabled, true);
  next.acknowledge();
  assert.equal(next.button('Allow a new write after review').disabled, false);
  next.unmount();
});

function reorderedKeys(value: any): any {
  return Array.isArray(value)
    ? value.map(reorderedKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reorderedKeys(child)]),
        )
      : value;
}

function jiraDescriptionFixture(document: any) {
  let current = structuredClone(document);
  const writes: RequestInit[] = [];
  let readback = (value: any) => value;
  let writeError: Error | undefined;
  const author = new JiraAuthoring(async (path, init) => {
    if (path.includes('/mypermissions?'))
      return {
        permissions: {
          EDIT_ISSUES: { havePermission: true },
          ADD_COMMENTS: { havePermission: true },
        },
      };
    if (path.endsWith('/editmeta'))
      return { fields: { description: { operations: ['set'] } } };
    if (init?.method === 'PUT' || init?.method === 'POST') {
      writes.push(init);
      if (writeError) throw writeError;
      current = readback(JSON.parse(String(init.body)).fields.description);
      return undefined;
    }
    return { fields: { description: structuredClone(current) } };
  });
  return {
    author,
    writes,
    current: () => current,
    replace: (value: any) => {
      current = structuredClone(value);
    },
    readback: (fn: (value: any) => any) => {
      readback = fn;
    },
    failWrite: () => {
      writeError = new Error('Transport lost after sending');
    },
  };
}

function nativeDescription() {
  return {
    type: 'doc',
    version: 1,
    nativeFuture: { z: [null, false, 0, '  exact\n'], a: { z: 2, a: 1 } },
    content: [
      {
        type: 'paragraph',
        attrs: { z: 'native', a: 'paragraph' },
        content: [
          {
            type: 'text',
            text: 'A',
            marks: [
              {
                type: 'link',
                attrs: { href: 'https://example.test', title: 'A' },
              },
              { type: 'strong' },
            ],
          },
          { type: 'text', text: 'B' },
          { type: 'mention', attrs: { id: 'fixture', text: '@Fixture' } },
          { type: 'media', attrs: { id: 'media', type: 'file' } },
        ],
      },
    ],
  };
}

for (const rich of [false, true]) {
  test(`Jira ${rich ? 'rich' : 'plain'} descriptions ignore nested object key order on preflight and readback`, async () => {
    const document = rich
      ? nativeDescription()
      : {
          type: 'doc',
          version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
          ],
        };
    const f = jiraDescriptionFixture(document);
    const options = await f.author.options('ABC-1');
    f.replace(reorderedKeys(document));
    assert.equal(
      (await f.author.options('ABC-1')).description.revision,
      options.description.revision,
    );
    f.readback(reorderedKeys);
    const result = await f.author.write('ABC-1', {
      kind: 'description',
      value: '  Changed\nexact  ',
      revision: options.description.revision,
      ...(rich
        ? {
            fragments: options.description.fragments!.map((fragment) => ({
              ...fragment,
              value: `${fragment.value} edited`,
            })),
          }
        : {}),
    });
    assert.equal(result.state, 'saved');
    assert.equal(f.writes.length, 1);
    if (rich) {
      const expected = editDocumentFragments(
        document,
        options.description.fragments!.map((fragment) => ({
          ...fragment,
          value: `${fragment.value} edited`,
        })),
      );
      assert.deepEqual(f.current(), expected);
    }
  });
}

const nativeDifferences: [string, (document: any) => void][] = [
  [
    'text whitespace',
    (doc) => {
      doc.content[0].content[0].text += ' ';
    },
  ],
  [
    'content array order',
    (doc) => {
      doc.content[0].content.reverse();
    },
  ],
  [
    'mark array order',
    (doc) => {
      doc.content[0].content[0].marks.reverse();
    },
  ],
  [
    'attrs',
    (doc) => {
      doc.content[0].attrs.z = 'changed';
    },
  ],
  [
    'unknown native values',
    (doc) => {
      doc.nativeFuture.z[1] = true;
    },
  ],
];
for (const [name, mutate] of nativeDifferences) {
  test(`Jira description ${name} changes remain conflicts and partial readbacks`, async () => {
    const document = nativeDescription();
    const f = jiraDescriptionFixture(document);
    const options = await f.author.options('ABC-1');
    const action = {
      kind: 'description' as const,
      value: '',
      revision: options.description.revision,
      fragments: options.description.fragments!,
    };
    const changed = structuredClone(document);
    mutate(changed);
    f.replace(changed);
    assert.equal((await f.author.write('ABC-1', action)).state, 'rejected');
    assert.equal(f.writes.length, 0);
    f.replace(document);
    f.readback((value) => {
      mutate(value);
      return reorderedKeys(value);
    });
    assert.equal((await f.author.write('ABC-1', action)).state, 'partial');
    assert.equal(f.writes.length, 1);
  });
}

test('Jira uncertain description and comment transports perform one write without replay', async () => {
  for (const kind of ['description', 'comment'] as const) {
    const f = jiraDescriptionFixture(null);
    const options = await f.author.options('ABC-1');
    f.failWrite();
    assert.equal(
      (
        await f.author.write('ABC-1', {
          kind,
          value: 'Uncertain',
          revision: options.description.revision,
        })
      ).state,
      'unknown',
    );
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].method, kind === 'comment' ? 'POST' : 'PUT');
  }
});

async function refreshDescription(
  f: ReturnType<typeof richAuthoringFixture>,
  pane: ReturnType<ReturnType<typeof richAuthoringFixture>['mount']>,
) {
  pane.button('Refresh authoring options').onClick();
  pane.render();
  await f.flush();
  pane.render();
}

const acceptDescription = 'I reviewed the current description; keep my draft';

test('actual RichAuthoring edits added runs, retains removed drafts until review and submits current IDs to Jira after restart', async () => {
  const jira = jiraDescriptionFixture(nativeDescription());
  const f = richAuthoringFixture();
  f.options.description = (await jira.author.options('ABC-1')).description;
  const pane = f.mount('account', 'ABC-1', 'jira');
  await pane.open();
  pane.change('Description text run 1', 'Draft A');
  pane.change('Description text run 2', 'Removed draft B');
  pane.change('Comment draft', 'Other comment');
  pane.change('Sub-issue title', 'Other child');
  const changed = nativeDescription();
  changed.content[0].content.splice(1, 1);
  changed.content[0].content.push({ type: 'text', text: 'New run' } as any);
  jira.replace(changed);
  f.options.description = (await jira.author.options('ABC-1')).description;
  await refreshDescription(f, pane);
  assert.equal(pane.button('Save description').disabled, true);
  assert.match(pane.text(), /Removed draft B/);
  pane.change('Description text run 2', 'Draft new run');
  assert.equal(pane.input('Description text run 2').value, 'Draft new run');
  assert.equal(f.requests.length, 0);
  assert.match(
    JSON.parse(f.storage.get(f.key('account', 'ABC-1'))!).fragments,
    /Removed draft B/,
  );
  pane.unmount();
  const reopened = f.mount('account', 'ABC-1', 'jira');
  await reopened.open();
  assert.equal(reopened.input('Description text run 1').value, 'Draft A');
  assert.equal(reopened.input('Description text run 2').value, 'Draft new run');
  assert.match(reopened.text(), /acceptance removes them/);
  reopened.button(acceptDescription).onClick();
  reopened.render();
  assert.equal(f.requests.length, 0);
  const draft = JSON.parse(f.storage.get(f.key('account', 'ABC-1'))!);
  assert.equal(draft.comment, 'Other comment');
  assert.equal(draft.childSummary, 'Other child');
  assert.deepEqual(JSON.parse(draft.fragments), [
    { id: '0.0', value: 'Draft A' },
    { id: '0.3', value: 'Draft new run' },
  ]);
  assert.equal(reopened.button('Save description').disabled, false);
  reopened.button('Save description').onClick();
  assert.equal(f.requests.length, 1);
  const result = await jira.author.write('ABC-1', f.requests[0].action);
  assert.equal(result.state, 'saved');
  f.requests[0].settle(result);
  await f.flush();
  reopened.render();
  assert.equal(jira.writes.length, 1);
  assert.deepEqual(jira.current().content[0].attrs, changed.content[0].attrs);
  assert.deepEqual(
    jira.current().content[0].content[1],
    changed.content[0].content[1],
  );
  reopened.unmount();
});

test('actual RichAuthoring keeps matching drafts after same-ID native changes and old write settlement', async () => {
  const jira = jiraDescriptionFixture(nativeDescription());
  const f = richAuthoringFixture();
  f.options.description = (await jira.author.options('ABC-1')).description;
  const old = f.mount();
  await old.open();
  old.change('Description text run 1', 'Draft A');
  old.button('Save description').onClick();
  old.unmount();
  const changed = nativeDescription();
  changed.content[0].attrs.z = 'new native attribute';
  jira.replace(changed);
  f.options.description = (await jira.author.options('ABC-1')).description;
  const pane = f.mount();
  await pane.open();
  assert.match(pane.text(), /provider description changed/);
  assert.equal(pane.button('Save description').disabled, true);
  pane.button(acceptDescription).onClick();
  pane.render();
  f.requests[0].settle({ state: 'saved', message: 'Old write saved' });
  await f.flush();
  pane.render();
  assert.equal(pane.input('Description text run 1').value, 'Draft A');
  assert.equal(
    JSON.parse(f.storage.get(f.key())!).revision,
    f.options.description.revision,
  );
  pane.unmount();
  const reopened = f.mount();
  await reopened.open();
  assert.equal(reopened.input('Description text run 1').value, 'Draft A');
  assert.equal(reopened.button('Save description').disabled, false);
  reopened.unmount();
});

for (const toRich of [false, true]) {
  test(`actual RichAuthoring recovers ${toRich ? 'plain to rich' : 'rich to plain'} transitions after explicit review without flattening native content`, async () => {
    const plain = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Plain current' }],
        },
      ],
    };
    const jira = jiraDescriptionFixture(toRich ? plain : nativeDescription());
    const f = richAuthoringFixture();
    f.options.description = (await jira.author.options('ABC-1')).description;
    const pane = f.mount();
    await pane.open();
    pane.change(
      toRich ? 'Draft description' : 'Description text run 1',
      'Incompatible saved text',
    );
    const before = JSON.parse(f.storage.get(f.key())!);
    jira.replace(toRich ? nativeDescription() : plain);
    f.options.description = (await jira.author.options('ABC-1')).description;
    await refreshDescription(f, pane);
    assert.deepEqual(JSON.parse(f.storage.get(f.key())!), before);
    assert.match(pane.text(), /Incompatible saved text/);
    assert.match(pane.text(), /Copy them before accepting/);
    assert.equal(pane.button('Save description').disabled, true);
    pane.change(
      toRich ? 'Description text run 1' : 'Draft description',
      'Reviewed edit',
    );
    assert.equal(f.requests.length, 0);
    pane.button(acceptDescription).onClick();
    pane.render();
    assert.equal(pane.button('Save description').disabled, false);
    const draft = JSON.parse(f.storage.get(f.key())!);
    assert.equal(toRich ? draft.description : draft.fragments, undefined);
    pane.button('Save description').onClick();
    const result = await jira.author.write('ABC-1', f.requests[0].action);
    assert.equal(result.state, 'saved');
    assert.equal(jira.writes.length, 1);
    if (toRich)
      assert.deepEqual(
        jira.current().nativeFuture,
        nativeDescription().nativeFuture,
      );
    f.requests[0].settle(result);
    await f.flush();
    pane.unmount();
  });
}

for (const keepMatching of [false, true]) {
  test(`actual RichAuthoring retains a bounded full draft and enables added runs after review (matching=${keepMatching})`, async () => {
    const f = richAuthoringFixture();
    f.options.description = {
      editable: true,
      value: 'Old 500 runs',
      revision: '"old"',
      fragments: Array.from({ length: 500 }, (_, i) => ({
        id: `0.${i}`,
        value: `Old ${i}`,
      })),
    };
    const pane = f.mount();
    await pane.open();
    pane.change('Description text run 1', 'Saved first run');
    f.options.description = {
      editable: true,
      value: 'Current runs',
      revision: '"current"',
      fragments: [
        ...(keepMatching ? [{ id: '0.0', value: 'Current first' }] : []),
        { id: '1.0', value: 'Added run' },
      ],
    };
    await refreshDescription(f, pane);
    const newLabel = `Description text run ${keepMatching ? 2 : 1}`;
    assert.equal(pane.input(newLabel).disabled, true);
    assert.match(
      pane.text(),
      /Review the current description before editing added runs/,
    );
    const before = f.storage.get(f.key());
    // The handler also refuses an over-limit edit if called outside DOM disabling.
    pane.change(newLabel, 'Attempted added edit');
    assert.equal(f.storage.get(f.key()), before);
    assert.equal(pane.button(acceptDescription).disabled, false);
    if (keepMatching) {
      assert.equal(pane.input('Description text run 1').disabled, false);
      pane.change('Description text run 1', 'Matching edit');
      assert.equal(
        JSON.parse(JSON.parse(f.storage.get(f.key())!).fragments).length,
        500,
      );
    }
    assert.equal(f.requests.length, 0);
    pane.unmount();
    const reopened = f.mount();
    await reopened.open();
    assert.equal(reopened.button(acceptDescription).disabled, false);
    assert.match(reopened.text(), /Old 499/);
    reopened.button(acceptDescription).onClick();
    reopened.render();
    assert.equal(reopened.input(newLabel).disabled, false);
    reopened.change(newLabel, 'Reviewed added edit');
    const draft = JSON.parse(f.storage.get(f.key())!);
    assert.deepEqual(JSON.parse(draft.fragments), [
      ...(keepMatching ? [{ id: '0.0', value: 'Matching edit' }] : []),
      { id: '1.0', value: 'Reviewed added edit' },
    ]);
    assert.equal(reopened.button('Save description').disabled, false);
    reopened.button('Save description').onClick();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].action)), {
      kind: 'description',
      value: '',
      revision: '"current"',
      fragments: JSON.parse(draft.fragments),
    });
    f.requests[0].settle({ state: 'rejected', message: 'Controlled end' });
    await f.flush();
    reopened.unmount();
  });
}
