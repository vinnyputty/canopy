import { JiraProvider } from '../src/main/jira';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GithubAuthoring,
  JiraAuthoring,
  documentFragments,
  editDocumentFragments,
  githubAttachments,
  plainDocument,
  textDocument,
  writeFailure,
} from '../src/main/authoring';
import { authoringAction } from '../src/shared/authoring';
import { GithubProvider, githubKey } from '../src/main/github';
import {
  draftKey,
  loadDraft,
  saveDraft,
} from '../src/renderer/authoring-drafts';

function githubFixture() {
  const issues = new Map<number, any>(
    [1, 2, 3].map((number) => [
      number,
      {
        id: number,
        number,
        html_url: `https://github.com/team/a/issues/${number}`,
        title: `Issue ${number}`,
        body: 'Original **Markdown**',
        user: { login: 'author' },
        milestone: null,
      },
    ]),
  );
  const parents = new Map<number, number>([[2, 1]]);
  const calls: { path: string; method: string; body?: any }[] = [];
  let permission: any = { push: true };
  let fail: string | undefined;
  let unknown = false;
  const request = async (path: string, init?: RequestInit): Promise<any> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === '/repos/team/a')
      return { permissions: permission, has_issues: true };
    if (path.includes('/milestones?')) return [{ number: 7, title: 'Release' }];
    if (method !== 'GET' && fail === path)
      throw new Error('GitHub returned 422. Invalid hierarchy.');
    if (path === '/repos/team/a/issues' && method === 'POST') {
      const raw = {
        ...issues.get(1),
        id: 4,
        number: 4,
        html_url: 'https://github.com/team/a/issues/4',
        title: body.title,
        body: body.body,
      };
      issues.set(4, raw);
      if (unknown) throw new Error('Connection reset after commit');
      return raw;
    }
    const match = path.match(/\/issues\/(\d+)(.*)/)!;
    if (!match) throw new Error(`Unexpected ${path}`);
    const number = Number(match[1]),
      suffix = match[2];
    if (suffix === '/parent') {
      const parent = parents.get(number);
      if (!parent)
        throw Object.assign(new Error('GitHub denied access to parent.'), {
          status: 404,
        });
      return issues.get(parent);
    }
    if (method === 'GET') return structuredClone(issues.get(number));
    if (suffix === '/sub_issues') {
      parents.set(body.sub_issue_id, number);
      return issues.get(body.sub_issue_id);
    }
    if (suffix === '/sub_issue') {
      parents.delete(body.sub_issue_id);
      return issues.get(body.sub_issue_id);
    }
    if (suffix === '/comments') {
      if (unknown) throw new Error('Lost response after posting');
      return { id: 100 };
    }
    const current = issues.get(number);
    if ('body' in body) current.body = body.body;
    if ('milestone' in body && permission.push)
      current.milestone = body.milestone ? { number: body.milestone } : null;
    return structuredClone(current);
  };
  const author = new GithubAuthoring(
    request,
    (key, suffix = '') => {
      key = githubKey(key);
      if (!key.startsWith('team/a#'))
        throw new Error('Outside selected repository');
      return `/repos/team/a/issues/${key.split('#')[1]}${suffix}`;
    },
    githubKey,
    'author',
  );
  return {
    author,
    request,
    issues,
    parents,
    calls,
    setPermission: (value: any) => {
      permission = value;
    },
    failAt: (path: string) => {
      fail = path;
    },
    loseResponse: () => {
      unknown = true;
    },
  };
}

test('GitHub preserves Markdown and checks description revisions before writing', async () => {
  const f = githubFixture();
  const options = await f.author.options('team/a#1');
  const value =
    '<script>alert(1)</script>\n**Bold**\n[link](javascript:evil)\n';
  const result = await f.author.write('team/a#1', {
    kind: 'description',
    value,
    revision: options.description.revision,
  });
  assert.equal(result.state, 'saved');
  assert.equal(f.issues.get(1).body, value);
  const stale = await f.author.write('team/a#1', {
    kind: 'description',
    value: 'stale',
    revision: options.description.revision,
  });
  assert.equal(stale.state, 'rejected');
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
});

