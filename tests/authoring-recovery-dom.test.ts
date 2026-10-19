import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import { RichAuthoring } from '../src/renderer/RichAuthoring';
import { draftKey } from '../src/renderer/authoring-drafts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {
    url: 'https://fixture.example',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = new Map<string, string>();
  let failRead = false,
    failWrite = false;
  const writes: string[] = [];
  const requests: unknown[] = [];
  let browser = 0,
    refresh = 0;
  const localStorage = {
    getItem(key: string) {
      if (failRead) throw new Error('Storage unavailable');
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failWrite) throw new Error('Storage full');
      writes.push(key);
      storage.set(key, value);
    },
    removeItem(key: string) {
      if (failWrite) throw new Error('Storage full');
      writes.push(key);
      storage.delete(key);
    },
  };
  Object.assign(window, {
    canopy: {
      authoringOptions: async () => ({
        description: {
          editable: true,
          value: 'Original',
          revision: '"Original"',
        },
        comment: { allowed: true },
        parent: { allowed: false },
        fields: [],
        attachments: [],
        handoffs: [],
        createChild: false,
      }),
      author: async (...args: unknown[]) => {
        requests.push(args);
        return { state: 'saved', message: 'Saved' };
      },
    },
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = window.document.querySelector('#host')!;
  const root = createRoot(host);
  const render = async (connectionId = 'account', issueKey = 'team/a#1') =>
    act(async () =>
      root.render(
        React.createElement(RichAuthoring, {
          connectionId,
          issueKey,
          provider: 'github',
          onRefresh() {
            refresh++;
          },
          onBrowser() {
            browser++;
          },
          onPreview() {},
        }),
      ),
    );
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
      (node: any) => node.textContent === name,
    ) as HTMLButtonElement | undefined;
  const click = async (name: string) => {
    const node = button(name);
    assert.ok(node, name);
    await act(async () => node.click());
  };
  return {
    host,
    storage,
    writes,
    requests,
    render,
    button,
    click,
    browser: () => browser,
    refresh: () => refresh,
    failRead(value: boolean) {
      failRead = value;
    },
    failWrite(value: boolean) {
      failWrite = value;
    },
    async edit(value: string) {
      const input = host.querySelector(
        '[aria-label="Comment draft"]',
      ) as HTMLTextAreaElement;
      assert.ok(input);
      assert.equal(input.disabled, false);
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async close() {
      try {
        await act(async () => root.unmount());
      } finally {
        dom.window.close();
        for (const [name, descriptor] of prior)
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('real authoring DOM preserves unreadable drafts through recovery controls, ownership changes and unmount', async () => {
  for (const raw of [
    '{broken JSON',
    JSON.stringify({ comment: 'Unsent private text', unknown: true }),
    JSON.stringify({ comment: 'x'.repeat(500_001) }),
    'unavailable',
  ]) {
    const f = await fixture();
    const key = draftKey('account', 'team/a#1');
    f.storage.set(key, raw);
    if (raw === 'unavailable') f.failRead(true);
    try {
      await f.render();
      await f.click('Edit and discuss');
      assert.match(f.host.textContent!, /Draft recovery failed/);
      assert.equal(Boolean(f.button('Retry saving draft')), false);
      assert.equal(
        (
          f.host.querySelector(
            '[aria-label="Comment draft"]',
          ) as HTMLTextAreaElement
        ).disabled,
        true,
      );
      await f.click('Post comment');
      const checkbox = f.host.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement;
      await act(async () => checkbox.click());
      await f.click('Allow a new write after review');
      assert.match(f.host.textContent!, /Draft recovery failed/);
      await f.click('Refresh authoring options');
      await f.click('Continue in GitHub');
      assert.equal(f.browser(), 1);
      assert.equal(f.refresh(), 1);
      assert.equal(f.storage.get(key), raw);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.requests, []);
      f.failRead(false);
      await f.render('other-account');
      assert.doesNotMatch(f.host.textContent!, /Draft recovery failed/);
      await f.edit('Other account draft');
      await f.render('account', 'team/a#2');
      await f.edit('Other issue draft');
      assert.equal(
        JSON.parse(f.storage.get(draftKey('other-account', 'team/a#1'))!)
          .comment,
        'Other account draft',
      );
      assert.equal(
        JSON.parse(f.storage.get(draftKey('account', 'team/a#2'))!).comment,
        'Other issue draft',
      );
      assert.equal(f.storage.get(key), raw);
      await f.render();
      if (raw !== 'unavailable')
        assert.match(f.host.textContent!, /Draft recovery failed/);
      assert.equal(f.storage.get(key), raw);
    } finally {
      await f.close();
    }
    assert.equal(f.storage.get(key), raw);
  }
});

test('real authoring DOM retries an ordinary failed draft save with the unsent text and permits the next write', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.click('Edit and discuss');
    f.failWrite(true);
    await f.edit('Unsent comment survives');
    assert.match(f.host.textContent!, /Could not save draft/);
    assert.equal(f.storage.size, 0);
    await f.click('Post comment');
    assert.deepEqual(f.requests, []);
    f.failWrite(false);
    await f.click('Retry saving draft');
    assert.equal(
      JSON.parse(f.storage.get(draftKey('account', 'team/a#1'))!).comment,
      'Unsent comment survives',
    );
    assert.doesNotMatch(f.host.textContent!, /Could not save draft/);
    await f.click('Post comment');
    assert.equal(f.requests.length, 1);
    assert.equal(
      JSON.parse(f.storage.get(draftKey('account', 'team/a#1'))!).comment,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('a failed pre-request draft save stays local through retry and explicit review before a new write', async () => {
  const f = await fixture();
  const key = draftKey('account', 'team/a#1');
  try {
    await f.render();
    await f.click('Edit and discuss');
    await f.edit('Retained before request');
    const before = f.storage.get(key);
    f.failWrite(true);
    await f.click('Post comment');
    assert.match(f.host.textContent!, /Could not save draft/);
    assert.deepEqual(f.requests, []);
    assert.equal(f.storage.get(key), before);
    f.failWrite(false);
    await f.click('Retry saving draft');
    assert.deepEqual(f.requests, []);
    assert.equal(
      JSON.parse(f.storage.get(key)!).comment,
      'Retained before request',
    );
    assert.equal(JSON.parse(f.storage.get(key)!).pending, 'comment');
    const checkbox = f.host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    await f.click('Allow a new write after review');
    assert.equal(JSON.parse(f.storage.get(key)!).pending, undefined);
    assert.deepEqual(f.requests, []);
    await f.click('Post comment');
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
