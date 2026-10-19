import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(
  new URL('../tools/smoke-accessibility.mjs', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'smoke-accessibility.mjs',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const selectors: string[] = [];
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'locator' &&
    ts.isCallExpression(node.expression.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression.expression) &&
    node.expression.expression.expression.expression.getText(ast) === 'page' &&
    node.expression.expression.expression.name.text === 'getByRole' &&
    ts.isStringLiteral(node.expression.expression.arguments[0]) &&
    node.expression.expression.arguments[0].text === 'tree' &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0])
  )
    selectors.push(node.arguments[0].text);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(selectors.length, 1);
const selector = selectors[0];
const row = (key = 'CAN-101', level = '1', role = 'treeitem', children = '') =>
  `<div role="${role}" aria-level="${level}" data-tree-key="${key}">${children}</div>`;
const wrapped = (contents: string, mode = 'all') =>
  `<div data-row-window="${mode}"><div role="presentation" data-window-row="CAN-101">${contents}</div></div>`;

for (const [name, contents, count] of [
  ['unwrapped root', row(), 1],
  ['all rows wrapper', wrapped(row()), 1],
  ['viewport wrapper', wrapped(row(), 'viewport'), 1],
  ['missing root', wrapped(''), 0],
  ['other root key', wrapped(row('CAN-100')), 0],
  ['flat descendant', wrapped(row('CAN-101', '2')), 0],
  ['missing treeitem role', wrapped(row('CAN-101', '1', 'presentation')), 0],
  ['missing hierarchy level', wrapped(row('CAN-101', '')), 0],
  [
    'nested descendant claiming root level',
    row(
      'CAN-100',
      '1',
      'treeitem',
      `<div role="group">${wrapped(row())}</div>`,
    ),
    0,
  ],
  ['duplicate roots', wrapped(row() + row()), 2],
  [
    'root with nested same-key descendant',
    wrapped(row('CAN-101', '1', 'treeitem', row('CAN-101', '2'))),
    1,
  ],
] as const) {
  test(`accessibility focused-subtree selector: ${name}`, () => {
    const dom = new JSDOM(`<div role="tree">${contents}</div>`);
    try {
      const tree = dom.window.document.querySelector('[role="tree"]')!;
      assert.equal(tree.querySelectorAll(selector).length, count);
    } finally {
      dom.window.close();
    }
  });
}