test('GitHub sub-issue creation uses the numeric ID and preserves a created key after a failed link', async () => {
  const f = githubFixture();
  f.failAt('/repos/team/a/issues/1/sub_issues');
  const result = await f.author.write('team/a#1', {
    kind: 'child',
    summary: 'Child',
    description: '**Body**',
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.key, 'team/a#4');
  assert.equal(f.issues.get(4).body, '**Body**');
  assert.equal(
    f.calls.filter(
      (call) => call.path === '/repos/team/a/issues' && call.method === 'POST',
    ).length,
    1,
  );
  assert.match(result.message, /do not create another/);
});

test('GitHub creates and links sub-issues and recovers partial creation by moving the existing key', async () => {
  const f = githubFixture();
  const result = await f.author.write('team/a#1', {
    kind: 'child',
    summary: 'Child',
    description: '',
  });
  assert.equal(result.state, 'saved');
  assert.equal(f.parents.get(4), 1);
  const plan = await f.author.plan('team/a#4', 'team/a#3');
  assert.match(plan.effects.join(' '), /leaves the child list of team\/a#1/);
  assert.match(plan.effects.join(' '), /descendants remain attached/);
  const moved = await f.author.write('team/a#4', { kind: 'parent', plan });
  assert.equal(moved.state, 'saved');
  assert.equal(f.parents.get(4), 3);
  assert.deepEqual(
    f.calls.find(
      (call) =>
        call.path === '/repos/team/a/issues/3/sub_issues' &&
        call.method === 'POST',
    )?.body,
    { sub_issue_id: 4, replace_parent: true },
  );
  const remove = await f.author.plan('team/a#4', null);
  assert.equal(
    (await f.author.write('team/a#4', { kind: 'parent', plan: remove })).state,
    'saved',
  );
  assert.equal(f.parents.has(4), false);
});

test('GitHub refuses cycles, stale plans, pull requests, and account/repository boundary crossings without writes', async () => {
  const f = githubFixture();
  await assert.rejects(f.author.plan('team/a#1', 'team/a#2'), /cycle/);
  const plan = await f.author.plan('team/a#2', 'team/a#3');
  f.parents.delete(2);
  assert.equal(
    (await f.author.write('team/a#2', { kind: 'parent', plan })).state,
    'rejected',
  );
  await assert.rejects(
    f.author.plan('team/a#2', 'team/b#1'),
    /Outside selected/,
  );
  f.issues.get(1).pull_request = {};
  await assert.rejects(f.author.options('team/a#1'), /Pull requests/);
  assert.equal(
    f.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('GitHub eligibility requires confirmed repository access; locked comments and push-only fields are gated', async () => {
  const f = githubFixture();
  f.setPermission({ pull: true });
  f.issues.get(1).locked = true;
  const options = await f.author.options('team/a#1');
  assert.equal(options.description.editable, true); // authenticated author can edit their own issue
  assert.equal(options.comment.allowed, false);
  assert.equal(options.parent.allowed, false);
  assert.equal(options.createChild, false);
  assert.deepEqual(options.fields, []);
  assert.equal(
    (await f.author.write('team/a#1', { kind: 'comment', value: 'no' })).state,
    'rejected',
  );
  f.issues.get(1).user.login = 'someone-else';
  assert.equal(
    (await f.author.options('team/a#1')).description.editable,
    false,
  );
});

test('GitHub token selection is enforced by the production provider authoring adapter', async () => {
  const paths: string[] = [];
  const provider = new GithubProvider(
    {
      id: 'account',
      name: 'GitHub',
      url: 'https://github.com',
      provider: 'github',
      repositories: ['team/a'],
    },
    async (path) => {
      paths.push(path);
      return {};
    },
  );
  await assert.rejects(
    provider.authoring.options('team/b#1'),
    /outside this GitHub connection/,
  );
  assert.deepEqual(paths, []);
});

test('GitHub unknown POST responses are reported without automatic retries', async () => {
  const f = githubFixture();
  f.loseResponse();
  assert.equal(
    (await f.author.write('team/a#1', { kind: 'comment', value: 'Comment' }))
      .state,
    'unknown',
  );
  assert.equal(
    (
      await f.author.write('team/a#1', {
        kind: 'child',
        summary: 'Created',
        description: '',
      })
    ).state,
    'unknown',
  );
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(f.issues.has(4), true);
});

function jiraFixture() {
  const issues = new Map<string, any>(
    ['ABC-1', 'ABC-2', 'ABC-3'].map((key, index) => [
      key,
      {
        id: String(index + 1),
        key,
        fields: {
          project: { id: 'p', name: 'Project' },
          issuetype: { id: index === 0 ? 'epic' : 'task' },
          summary: key,
          description: textDocument('Original'),
          ...(index === 1 ? { parent: { key: 'ABC-1' } } : {}),
          labels: [],
          duedate: null,
          components: [],
          fixVersions: [],
          attachment: [
            {
              id: '10',
              filename: 'spec.pdf',
              size: 100,
              content: 'https://example.atlassian.net/file',
            },
          ],
        },
      },
    ]),
  );
  const calls: { path: string; method: string; body?: any }[] = [];
  let edit = true,
    comment = true,
    verifyFail = false,
    committed = false,
    failWrite = false;
  const metadata: any = {
    fields: Object.fromEntries(
      [
        'description',
        'parent',
        'labels',
        'duedate',
        'components',
        'fixVersions',
      ].map((id) => [
        id,
        {
          name: id,
          operations: ['set'],
          allowedValues: [
            { id: 'a', name: 'Alpha' },
            { id: 'b', name: 'Beta' },
          ],
        },
      ]),
    ),
  };
  const request = async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path.includes('/mypermissions?'))
      return {
        permissions: {
          EDIT_ISSUES: { havePermission: edit },
          ADD_COMMENTS: { havePermission: comment },
        },
      };
    if (path.startsWith('/rest/api/3/issuetype/'))
      return {
        hierarchyLevel: path.endsWith('epic')
          ? 1
          : path.endsWith('subtask')
            ? -1
            : 0,
      };
    const key = path.match(/\/issue\/(ABC-\d+)/)?.[1];
    if (!key) throw new Error(`Unexpected ${path}`);
    if (path.endsWith('/editmeta')) return metadata;
    if (method === 'GET') {
      if (verifyFail && committed)
        throw new Error('Read temporarily unavailable');
      return structuredClone(issues.get(key));
    }
    if (failWrite) throw new Error('Jira returned 403. Edit forbidden.');
    if (path.endsWith('/comment')) return { id: '88' };
    committed = true;
    Object.assign(issues.get(key).fields, body.fields);
    if (body.update?.parent?.[0]?.set?.none)
      delete issues.get(key).fields.parent;
    return undefined;
  };
  return {
    author: new JiraAuthoring(request),
    request,
    issues,
    calls,
    metadata,
    denyEdit: () => {
      edit = false;
    },
    denyComment: () => {
      comment = false;
    },
    failVerification: () => {
      verifyFail = true;
    },
    failWrite: () => {
      failWrite = true;
    },
  };
}

test('Jira descriptions and comments are ADF text, including literal HTML and line breaks', async () => {
  const f = jiraFixture();
  const options = await f.author.options('ABC-2');
  const value = '<b>literal</b>\nline\n\nsecond';
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'description',
        value,
        revision: options.description.revision,
      })
    ).state,
    'saved',
  );
  assert.deepEqual(
    f.issues.get('ABC-2').fields.description,
    textDocument(value),
  );
  assert.equal(
    (await f.author.write('ABC-2', { kind: 'comment', value })).state,
    'saved',
  );
  assert.deepEqual(f.calls.at(-1)?.body, { body: textDocument(value) });
});

