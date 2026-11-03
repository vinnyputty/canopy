import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import ts from 'typescript';
import { declaration, execute, findNode, sourceFile } from './source-probe';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const app = sourceFile(new URL('../src/renderer/App.tsx', import.meta.url));
const rows = findNode(
  app,
  (node): node is ts.JsxSelfClosingElement =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'TreeRows',
);
const editor = rows.attributes.properties.find(
  (node) => ts.isJsxAttribute(node) && node.name.getText() === 'editor',
) as ts.JsxAttribute;
const editorExpression = (
  editor.initializer as ts.JsxExpression
).expression!.getText();
const summary = declaration(app, 'SummaryEditor').getText();

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const frames: FrameRequestCallback[] = [];
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run),
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.querySelector('#host')!);
  const SummaryEditor = execute(summary, {
    ...React,
    __jsx: React.createElement,
  });
  return {
    window,
    document: window.document,
    SummaryEditor,
    render: async (element: React.ReactNode) =>
      act(async () => root.render(element)),
    frames: async () =>
      act(async () => {
        for (const run of frames.splice(0)) run(0);
      }),
    close: async () => {
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

test('same-key tab remount never mounts or focuses the outgoing editor in the destination', async () => {
  const f = await fixture();
  const owner = {
    tabId: 'source',
    connectionId: 'work',
    key: 'CAN-101',
    field: 'summary',
  };
  const writes: unknown[] = [];
  const focus: string[] = [];
  let clear = () => {};
  function Row({ editing }: { editing: typeof owner | null }) {
    return React.createElement(
      'div',
      { className: 'issue-title' },
      editing
        ? React.createElement(f.SummaryEditor, {
            provider: 'jira',
            issue: { key: 'CAN-101', summary: 'Confirmed summary' },
            save: (...args: unknown[]) => {
              writes.push(args);
              return Promise.resolve();
            },
            cancel: clear,
          })
        : React.createElement(
            'button',
            { className: 'summary' },
            'Confirmed summary',
          ),
    );
  }
  function Tree({ id }: { id: string }) {
    const [state, setEditor] = React.useState<typeof owner | null>(owner);
    clear = () => setEditor(null);
    const editing = execute(editorExpression, {
      editor: state,
      activeTab: { id, connectionId: 'work' },
    });
    React.useEffect(() => {
      if (id !== owner.tabId) setEditor(null);
    }, [id]);
    return React.createElement(
      'div',
      { role: 'tree', 'data-tab-id': id },
      React.createElement(Row, { key: id, editing }),
    );
  }
  try {
    await f.render(React.createElement(Tree, { id: 'source' }));
    const input = f.document.querySelector('input')!;
    assert.equal(f.document.activeElement, input);
    const setter = Object.getOwnPropertyDescriptor(
      f.window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(input, 'Outgoing dirty draft');
      input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    });
    assert.equal(input.value, 'Outgoing dirty draft');
    assert.equal(input.getAttribute('value'), 'Outgoing dirty draft');
    f.document.addEventListener('focusin', (event: FocusEvent) =>
      focus.push((event.target as HTMLElement).tagName),
    );
    await f.render(React.createElement(Tree, { id: 'destination' }));
    await f.frames();
    assert.equal(input.isConnected, false);
    assert.equal(f.document.querySelector('input'), null);
    assert.equal(
      f.document.querySelector('button.summary')?.textContent,
      'Confirmed summary',
    );
    assert.deepEqual(focus, []);
    assert.deepEqual(writes, []);
    for (const id of ['source', 'destination']) {
      await f.render(React.createElement(Tree, { id }));
      await f.frames();
      assert.equal(f.document.querySelector('input'), null);
      assert.equal(
        f.document.querySelector('button.summary')?.textContent,
        'Confirmed summary',
      );
      assert.deepEqual(focus, []);
      assert.deepEqual(writes, []);
    }
  } finally {
    await f.close();
  }
});

for (const provider of ['jira', 'demo'] as const)
  for (const destination of [
    'same tab',
    'other tab',
    'other control',
    'other control before unmount',
    'detached',
  ] as const)
    test(`${provider} summary cleanup respects ${destination} focus ownership`, async () => {
      const f = await fixture();
      let cancel = () => {};
      function Tree() {
        const [editing, setEditing] = React.useState(true);
        cancel = () => setEditing(false);
        return React.createElement(
          'div',
          { role: 'tree', 'data-tab-id': 'source' },
          React.createElement(
            'div',
            {
              className: 'issue-title',
              role: 'treeitem',
              tabIndex: 0,
              'data-tree-key': 'CAN-101',
            },
            editing
              ? React.createElement(f.SummaryEditor, {
                  provider,
                  issue: { key: 'CAN-101', summary: 'Confirmed summary' },
                  save: () => Promise.resolve(),
                  cancel,
                })
              : React.createElement(
                  provider === 'demo' ? 'span' : 'button',
                  { className: 'summary' },
                  'Confirmed summary',
                ),
          ),
          React.createElement('button', { id: 'destination' }, 'Destination'),
        );
      }
      try {
        await f.render(React.createElement(Tree));
        assert.equal(
          f.document.activeElement,
          f.document.querySelector('input'),
        );
        if (destination === 'other control before unmount')
          await act(async () =>
            (
              f.document.querySelector('#destination') as HTMLButtonElement
            ).focus(),
          );
        await act(async () => cancel());
        const target = f.document.querySelector(
          provider === 'demo' ? '[role="treeitem"]' : 'button.summary',
        )! as HTMLElement;
        const focus = target.focus.bind(target);
        let focusAttempts = 0;
        target.focus = (...args) => {
          focusAttempts++;
          focus(...args);
        };
        if (destination === 'other tab')
          f.document
            .querySelector('[role="tree"]')!
            .setAttribute('data-tab-id', 'destination');
        if (destination === 'other control')
          (
            f.document.querySelector('#destination') as HTMLButtonElement
          ).focus();
        if (destination === 'detached')
          f.document.querySelector('#host')!.remove();
        if (destination === 'other control before unmount')
          (
            f.document.querySelector('#destination') as HTMLButtonElement
          ).blur();
        const before = f.document.activeElement;
        await f.frames();
        assert.equal(
          f.document.activeElement ===
            (destination === 'same tab' ? target : before),
          true,
        );
        assert.equal(focusAttempts, destination === 'same tab' ? 1 : 0);
      } finally {
        await f.close();
      }
    });

for (const provider of ['jira', 'demo'] as const)
  for (const key of ['Escape', 'Enter'] as const)
    test(`${provider} summary ${key} returns focus after the editor unmounts`, async () => {
      const f = await fixture();
      const writes: unknown[] = [];
      function Tree() {
        const [editing, setEditing] = React.useState(true);
        return React.createElement(
          'div',
          { role: 'tree', 'data-tab-id': 'source' },
          React.createElement(
            'div',
            { role: 'treeitem', tabIndex: 0, 'data-tree-key': 'CAN-101' },
            editing
              ? React.createElement(f.SummaryEditor, {
                  provider,
                  issue: { key: 'CAN-101', summary: 'Confirmed summary' },
                  save: (...args: unknown[]) => {
                    writes.push(args);
                    setEditing(false);
                    return Promise.resolve();
                  },
                  cancel: () => setEditing(false),
                })
              : React.createElement(
                  provider === 'demo' ? 'span' : 'button',
                  { className: 'summary' },
                  'Confirmed summary',
                ),
          ),
        );
      }
      try {
        await f.render(React.createElement(Tree));
        const input = f.document.querySelector('input')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            f.window.HTMLInputElement.prototype,
            'value',
          )!.set!.call(input, 'Changed summary');
          input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
        });
        await act(async () =>
          input.dispatchEvent(
            new f.window.KeyboardEvent('keydown', { key, bubbles: true }),
          ),
        );
        await f.frames();
        assert.equal(f.document.querySelector('input'), null);
        assert.equal(
          f.document.activeElement ===
            f.document.querySelector(
              provider === 'demo' ? '[role="treeitem"]' : 'button.summary',
            ),
          true,
          'focus returns to the summary button or its demo row',
        );
        assert.deepEqual(
          writes,
          key === 'Enter' ? [['CAN-101', { summary: 'Changed summary' }]] : [],
        );
      } finally {
        await f.close();
      }
    });

