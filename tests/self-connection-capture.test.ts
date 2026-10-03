import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../tools/smoke-pickers.mjs', import.meta.url),
  'utf8',
);
const prefix = 'Self-connection workspace capture: ';
const tab = (rootKey: string) => ({
  id: rootKey.toLowerCase(),
  connectionId: 'demo',
  rootKey,
});
const workspace = (keys: string[]) => ({
  activeTabId: keys[0]?.toLowerCase(),
  tabs: keys.map(tab),
  privatePayload: 'PRIVATE_WORKSPACE_PAYLOAD',
});

async function capture(
  load: () => unknown,
  roots: string[],
  options: { writerFailure?: boolean; domFailure?: boolean } = {},
) {
  let loads = 0;
  let evaluations = 0;
  let queries = 0;
  let writes = 0;
  let passed: unknown;
  const messages: string[] = [];
  const stop = new Error('stop before fixture installation');
  const audit = runInNewContext(
    source
      .replace("import { expect } from '@playwright/test';", '')
      .replaceAll('export async function', 'async function') +
      '\nauditSelfConnections;',
    {
      window: {
        canopy: {
          loadWorkspace: () => {
            loads += 1;
            return load();
          },
        },
      },
      document: {
        querySelectorAll: (selector: string) => {
          queries += 1;
          assert.equal(selector, '[role="tab"]');
          if (options.domFailure) throw new Error('private DOM failure');
          return roots.map((rootKey, index) => ({
            querySelector: (selector: string) => {
              assert.equal(selector, '.tab-label b');
              return { textContent: rootKey };
            },
            getAttribute: (name: string) => {
              assert.equal(name, 'aria-selected');
              return index === 0 ? 'true' : 'false';
            },
          }));
        },
      },
      console: {
        log: (message: string) => {
          writes += 1;
          if (options.writerFailure) throw new Error('private writer failure');
          messages.push(message);
        },
      },
    },
  );
  let error: unknown;
  try {
    await audit(
      {
        evaluate: (_callback: unknown, saved: unknown) => {
          passed = saved;
          throw stop;
        },
      },
      {
        evaluate: (callback: () => unknown) => {
          evaluations += 1;
          return callback();
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(loads, 1);
  assert.equal(evaluations, 1);
  return { passed, messages, error, stop, queries, writes };
}

test('self-connection capture exposes stale persisted roots beside current DOM', async () => {
  const saved = workspace(['CAN-100', 'CAN-106']);
  const result = await capture(() => saved, ['CAN-100']);
  assert.equal(result.error, result.stop);
  assert.equal(result.passed, saved);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(JSON.parse(result.messages[0].slice(prefix.length)), {
    activeTabId: 'can-100',
    tabCount: 2,
    tabs: [tab('CAN-100'), tab('CAN-106')],
    renderedTabCount: 1,
    renderedTabs: [{ rootKey: 'CAN-100', selected: 'true' }],
  });
  assert.ok(!result.messages[0].includes(saved.privatePayload));
});

test('self-connection capture samples DOM when the original load resolves', async () => {
  const saved = workspace(['CAN-100', 'CAN-200']);
  const roots = ['CAN-106'];
  const result = await capture(async () => {
    await Promise.resolve();
    roots.splice(0, 1, 'CAN-100', 'CAN-200');
    return saved;
  }, roots);
  assert.equal(result.error, result.stop);
  assert.equal(result.passed, saved);
  const observation = JSON.parse(result.messages[0].slice(prefix.length));
  assert.deepEqual(observation.tabs, saved.tabs);
  assert.deepEqual(observation.renderedTabs, [
    { rootKey: 'CAN-100', selected: 'true' },
    { rootKey: 'CAN-200', selected: 'false' },
  ]);
});

test('self-connection capture preserves synchronous and rejected primary loads', async () => {
  for (const primary of [
    new Error('original load failure'),
    undefined,
    null,
    false,
    0,
    '',
  ]) {
    for (const rejected of [false, true]) {
      const result = await capture(
        () => {
          if (rejected) return Promise.reject(primary);
          throw primary;
        },
        ['CAN-100'],
        { writerFailure: true, domFailure: true },
      );
      assert.equal(result.error, primary);
      assert.equal(result.queries, 0);
      assert.equal(result.writes, 0);
      assert.deepEqual(result.messages, []);
    }
  }
});

test('self-connection capture preserves falsy load results', async () => {
  for (const saved of [undefined, null, false, 0, '']) {
    const result = await capture(() => saved, ['CAN-100']);
    assert.equal(result.error, result.stop);
    assert.equal(result.passed, saved);
    assert.equal(result.messages.length, 1);
  }
});

test('self-connection diagnostic DOM and output failures preserve the capture', async () => {
  for (const options of [{ domFailure: true }, { writerFailure: true }]) {
    const saved = workspace(['CAN-100']);
    const result = await capture(() => saved, ['CAN-100'], options);
    assert.equal(result.error, result.stop);
    assert.equal(result.passed, saved);
    assert.deepEqual(result.messages, []);
    assert.equal(result.queries, 1);
    assert.equal(result.writes, options.writerFailure ? 1 : 0);
  }
});

test('self-connection capture caps samples, strings and recentOutput message size', async () => {
  const key = '"\\\u0000'.repeat(1000);
  const saved = workspace(Array(100).fill(key));
  saved.activeTabId = key;
  for (const item of saved.tabs) {
    item.id = key;
    item.connectionId = key;
  }
  // Reading beyond the sample would turn this observation into a failure.
  Object.defineProperty(saved.tabs, 4, {
    get: () => {
      throw new Error('sample limit exceeded');
    },
  });
  const result = await capture(() => saved, Array(100).fill(key));
  assert.equal(result.error, result.stop);
  assert.equal(result.passed, saved);
  assert.equal(result.messages.length, 1);
  const message = result.messages[0];
  assert.ok(message.startsWith(prefix));
  assert.ok(message.length < 2000);
  const observation = JSON.parse(message.slice(prefix.length));
  assert.equal(observation.tabCount, 100);
  assert.equal(observation.renderedTabCount, 100);
  assert.equal(observation.tabs.length, 4);
  assert.equal(observation.renderedTabs.length, 4);
  assert.equal(observation.activeTabId.length, 32);
  for (const item of observation.tabs) {
    for (const value of Object.values(item)) {
      assert.equal((value as string).length, 32);
      assert.ok(!(value as string).includes('\u0000'));
    }
  }
  assert.ok(!message.includes('PRIVATE_WORKSPACE_PAYLOAD'));
});