test('Jira rich description text edits preserve marks, mentions, media, and unknown nodes', async () => {
  const f = jiraFixture();
  const document = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Title', marks: [{ type: 'strong' }] }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: 'user' } },
          {
            type: 'text',
            text: 'Before',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      },
      {
        type: 'mediaSingle',
        content: [{ type: 'media', attrs: { id: 'media' } }],
      },
      { type: 'futureNode', attrs: { secret: 'retained' } },
    ],
  };
  f.issues.get('ABC-2').fields.description = document;
  const options = await f.author.options('ABC-2');
  assert.equal(options.description.editable, true);
  const fragments = options.description.fragments!.map((item) => ({
    ...item,
    value: item.value === 'Title' ? 'New title' : '',
  }));
  const result = await f.author.write('ABC-2', {
    kind: 'description',
    value: '',
    revision: options.description.revision,
    fragments,
  });
  assert.equal(result.state, 'saved');
  const current = f.issues.get('ABC-2').fields.description;
  assert.deepEqual(
    current.content[0].content[0].marks,
    document.content[0].content?.[0].marks,
  );
  assert.deepEqual(current.content[1].content, [
    document.content[1].content?.[0],
  ]);
  assert.deepEqual(current.content.slice(2), document.content.slice(2));
  assert.throws(
    () => editDocumentFragments(document, [{ id: '500', value: 'x' }]),
    /fragments changed/,
  );
  assert.throws(
    () =>
      editDocumentFragments(
        document,
        documentFragments(document).map((item) => ({ ...item, value: '\0' })),
      ),
    /invalid text/,
  );
});