test('editor Tab capture advances fields while modified Tab reaches workspace shortcuts', () => {
  const capture = findNode(
    app,
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) && node.name.getText() === 'onKeyDownCapture',
  );
  const handler = (capture.initializer as ts.JsxExpression).expression!;
  for (const modifiers of [
    {},
    { shiftKey: true },
    { ctrlKey: true },
    { ctrlKey: true, shiftKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    const calls: unknown[] = [];
    const row = {};
    const target = { closest: () => row, blur: () => calls.push('blur') };
    const run = execute(handler.getText(), {
      props: {
        editor: { key: 'CAN-100', field: 'summary' },
        advanceEdit: (...args: unknown[]) => calls.push(args),
      },
      issue: { key: 'CAN-100' },
    });
    run({
      key: 'Tab',
      target,
      currentTarget: row,
      preventDefault: () => calls.push('prevent'),
      stopPropagation: () => calls.push('stop'),
      ...modifiers,
    });
    const modified =
      'ctrlKey' in modifiers || 'metaKey' in modifiers || 'altKey' in modifiers;
    assert.deepEqual(
      calls,
      modified
        ? []
        : [
            'prevent',
            'stop',
            'blur',
            ['CAN-100', 'summary', 'shiftKey' in modifiers ? -1 : 1],
          ],
    );
  }
});
