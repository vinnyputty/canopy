import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const importPath = (path: string) => JSON.stringify(path);

// Extract production callbacks rather than reproducing the renderer's persistence controller.
test('held import and reload reject old-renderer saves and preserve actual imported data and Undo', async () => {
  const root = resolve('.');
  const text = await readFile('src/renderer/App.tsx', 'utf8');
  const ast = ts.createSourceFile(
    'App.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function find(predicate: (node: ts.Node) => boolean) {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) {
      if (predicate(node)) result = node;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(result, 'Production callback not found');
    return result;
  }
  const save = (
    find(
      (n) =>
        ts.isVariableDeclaration(n) && n.name.getText(ast) === 'saveWorkspace',
    ) as ts.VariableDeclaration
  ).initializer as ts.CallExpression;
  const panel = find(
    (n) =>
      ts.isJsxSelfClosingElement(n) &&
      n.tagName.getText(ast) === 'WorkspaceBackupPanel',
  ) as ts.JsxSelfClosingElement;
  const attribute = (attributes: ts.JsxAttributes, name: string) => {
    const attr = attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(ast) === name,
    ) as ts.JsxAttribute;
    assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer));
    return attr.initializer.expression!.getText(ast);
  };
  const appearance = find(
    (n) =>
      ts.isJsxSelfClosingElement(n) &&
      n.tagName.getText(ast) === 'AppearanceDialog',
  ) as ts.JsxSelfClosingElement;
  const backupDialog = find(
    (n) =>
      ts.isJsxOpeningElement(n) &&
      n.tagName.getText(ast) === 'Dialog' &&
      n.attributes.properties.some(
        (p) =>
          ts.isJsxAttribute(p) &&
          p.name.getText(ast) === 'title' &&
          p.initializer?.getText(ast) === '"Workspace backup and transfer"',
      ),
  ) as ts.JsxOpeningElement;
  const onKey = find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'onKey',
  ) as ts.VariableDeclaration;
  const emptyWorkspace = find(
    (n) =>
      ts.isVariableDeclaration(n) && n.name.getText(ast) === 'EMPTY_WORKSPACE',
  ) as ts.VariableDeclaration;
  const hydration = find(
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'setWorkspace' &&
      n.arguments[0]?.getText(ast).includes('...EMPTY_WORKSPACE') === true &&
      n.arguments[0]?.getText(ast).includes('...saved') === true,
  ) as ts.CallExpression;
  const directory = await mkdtemp(join(tmpdir(), 'canopy-renderer-transfer-'));
  try {
    const source = `
import assert from 'node:assert/strict'; import * as fs from 'node:fs/promises';
import {Storage} from ${importPath(root + '/src/main/storage')};
import {WorkspaceTransfer} from ${importPath(root + '/src/main/workspace-transfer')};
import {createBackup} from ${importPath(root + '/src/shared/workspace-backup')};
import {recoverWorkspaceViews} from ${importPath(root + '/src/shared/views')};
import {migrateViews} from ${importPath(root + '/src/renderer/table-view')};
import {backupWorkspace,backupConnections} from ${importPath(root + '/tests/fixtures/workspace-backup')};
const storage=new Storage(${JSON.stringify(directory)}),transfer=new WorkspaceTransfer(storage,()=>backupConnections);
const baseline=migrateViews(recoverWorkspaceViews(structuredClone(backupWorkspace)));
const PLATFORM_SHORTCUTS=backupWorkspace.shortcuts,EMPTY_WORKSPACE=${emptyWorkspace.initializer!.getText(ast)},nextConnections=backupConnections;
const hydrate=saved=>{const hasDemo=nextConnections.some(c=>c.id==='demo'),tabs=saved.tabs.filter(t=>t.connectionId!=='demo'||hasDemo);return ${hydration.arguments[0].getText(ast)};};
const bytes=()=>fs.readFile(${JSON.stringify(join(directory, 'workspace.json'))},'utf8');
const workspaceRef={current:baseline},pendingWorkspaceSave={current:Promise.resolve()},workspaceSaveTimer={current:null},workspaceTransferBusy={current:false},appearanceSaving={current:false},demoResetting={current:false};
let active=false,dialog='backup',reload;
const setWorkspaceTransferActive=value=>active=value, setDialog=value=>dialog=typeof value==='function'?value(dialog):value;
const setAppearancePreview=()=>{},setWorkspace=value=>workspaceRef.current=typeof value==='function'?value(workspaceRef.current):value;
const window={clearTimeout(){},canopy:{saveWorkspace:value=>storage.write('workspace',value),reloadWorkspace:()=>reload?.()}};
const saveWorkspace=${save.arguments[0].getText(ast)},onApply=${attribute(panel.attributes, 'onApply')},flush=${attribute(panel.attributes, 'flush')},onSave=${attribute(appearance.attributes, 'onSave')},close=${attribute(backupDialog.attributes, 'onClose')},onKey=${onKey.initializer!.getText(ast)};
const backup=createBackup({...baseline,theme:'light',tabs:[],activeTabId:null,savedViews:[],activeSavedViewId:null},backupConnections);
const mapping=Object.fromEntries(backupConnections.map(c=>[c.id,c.id]));
await storage.write('workspace',baseline);
await fs.writeFile(${JSON.stringify(join(directory, 'credentials.json'))},'FAKE SAMPLE SENTINEL');
const preview=await transfer.preview(backup,mapping,'replace');
let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
globalThis.rendererStageGate=async(file,contents)=>{if(file.endsWith('workspace.json.tmp')&&JSON.parse(contents).theme==='light'){globalThis.rendererStageGate=undefined;enter();await held;}};
let reloadEnter,reloadRelease;const reloading=new Promise(r=>reloadEnter=r),reloadHeld=new Promise(r=>reloadRelease=r);reload=()=>{reloadEnter();return reloadHeld;};
let drain;pendingWorkspaceSave.current=new Promise(r=>drain=r);
const queued=assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
const applying=onApply(()=>transfer.apply(preview.token));drain();await queued;await entered;
const heldApplyBytes=await bytes();assert.equal(heldApplyBytes,JSON.stringify(baseline));
assert.equal(active,true);close();assert.equal(dialog,'backup');
let prevented=false;onKey({defaultPrevented:false,preventDefault(){prevented=true;}});assert.equal(prevented,true);
await assert.rejects(onSave('system','default'),/transfer is in progress/);
await assert.rejects(flush(),/transfer is in progress/);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
await assert.rejects(onApply(()=>transfer.rollback()),/transfer is in progress/);
assert.equal(await bytes(),heldApplyBytes);
release();await reloading;
assert.equal(await bytes(),JSON.stringify(preview.workspace));
assert.deepEqual(await storage.read('workspace'),preview.workspace);
await assert.rejects(onSave('system','default'),/transfer is in progress/);
await assert.rejects(flush(),/transfer is in progress/);
reloadRelease();await applying;
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
assert.deepEqual(await storage.read('workspace'),preview.workspace);
console.log('PASS held actual staging, dismissal/global/direct saves, duplicate Apply, and held/completed reload preserve imported data');
// New renderer hydration owns its own open barrier and flushes before guarded Undo.
const beforeUndoFlush=await bytes();
workspaceRef.current=hydrate(recoverWorkspaceViews(await storage.read('workspace')));workspaceTransferBusy.current=false;active=false;
let undoEnter,undoRelease;const undoEntered=new Promise(r=>undoEnter=r),undoHeld=new Promise(r=>undoRelease=r);
globalThis.rendererStageGate=async(file,contents)=>{if(file.endsWith('workspace.json.tmp')&&JSON.parse(contents).theme===baseline.theme){globalThis.rendererStageGate=undefined;undoEnter();await undoHeld;}};
let undoReloadEnter,undoReloadRelease;const undoReloading=new Promise(r=>undoReloadEnter=r),undoReloadHeld=new Promise(r=>undoReloadRelease=r);reload=()=>{undoReloadEnter();return undoReloadHeld;};
const undoing=onApply(()=>transfer.rollback());await undoEntered;
const heldUndoBytes=await bytes();assert.deepEqual(JSON.parse(heldUndoBytes),JSON.parse(beforeUndoFlush));
assert.notEqual(heldUndoBytes,beforeUndoFlush);assert.equal(heldUndoBytes,JSON.stringify(workspaceRef.current));
// Exact comparisons detect even value-equivalent writes during the hold.
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},beforeUndoFlush);
const reorderedDuringHold=await bytes();assert.deepEqual(JSON.parse(reorderedDuringHold),JSON.parse(heldUndoBytes));assert.throws(()=>assert.equal(reorderedDuringHold,heldUndoBytes));
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},JSON.stringify({...JSON.parse(heldUndoBytes),theme:'system'}));
const changedDuringHold=await bytes();assert.throws(()=>assert.equal(changedDuringHold,heldUndoBytes));
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},heldUndoBytes);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);await assert.rejects(flush(),/transfer is in progress/);
assert.equal(await bytes(),heldUndoBytes);undoRelease();await undoReloading;
assert.equal(await bytes(),JSON.stringify(baseline));await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
assert.equal(await bytes(),JSON.stringify(baseline));undoReloadRelease();await undoing;assert.deepEqual(await storage.read('workspace'),baseline);
console.log('PASS Undo after hydration and explicit flush restores original workspace');
workspaceTransferBusy.current=false;active=false;workspaceRef.current=baseline;
await assert.rejects(onApply(async()=>{throw Error('failed transfer');}),/failed transfer/);assert.equal(active,false);await saveWorkspace(baseline);
const next=await transfer.preview(backup,mapping,'replace');reload=()=>{throw Error('reload failed');};
await assert.rejects(onApply(()=>transfer.apply(next.token)),/Restart Canopy/);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);assert.deepEqual(await storage.read('workspace'),next.workspace);
console.log('PASS failed transfer reopens saves; failed reload after successful transfer keeps old renderer locked');
workspaceTransferBusy.current=false;active=false;reload=()=>{};
workspaceRef.current={...migrateViews(recoverWorkspaceViews(await storage.read('workspace'))),reading:{...baseline.reading,textSize:'medium'}};
await saveWorkspace(workspaceRef.current);const edited=await storage.read('workspace');
await assert.rejects(onApply(()=>transfer.rollback()),/changed after preview/);
assert.deepEqual(await storage.read('workspace'),edited);assert.equal(workspaceTransferBusy.current,false);
console.log('PASS guarded Undo after subsequent edits rejects and preserves imported roots/settings and those edits');
assert.equal(await fs.readFile(${JSON.stringify(join(directory, 'credentials.json'))},'utf8'),'FAKE SAMPLE SENTINEL');
`;
    const bundle = await build({
      stdin: { contents: source, resolveDir: root, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      plugins: [
        {
          name: 'sample-boundaries',
          setup(b) {
            b.onResolve({ filter: /^electron$/ }, () => ({
              path: 'electron',
              namespace: 'sample',
            }));
            b.onLoad({ filter: /.*/, namespace: 'sample' }, () => ({
              contents:
                'export const safeStorage=new Proxy({},{get(){throw Error("Keychain forbidden");}});',
            }));
            b.onResolve({ filter: /^node:fs\/promises$/ }, (a) =>
              /[\\/]storage\.ts$/.test(a.importer)
                ? { path: 'fs', namespace: 'gate' }
                : undefined,
            );
            b.onLoad({ filter: /.*/, namespace: 'gate' }, () => ({
              contents:
                "export * from 'node:fs/promises';import {writeFile as write} from 'node:fs/promises';export async function writeFile(file,contents,...args){await write(file,contents,...args);await globalThis.rendererStageGate?.(String(file),contents);}",
            }));
          },
        },
      ],
    });
    const file = join(directory, 'regression.mjs');
    await writeFile(file, bundle.outputFiles[0].contents);
    await import(pathToFileURL(file).href);
  } finally {
    delete (globalThis as Record<string, unknown>).rendererStageGate;
    await rm(directory, { recursive: true, force: true });
  }
});