test('Jira rich descriptions cannot be flattened and unsupported documents have a browser handoff', async () => {
  const f = jiraFixture();
  f.issues.get('ABC-2').fields.description = {
    type: 'doc',
    version: 1,
    content: [{ type: 'media', attrs: { id: 'x' } }],
  };
  const options = await f.author.options('ABC-2');
  assert.equal(options.description.editable, false);
  assert.match(options.description.reason!, /Jira/);
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'description',
        value: 'flatten',
        revision: options.description.revision,
      })
    ).state,
    'rejected',
  );
  assert.equal(
    plainDocument({
      type: 'doc',
      content: [{ type: 'text', text: 'x', marks: [{ type: 'strong' }] }],
    }),
    false,
  );
});

test('Jira metadata and permissions govern authoring fields and comment access', async () => {
  const f = jiraFixture();
  delete f.metadata.fields.duedate;
  let options = await f.author.options('ABC-2');
  assert.equal(
    options.fields.some((field) => field.id === 'duedate'),
    false,
  );
  assert.deepEqual(options.attachments[0], {
    id: '10',
    name: 'spec.pdf',
    size: 100,
    url: 'https://example.atlassian.net/file',
  });
  f.denyEdit();
  f.denyComment();
  options = await f.author.options('ABC-2');
  assert.equal(options.description.editable, false);
  assert.equal(options.parent.allowed, false);
  assert.equal(options.comment.allowed, false);
  assert.deepEqual(options.fields, []);
  assert.equal(
    (await f.author.write('ABC-2', { kind: 'comment', value: 'x' })).state,
    'rejected',
  );
  assert.equal(
    f.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('Jira fields validate allowed choices, concurrent values, and labels', async () => {
  const f = jiraFixture();
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'field',
        id: 'components',
        previous: '',
        value: 'a,b',
      })
    ).state,
    'saved',
  );
  assert.deepEqual(f.issues.get('ABC-2').fields.components, [
    { id: 'a' },
    { id: 'b' },
  ]);
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'field',
        id: 'components',
        previous: 'a,b',
        value: 'evil',
      })
    ).state,
    'rejected',
  );
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'field',
        id: 'labels',
        previous: '',
        value: 'bad label',
      })
    ).state,
    'rejected',
  );
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'field',
        id: 'labels',
        previous: '',
        value: 'one, two, one',
      })
    ).state,
    'saved',
  );
  assert.equal(
    (
      await f.author.write('ABC-2', {
        kind: 'field',
        id: 'labels',
        previous: '',
        value: 'stale',
      })
    ).state,
    'rejected',
  );
});

