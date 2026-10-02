import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute selected production callbacks with controlled browser dependencies.
// This is a Node source probe, not a React DOM/native acceptance claim.
export function sourceFile(path: URL | string) {
  return ts.createSourceFile(
    String(path),
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
export function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;
  function visit(node: ts.Node) {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(root);
  assert.ok(found, 'production callback must exist');
  return found;
}
export function declaration(root: ts.Node, name: string) {
  return findNode(
    root,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
}
export function callback(root: ts.Node, name: string) {
  const node = findNode(
    root,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText() === name,
  );
  assert.ok(node.initializer);
  return node.initializer.getText();
}
export function execute(source: string, context: Record<string, unknown>) {
  const code = ts.transpileModule(`const probe = ${source};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      jsxFactory: '__jsx',
    },
  }).outputText;
  return new Function(...Object.keys(context), `${code}\nreturn probe;`)(
    ...Object.values(context),
  );
}
