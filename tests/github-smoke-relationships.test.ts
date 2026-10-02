import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GithubProvider } from '../src/main/github';

test('full GitHub smoke transport supports lazy typed relationships without breaking tree or preview reads', async () => {
  // Run the actual transport installer only, with no Playwright/Electron import.
  const source = readFileSync(
    new URL('../tools/smoke-github.mjs', import.meta.url),
    'utf8',
  );
  const start =
    source.indexOf('await app.evaluate(') + 'await app.evaluate('.length;
  const end = source.indexOf('\n  });\n  try', start) + '\n  }'.length;
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  const context = {
    Buffer,
    URL,
    Response,
    safeStorage: {},
    ipcMain: {
      _invokeHandlers: handlers,
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: unknown) =>
        handlers.set(channel, handler),
    },
    fetch: async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('The smoke fixture must not access a real provider.');
    },
    githubSmokeIssues: {} as Record<string, { state: string }>,
  };
  runInNewContext(
    `(${source.slice(start, end)})({ safeStorage, ipcMain })`,
    context,
  );
  const provider = new GithubProvider(
    {
      id: 'github:smoke',
      provider: 'github',
      name: 'GitHub · tester',
      url: 'https://github.com',
      repositories: ['team/a', 'team/b'],
    },
    async (path, init) => {
      const response = await context.fetch(
        `https://api.github.com${path}`,
        init,
      );
      assert.equal(response.ok, true);
      return response.json();
    },
  );
  const tree = await provider.tree('team/a#1');
  assert.equal(
    tree.issues.find((issue) => issue.key === 'team/b#2')?.parentKey,
    'team/a#1',
  );
  const preview = await provider.preview('team/a#1');
  assert.equal(preview.issue.key, 'team/a#1');
  assert.equal(preview.issue.linksAvailable, false);
  assert.equal(preview.issue.links.length, 0);
  assert.ok(preview.comments.length > 0);
  const graph = await provider.relationships('team/a#1');
  assert.equal(graph.key, 'team/a#1');
  assert.ok(graph.groups.every((group) => group.state === 'visible'));
  const related = graph.groups.find((group) => group.kind === 'related')!;
  assert.equal(related.items.length, 1);
  assert.deepEqual(related.items[0], {
    key: 'team/b#2',
    summary: 'team/b issue 2',
    relationship: 'relates to',
    direction: 'outward',
    statusCategory: 'new',
    access: 'available',
    crossRepository: true,
  });
  assert.equal(
    graph.groups.find((group) => group.kind === 'blockers')?.items[0].direction,
    'inward',
  );
  assert.equal(
    graph.groups.find((group) => group.kind === 'children')?.items[0].key,
    'team/b#2',
  );
  assert.equal(
    graph.groups.find((group) => group.kind === 'parent')?.items.length,
    0,
  );
  // Provider fields must determine the inspected status rather than a hardcoded UI result.
  context.githubSmokeIssues['team/b#2'].state = 'closed';
  const updated = await provider.relationships('team/a#1');
  assert.equal(
    updated.groups.find((group) => group.kind === 'related')?.items[0]
      .statusCategory,
    'done',
  );
});