// Exercise esbuild's parser and real resolver with generated specifiers. Windows
// paths use a resolver bridge on POSIX; their spelling must reach it intact.
test('generated renderer imports resolve paths with spaces, quotes and backslashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), "canopy import's space "));
  try {
    const actual = join(directory, 'fixture.ts');
    await writeFile(actual, 'export const sentinel = "resolved real fixture";');
    const paths = [
      actual,
      String.raw`C:\fixture space\quote's\module.ts`,
      '/fixture space/quote\'s/"double"/back\\slash.ts',
    ];
    for (const [index, path] of paths.entries()) {
      let resolved = false;
      const result = await build({
        stdin: {
          contents: `export {sentinel} from ${importPath(path)};`,
          resolveDir: directory,
          loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        plugins:
          index === 0
            ? []
            : [
                {
                  name: 'foreign-path-resolution',
                  setup(b) {
                    b.onResolve({ filter: /.*/ }, async (args) => {
                      if (args.importer !== '<stdin>') return;
                      assert.equal(args.path, path);
                      resolved = true;
                      return b.resolve(actual, {
                        resolveDir: directory,
                        kind: args.kind,
                      });
                    });
                  },
                },
              ],
      });
      if (index !== 0) assert.equal(resolved, true);
      const file = join(directory, `resolved-${index}.mjs`);
      await writeFile(file, result.outputFiles[0].contents);
      assert.equal(
        (await import(pathToFileURL(file).href)).sentinel,
        'resolved real fixture',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
