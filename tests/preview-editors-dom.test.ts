import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import { IssuePreview } from '../src/renderer/IssuePreview';
import { CreateChildDialog } from '../src/renderer/CreateChildDialog';
import type { CanopyAPI, Issue } from '../src/shared/types';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const issue: Issue = {
  id: '1',
  key: 'team/repo#1',
  summary: 'Readable issue',
  type: 'Issue',
  status: { id: 'open', name: 'Open', category: 'new' },
  priority: null,
  assignee: null,
  links: [],
  labels: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(api: Partial<CanopyAPI> = {}) {
  const dom = new JSDOM(
    '<button id="origin">Origin</button><div id="host"></div>',
    {
      url: 'https://fixture.example',
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  Object.assign(window, {
    canopy: {
      preview: async (_connection: string, key: string) => ({
        issue: { ...issue, key },
        description: 'Issue description',
        comments: [
          {
            id: '1',
            author: 'Ada',
            body: 'Keep comments visible',
            created: '',
          },
        ],
        totalComments: 1,
      }),
      labels: async () => [{ id: 'bug', name: 'bug' }],
      update: async () => ({ ...issue, labels: [{ id: 'bug', name: 'bug' }] }),
      ...api,
    },
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = window.document.querySelector('#host') as HTMLElement;
  const root = createRoot(host);
  const origin = window.document.querySelector('#origin') as HTMLButtonElement;
  origin.focus();
  let changed = 0,
    closed = 0,
    browser = 0;
  const render = async (key = issue.key) =>
    act(async () =>
      root.render(
        React.createElement(IssuePreview, {
          connectionId: 'account',
          provider: 'github',
          connectionName: 'Work',
          issueKey: key,
          relationshipsLoading: false,
          width: 400,
          onWidth() {},
          onClose() {
            closed++;
          },
          onChanged() {
            changed++;
          },
          onAuthoringChanged() {},
          onPreview() {},
          onJump() {},
          onOpenExternal() {
            browser++;
          },
          onCopyKeySummary() {},
          onWorkBrief() {},
          onOpenComment() {},
          onRelationships() {},
          onMarkSeen() {},
        }),
      ),
    );
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
      (node) => node.textContent === name,
    )!;
  return {
    host,
    window,
    origin,
    button,
    render,
    changed: () => changed,
    closed: () => closed,
    browser: () => browser,
    async click(name: string) {
      assert.ok(button(name), name);
      await act(async () => button(name).click());
    },
    async child() {
      await act(async () =>
        root.render(
          React.createElement(CreateChildDialog, {
            connectionId: 'account',
            parent: issue,
            onClose() {
              closed++;
            },
            onCreated() {
              changed++;
            },
            onOpenJira() {
              browser++;
            },
          }),
        ),
      );
    },
    async key(node: Element, key: string, shiftKey = false) {
      await act(async () =>
        node.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    },
    async close() {
      try {
        await act(async () => root.unmount());
      } finally {
        dom.window.close();
        for (const [name, descriptor] of prior) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
    async editTitle(value: string) {
      const input = host.querySelector('input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async unmount() {
      await act(async () => root.render(null));
    },
  };
}

test('label loading failure stays local, retries, and Escape restores label trigger focus', async () => {
  let calls = 0;
  const pending = deferred<{ id: string; name: string }[]>();
  const f = await fixture({
    labels: async () =>
      ++calls === 1 ? pending.promise : [{ id: 'bug', name: 'bug' }],
  });
  try {
    await f.render();
    await f.click('Edit labels');
    assert.match(f.host.textContent!, /Loading labels/);
    await act(async () => pending.reject(new Error('Labels denied')));
    assert.match(
      f.host.querySelector('.preview-field-error')!.textContent!,
      /Labels denied/,
    );
    assert.match(f.host.textContent!, /Keep comments visible/);
    await f.click('Retry labels');
    const input = f.host.querySelector<HTMLInputElement>(
      '.github-labels input',
    )!;
    assert.ok(input);
    input.focus();
    await f.key(input, 'Escape');
    assert.equal(f.host.querySelector('.github-labels'), null);
    assert.ok(
      f.window.document.activeElement === f.button('Edit labels'),
      'Escape restores label trigger focus',
    );
    assert.equal(f.closed(), 0);
  } finally {
    await f.close();
  }
});

test('label saves announce success; rejected saves restore the value and retain comments', async () => {
  let fail = false;
  const pending = deferred<Issue>();
  const f = await fixture({
    update: async () => {
      if (fail) throw new Error('Edit rejected');
      return pending.promise;
    },
  });
  try {
    await f.render();
    await f.click('Edit labels');
    const input = () =>
      f.host.querySelector<HTMLInputElement>('.github-labels input')!;
    await act(async () => input().click());
    assert.equal(input().checked, true);
    assert.equal(input().disabled, true);
    assert.match(f.host.textContent!, /Saving labels/);
    await act(async () =>
      pending.resolve({ ...issue, labels: [{ id: 'bug', name: 'bug' }] }),
    );
    assert.equal(input().disabled, false);
    assert.match(f.host.textContent!, /Labels saved/);
    assert.equal(f.changed(), 1);
    fail = true;
    await act(async () => input().click());
    assert.equal(input().checked, true);
    assert.equal(input().disabled, false);
    assert.match(f.host.textContent!, /Edit rejected/);
    assert.match(f.host.textContent!, /Keep comments visible/);
    await f.click('Open in GitHub');
    assert.equal(f.browser(), 1);
  } finally {
    await f.close();
  }
});

test('navigation clears label editing and ignores an earlier save result', async () => {
  const pending = deferred<Issue>();
  const f = await fixture({ update: () => pending.promise });
  try {
    await f.render();
    await f.click('Edit labels');
    await act(async () =>
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.click(),
    );
    await f.render('team/repo#2');
    assert.equal(f.host.querySelector('.github-labels'), null);
    await act(async () => pending.reject(new Error('Old issue denied')));
    assert.doesNotMatch(f.host.textContent!, /Old issue denied/);
    assert.equal(f.changed(), 0);
    await f.click('Edit labels');
    assert.equal(
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.disabled,
      false,
    );
  } finally {
    await f.close();
  }
});

test('child dialog traps initial focus, handles Escape, restores focus, and offers provider fallback', async () => {
  const f = await fixture({
    childCreateOptions: async () => ({
      project: { id: 'p', name: 'Project' },
      parent: { id: '1', name: 'Parent' },
      types: [],
      reason: 'Create this child in Jira.',
    }),
  });
  try {
    await f.child();
    const dialog = f.host.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(
      f.window.document.activeElement === dialog,
      'dialog receives initial focus',
    );
    await f.key(dialog, 'Tab');
    assert.ok(
      f.window.document.activeElement ===
        f.host.querySelector('[aria-label="Close"]'),
      'Tab stays inside the dialog',
    );
    dialog.focus();
    await f.key(dialog, 'Tab', true);
    assert.ok(
      f.window.document.activeElement === f.button('Cancel'),
      'reverse Tab starts at the last enabled button',
    );
    await f.key(f.button('Cancel'), 'Tab');
    assert.ok(
      f.window.document.activeElement ===
        f.host.querySelector('[aria-label="Close"]'),
      'Tab stays inside the dialog',
    );
    await f.click('Open parent in Jira');
    assert.equal(f.browser(), 1);
    assert.match(f.host.textContent!, /Create this child in Jira/);
    assert.equal(f.button('Create child').disabled, true);
    await f.key(dialog, 'Escape');
    assert.equal(f.closed(), 1);
    await f.unmount();
    assert.ok(
      f.window.document.activeElement === f.origin,
      'closing restores the opener',
    );
  } finally {
    await f.close();
  }
});

test('empty label options are explicit and late loads cannot replace the next issue', async () => {
  const pending = deferred<{ id: string; name: string }[]>();
  let calls = 0;
  const f = await fixture({
    labels: async () => (++calls === 1 ? pending.promise : []),
  });
  try {
    await f.render();
    await f.click('Edit labels');
    await f.render('team/repo#2');
    await f.click('Edit labels');
    assert.match(f.host.textContent!, /No labels available in this repository/);
    await act(async () => pending.resolve([{ id: 'old', name: 'Old label' }]));
    assert.equal(f.host.querySelector('.github-labels input'), null);
    assert.doesNotMatch(f.host.textContent!, /Old label/);
  } finally {
    await f.close();
  }
});

test('an earlier label save cannot release or overwrite a later issue save', async () => {
  const first = deferred<Issue>(),
    second = deferred<Issue>();
  let calls = 0;
  const f = await fixture({
    update: () => (++calls === 1 ? first.promise : second.promise),
  });
  try {
    await f.render();
    await f.click('Edit labels');
    await act(async () =>
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.click(),
    );
    await f.render('team/repo#2');
    await f.click('Edit labels');
    await act(async () =>
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.click(),
    );
    await act(async () => first.resolve(issue));
    assert.equal(f.changed(), 0);
    assert.equal(
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.disabled,
      true,
    );
    assert.match(f.host.textContent!, /Saving labels/);
    await act(async () =>
      second.resolve({
        ...issue,
        key: 'team/repo#2',
        labels: [{ id: 'bug', name: 'bug' }],
      }),
    );
    assert.equal(f.changed(), 1);
    assert.equal(
      f.host.querySelector<HTMLInputElement>('.github-labels input')!.disabled,
      false,
    );
  } finally {
    await f.close();
  }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`returning to an issue ignores an earlier label save ${outcome}`, async () => {
    const first = deferred<Issue>(),
      second = deferred<Issue>();
    let calls = 0;
    const f = await fixture({
      update: () => (++calls === 1 ? first.promise : second.promise),
    });
    try {
      await f.render();
      await f.click('Edit labels');
      await act(async () =>
        f.host.querySelector<HTMLInputElement>('.github-labels input')!.click(),
      );
      await f.render('team/repo#2');
      await f.render();
      await f.click('Edit labels');
      await act(async () =>
        f.host.querySelector<HTMLInputElement>('.github-labels input')!.click(),
      );
      await act(async () => {
        if (outcome === 'success')
          first.resolve({ ...issue, summary: 'Outdated issue result' });
        else first.reject(new Error('Outdated issue failure'));
      });
      assert.equal(f.changed(), 0);
      assert.doesNotMatch(f.host.textContent!, /Outdated issue/);
      assert.equal(
        f.host.querySelector<HTMLInputElement>('.github-labels input')!
          .disabled,
        true,
      );
      assert.match(f.host.textContent!, /Saving labels/);
      await act(async () =>
        second.resolve({ ...issue, labels: [{ id: 'bug', name: 'bug' }] }),
      );
      assert.equal(f.changed(), 1);
      assert.equal(
        f.host.querySelector<HTMLInputElement>('.github-labels input')!
          .disabled,
        false,
      );
      assert.match(f.host.textContent!, /Labels saved/);
    } finally {
      await f.close();
    }
  });
}

test('child creation keeps saving and partial outcomes legible and blocks duplicate writes', async () => {
  const pending = deferred<Issue>();
  let creates = 0;
  const f = await fixture({
    childCreateOptions: async () => ({
      project: { id: 'p', name: 'Project' },
      parent: { id: '1', name: 'Parent' },
      types: [{ id: 'task', name: 'Task' }],
    }),
    childCreateFields: async () => ({
      description: false,
      descriptionRequired: false,
      assignee: false,
      assigneeRequired: false,
      priority: false,
      priorityRequired: false,
      priorities: [],
    }),
    createChild: () => {
      creates++;
      return pending.promise;
    },
  });
  try {
    await f.child();
    await f.editTitle('A useful child');
    assert.equal(f.button('Create child').disabled, false);
    await f.click('Create child');
    assert.match(f.host.textContent!, /Creating in Jira/);
    const dialog = f.host.querySelector('[role="dialog"]')!;
    await f.key(dialog, 'Escape');
    assert.equal(f.closed(), 0);
    assert.equal(f.button('Cancel').disabled, true);
    await act(async () =>
      pending.reject(new Error('Jira created CAN-99 but linking failed')),
    );
    assert.match(f.host.textContent!, /this issue may already exist/);
    assert.match(f.host.textContent!, /CAN-99/);
    assert.equal(f.button('Create child').disabled, true);
    assert.equal(f.button('Cancel').disabled, false);
    assert.equal(creates, 1);
    await f.click('Open parent in Jira');
    assert.equal(f.browser(), 1);
    await f.key(dialog, 'Escape');
    assert.equal(f.closed(), 1);
  } finally {
    await f.close();
  }
});
