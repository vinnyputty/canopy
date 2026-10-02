import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { JiraProvider } from '../src/main/jira';
import { relationshipBlockers } from '../src/renderer/relationships';
import type { Relationship } from '../src/shared/types';

// A document adapter for ReactDOM's host operations, without a browser or GUI.
class Node {
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  style = {};
  attributes = new Map<string, string>();
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  constructor(
    public nodeType: number,
    public nodeName: string,
    public ownerDocument: any,
    public nodeValue = '',
  ) {}
  get tagName() {
    return this.nodeName;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): Node | null {
    return (
      this.parentNode?.childNodes[
        this.parentNode.childNodes.indexOf(this) + 1
      ] ?? null
    );
  }
  get textContent(): string {
    return this.nodeType === 3
      ? this.nodeValue
      : this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes.forEach((node) => {
      node.parentNode = null;
    });
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  appendChild(node: Node) {
    this.insertBefore(node, null);
    return node;
  }
  insertBefore(node: Node, before: Node | null) {
    node.parentNode?.removeChild(node);
    const index = before
      ? this.childNodes.indexOf(before)
      : this.childNodes.length;
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: Node) {
    const index = this.childNodes.indexOf(node);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener() {}
  removeEventListener() {}
}

test('actual blocker rows reconcile distinct and repeated Jira relationships without key collisions', async () => {
  const linked = {
    key: 'B-2',
    fields: { summary: 'Target', status: { statusCategory: { key: 'new' } } },
  };
  const depends = {
    name: 'Depends',
    outward: 'depends on',
    inward: 'is depended on by',
  };
  const provider = new JiraProvider(async (path) =>
    path.includes('/issue/')
      ? {
          key: 'A-1',
          fields: {
            parent: null,
            issuelinks: [
              {
                id: '1',
                type: {
                  name: 'Blocks',
                  inward: 'is blocked by',
                  outward: 'blocks',
                },
                inwardIssue: linked,
              },
              { id: '2', type: depends, outwardIssue: linked },
              { id: '3', type: depends, outwardIssue: linked },
            ],
          },
        }
      : { isLast: true, issues: [] },
  );
  const graph = await provider.relationships('A-1');
  const details = relationshipBlockers({} as any, graph).blockerDetails;
  assert.equal(
    details.length,
    3,
    'provider retains different types and exact duplicate references',
  );
  assert.equal(details[1].relationship, details[2].relationship);
  assert.equal(details[1].direction, details[2].direction);
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let mapping!: ts.CallExpression;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'task.blockerDetails.map'
    )
      mapping = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(mapping);
  const rows = (blockerDetails: Relationship[]) =>
    runInNewContext(
      ts.transpileModule(`globalThis.rows = ${mapping.getText(source)};`, {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      {
        React,
        task: { blockerDetails, issue: { key: 'A-1' } },
        activeConnection: { provider: 'jira', name: 'Work' },
        activeTab: { connectionId: 'work' },
        jumpToRelationship: (connection: string, key: string) =>
          jumps.push([connection, key]),
      },
    ) as React.ReactElement[];
  const jumps: string[][] = [];
  const globals = globalThis as any;
  const previousWindow = globals.window,
    previousDocument = globals.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globals,
    'navigator',
  );
  Object.defineProperty(globals, 'navigator', {
    configurable: true,
    value: { userAgent: 'node-test' },
  });
  const document: any = new Node(9, '#document', null);
  document.ownerDocument = document;
  document.createElement = (name: string) =>
    new Node(1, name.toUpperCase(), document);
  document.createTextNode = (value: string) =>
    new Node(3, '#text', document, value);
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body');
  document.activeElement = null;
  globals.window = { document, HTMLIFrameElement: class {} };
  document.defaultView = globals.window;
  globals.document = document;
  const container = document.createElement('div') as Node;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(' '));
  let root: import('react-dom/client').Root | undefined;
  try {
    const { createRoot } = createRequire(import.meta.url)(
      'react-dom/client',
    ) as typeof import('react-dom/client');
    const { flushSync } = createRequire(import.meta.url)(
      'react-dom',
    ) as typeof import('react-dom');
    root = createRoot(container as any);
    const render = (links: Relationship[]) =>
      flushSync(() =>
        root!.render(React.createElement('section', null, ...rows(links))),
      );
    render(details);
    console.log(
      'Actual React blocker rows',
      JSON.stringify({ rows: container.firstChild!.childNodes.length, errors }),
    );
    assert.deepEqual(
      errors,
      [],
      'real ReactDOM emits no duplicate-key warnings',
    );
    const initial = [...container.firstChild!.childNodes];
    assert.equal(initial.length, 3);
    const expectRows = (expected: Node[]) => {
      assert.equal(container.firstChild!.childNodes.length, expected.length);
      expected.forEach((node, index) =>
        assert.equal(
          container.firstChild!.childNodes[index],
          node,
          'retained relationship row keeps the same DOM object',
        ),
      );
    };
    render([details[1], details[0], details[2]]);
    expectRows([initial[1], initial[0], initial[2]]);
    render([details[1], details[2]]);
    expectRows([initial[1], initial[2]]);
    render([details[1]]);
    expectRows([initial[1]]);
    const element = rows([details[1]])[0] as React.ReactElement<any>;
    const button = React.Children.toArray(element.props.children).find(
      (child: any) => child.type === 'button',
    ) as React.ReactElement<any>;
    button.props.onClick();
    assert.deepEqual(jumps, [['work', 'B-2']]);
    assert.deepEqual(errors, []);
    flushSync(() => root!.unmount());
    root = undefined;
  } finally {
    if (root)
      createRequire(import.meta.url)('react-dom').flushSync(() =>
        root!.unmount(),
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.error = originalError;
    globals.window = previousWindow;
    globals.document = previousDocument;
    if (previousNavigator)
      Object.defineProperty(globals, 'navigator', previousNavigator);
    else delete globals.navigator;
  }
});
