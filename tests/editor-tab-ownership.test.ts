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

for (const destination of [
  'same tab',
  'other tab',
  'other control',
  'detached',
] as const)
  test(`summary cleanup respects ${destination} focus ownership`, async () => {
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
          { className: 'issue-title' },
          editing
            ? React.createElement(f.SummaryEditor, {
                provider: 'jira',
                issue: { key: 'CAN-101', summary: 'Confirmed summary' },
                save: () => Promise.resolve(),
                cancel,
              })
            : React.createElement(
                'button',
                { className: 'summary' },
                'Confirmed summary',
              ),
        ),
        React.createElement('button', { id: 'destination' }, 'Destination'),
      );
    }
    try {
      await f.render(React.createElement(Tree));
      assert.equal(f.document.activeElement, f.document.querySelector('input'));
      await act(async () => cancel());
      const button = f.document.querySelector('button.summary')!;
      if (destination === 'other tab')
        f.document
          .querySelector('[role="tree"]')!
          .setAttribute('data-tab-id', 'destination');
      if (destination === 'other control')
        (f.document.querySelector('#destination') as HTMLButtonElement).focus();
      if (destination === 'detached')
        f.document.querySelector('#host')!.remove();
      const before = f.document.activeElement;
      await f.frames();
      assert.equal(
        f.document.activeElement ===
          (destination === 'same tab' ? button : before),
        true,
      );
    } finally {
      await f.close();
    }
  });