test('Jira eligible parent changes have concrete effects and enforce type/project/ancestry and preview freshness', async () => {
  const f = jiraFixture();
  f.issues.get('ABC-3').fields.issuetype.id = 'epic';
  const plan = await f.author.plan('ABC-2', 'ABC-3');
  assert.match(plan.effects.join(' '), /ABC-2.*ABC-1 → ABC-3/);
  assert.equal(
    (await f.author.write('ABC-2', { kind: 'parent', plan })).state,
    'saved',
  );
  assert.equal(f.issues.get('ABC-2').fields.parent.key, 'ABC-3');
  assert.equal(
    (await f.author.write('ABC-2', { kind: 'parent', plan })).state,
    'rejected',
  );
  f.issues.get('ABC-3').fields.parent = { key: 'ABC-2' };
  await assert.rejects(f.author.plan('ABC-3', 'ABC-1'), /hierarchy level/);
  f.issues.get('ABC-1').fields.parent = { key: 'ABC-2' };
  await assert.rejects(f.author.plan('ABC-2', 'ABC-1'), /cycle/);
  f.issues.get('ABC-1').fields.project.id = 'other';
  await assert.rejects(f.author.plan('ABC-2', 'ABC-1'), /Cross-project moves/);
  f.issues.get('ABC-2').fields.issuetype.id = 'subtask';
  await assert.rejects(f.author.plan('ABC-2', null), /Subtasks require/);
});

test('Jira standard parent removal uses the documented parent none operation', async () => {
  const f = jiraFixture();
  const plan = await f.author.plan('ABC-2', null);
  assert.equal(
    (await f.author.write('ABC-2', { kind: 'parent', plan })).state,
    'saved',
  );
  assert.deepEqual(f.calls.find((call) => call.method === 'PUT')?.body, {
    fields: {},
    update: { parent: [{ set: { none: true } }] },
  });
  assert.equal(f.issues.get('ABC-2').fields.parent, undefined);
});

test('Jira successful writes with failed readback are partial, permission failures are rejected', async () => {
  const f = jiraFixture();
  const options = await f.author.options('ABC-2');
  f.failVerification();
  const result = await f.author.write('ABC-2', {
    kind: 'description',
    value: 'Saved',
    revision: options.description.revision,
  });
  assert.equal(result.state, 'partial');
  assert.match(result.message, /accepted the write/);
  const g = jiraFixture();
  const base = await g.author.options('ABC-2');
  g.failWrite();
  assert.equal(
    (
      await g.author.write('ABC-2', {
        kind: 'description',
        value: 'No',
        revision: base.description.revision,
      })
    ).state,
    'rejected',
  );
});

test('write failures distinguish explicit rejection from unconfirmed server/transport/account-change outcomes', () => {
  for (const error of [
    new Error('Network reset'),
    new Error('GitHub returned 500'),
    new Error('This connection changed. Try again.'),
  ])
    assert.equal(writeFailure(error).state, 'unknown');
  for (const error of [
    Object.assign(new Error('Denied'), { status: 403 }),
    new Error('Jira returned 422'),
    new Error('GitHub rate limit reached.'),
  ])
    assert.equal(writeFailure(error).state, 'rejected');
});

test('authoring IPC rejects malformed text and does not accept provider documents or unknown actions', () => {
  for (const input of [
    { kind: 'delete' },
    { kind: 'comment', value: ' ' },
    { kind: 'description', value: {}, revision: 'x' },
    { kind: 'comment', value: '\0' },
    { kind: 'parent', plan: {} },
  ])
    assert.throws(() => authoringAction(input));
  assert.deepEqual(
    authoringAction({
      kind: 'description',
      value: '\n  exact\n',
      revision: 'x',
    }),
    { kind: 'description', value: '\n  exact\n', revision: 'x' },
  );
});

test('attachment discovery exposes only GitHub hosted assets and does not turn Markdown links into arbitrary downloads', () => {
  const body =
    '[x](https://github.com/user-attachments/assets/123) https://user-images.githubusercontent.com/1/image.png https://evil.example/file javascript:alert(1)';
  assert.equal(githubAttachments(body).length, 2);
});

test('durable drafts retain revision and uncertain-write recovery across restart and isolate account/key boundaries', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const draft = {
    description: 'Draft',
    revision: 'base',
    comment: 'Comment',
    pending: 'comment',
    result: { state: 'unknown' as const, message: 'Check provider' },
  };
  saveDraft(storage, 'account-a', 'ABC-1', draft);
  assert.deepEqual(loadDraft(storage, 'account-a', 'ABC-1'), draft);
  assert.deepEqual(loadDraft(storage, 'account-b', 'ABC-1'), {});
  assert.deepEqual(loadDraft(storage, 'account-a', 'ABC-2'), {});
  assert.notEqual(draftKey('a:b', 'c'), draftKey('a', 'b:c'));
  saveDraft(storage, 'account-a', 'ABC-1', {});
  assert.deepEqual(loadDraft(storage, 'account-a', 'ABC-1'), {});
  assert.throws(
    () =>
      saveDraft(
        {
          ...storage,
          setItem: () => {
            throw new Error('Disk full');
          },
        },
        'a',
        'b',
        draft,
      ),
    /Disk full/,
  );
});

test('Jira multiline code text edits retain the code block and native marks', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'one\ntwo' }],
      },
    ],
  };
  const result = editDocumentFragments(doc, [
    { id: '0.0', value: 'three\nfour' },
  ]) as typeof doc;
  assert.equal(result.content[0].content[0].text, 'three\nfour');
  assert.deepEqual(result.content[0].attrs, doc.content[0].attrs);
});

test('GitHub milestone writes report silently dropped provider fields as partial', async () => {
  const f = githubFixture();
  const author = new GithubAuthoring(
    async (path, init) => {
      if (init?.method === 'PATCH') return structuredClone(f.issues.get(1));
      return f.request(path, init);
    },
    (key, suffix = '') =>
      `/repos/team/a/issues/${githubKey(key).split('#')[1]}${suffix}`,
    githubKey,
    'author',
  );
  const result = await author.write('team/a#1', {
    kind: 'field',
    id: 'milestone',
    previous: '',
    value: '7',
  });
  assert.equal(result.state, 'partial');
  assert.match(result.message, /did not apply the milestone/);
});

test('corrupt or malformed durable drafts fail recovery explicitly', () => {
  assert.throws(() =>
    loadDraft({ getItem: () => '{broken' }, 'account', 'ABC-1'),
  );
  assert.throws(
    () =>
      loadDraft(
        { getItem: () => JSON.stringify({ pending: true }) },
        'account',
        'ABC-1',
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      loadDraft(
        {
          getItem: () =>
            JSON.stringify({
              fragments: JSON.stringify([{ id: '0', value: {} }]),
            }),
        },
        'account',
        'ABC-1',
      ),
    /invalid/,
  );
});

test('GitHub triage access enables sub-issues without granting edits to someone else’s body or locked conversation', async () => {
  const f = githubFixture();
  f.setPermission({ triage: true });
  f.issues.get(1).user.login = 'someone-else';
  f.issues.get(1).locked = true;
  const options = await f.author.options('team/a#1');
  assert.equal(options.parent.allowed, true);
  assert.equal(options.createChild, true);
  assert.equal(options.description.editable, false);
  assert.equal(options.comment.allowed, false);
});

test('Jira parent authoring updates old and destination trees while search still reports the old hierarchy', async () => {
  const f = jiraFixture();
  f.issues.get('ABC-3').fields.issuetype.id = 'epic';
  const staleChild = structuredClone(f.issues.get('ABC-2'));
  const provider = new JiraProvider(async (path, init) => {
    if (path === '/rest/api/3/search/jql') {
      const query = JSON.parse(String(init?.body)).jql;
      return {
        issues: query.includes('"ABC-1"') ? [staleChild] : [],
        isLast: true,
      };
    }
    return f.request(path, init);
  });
  const plan = await provider.authoring.plan('ABC-2', 'ABC-3');
  assert.equal(
    (await provider.authoring.write('ABC-2', { kind: 'parent', plan })).state,
    'saved',
  );
  const oldTree = await provider.tree('ABC-1');
  assert.equal(
    oldTree.issues.some((issue) => issue.key === 'ABC-2'),
    false,
  );
  const newTree = await provider.tree('ABC-3');
  assert.equal(
    newTree.issues.find((issue) => issue.key === 'ABC-2')?.parentKey,
    'ABC-3',
  );
});
