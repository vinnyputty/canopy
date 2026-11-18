import { WorkspaceTransferReloadError } from '../src/renderer/workspace-error';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build, transformSync } from 'esbuild';
import { rendererFixture, gate } from './fixtures/workspace-close';
import {
  callback as callbackOf,
  execute,
  findNode,
  sourceFile,
} from './source-probe';

const rendererSource =
  process.env.CANOPY_TRANSFER_RENDERER_SOURCE ??
  process.env.CANOPY_CLOSE_RENDERER_SOURCE ??
  'src/renderer/App.tsx';

const importPath = (path: string) => JSON.stringify(path);

// Extract production callbacks rather than reproducing the renderer's persistence controller.
test('held import and reload reject old-renderer saves and preserve actual imported data and Undo', async () => {
  const root = resolve('.');
  const text = await readFile(rendererSource, 'utf8');
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
  const closeFlush = find(
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'window.canopy.onWorkspaceFlush',
  ) as ts.CallExpression;
  const mainText = await readFile(
    process.env.CANOPY_TRANSFER_MAIN_SOURCE ?? 'src/main/app.ts',
    'utf8',
  );
  const mainAst = ts.createSourceFile(
    'app.ts',
    mainText,
    ts.ScriptTarget.Latest,
    true,
  );
  function mainCallback(name: string) {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === name)
        result = node.initializer;
      if (
        name === 'close' &&
        ts.isCallExpression(node) &&
        node.expression.getText(mainAst) === 'created.on' &&
        node.arguments[0]?.getText(mainAst) === "'close'"
      )
        result = node.arguments[1];
      if (ts.isPropertyAssignment(node) && node.name.getText(mainAst) === name)
        result = node.initializer;
      if (ts.isClassDeclaration(node) && node.name?.text === name)
        result = node;
      ts.forEachChild(node, visit);
    }
    visit(mainAst);
    assert.ok(result, 'Production main close callback not found');
    return result.getText(mainAst);
  }
  const preload = transformSync(await readFile('src/main/preload.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const directory = await mkdtemp(join(tmpdir(), 'canopy-renderer-transfer-'));
  try {
    const source = `
import assert from 'node:assert/strict'; import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {withScrollPositions} from ${importPath(root + '/src/renderer/scroll-position')};
import {Storage} from ${importPath(root + '/src/main/storage')};
import {WorkspaceClose} from ${importPath(root + '/src/renderer/workspace-close')};
import {WorkspaceTransferReloadError,workspaceError} from ${importPath(root + '/src/renderer/workspace-error')};
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
const persisted=value=>JSON.parse(JSON.stringify(value));
const workspaceRef={current:baseline},pendingWorkspaceSave={current:Promise.resolve()},workspaceSaveTimer={current:null},workspaceTransferBusy={current:false},workspaceTransferCommitted={current:false},workspaceLoaded={current:true},appearanceSaving={current:false},demoResetting={current:false};
const workspaceClose={current:new WorkspaceClose()},workspaceTransferReload={current:undefined};
const document={body:{inert:false},activeElement:null,defaultView:{HTMLElement:class{},addEventListener(){},removeEventListener(){}}};
const flushSync=operation=>operation(), scrollSaveTimer={current:undefined};
const workspaceLoadError='Fixture initial read failed';
${mainCallback('WorkspaceLoadFailure')}
${mainCallback('WorkspaceSnapshotUnconfirmed')}
const scrollPositions={current:new Map()};
let reportedErrors={};const setErrors=update=>reportedErrors=update(reportedErrors);
let active=false,dialog='backup',reload;
const setWorkspaceTransferActive=value=>active=value, setDialog=value=>dialog=typeof value==='function'?value(dialog):value;
const setAppearancePreview=()=>{},setWorkspace=value=>workspaceRef.current=typeof value==='function'?value(workspaceRef.current):value;
let savingWorkspace=Promise.resolve(),receivedWorkspace,retryUnavailableWorkspace=false;
let committedTransferOwner;
const pendingWorkspaceTransfers=new Set();
const trackWorkspaceTransfer=${mainCallback('trackWorkspaceTransfer')};
const useCallback=fn=>fn;const storeWorkspace=setWorkspace;
const reloadTransferredWorkspace=${(find((n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'reloadTransferredWorkspace') as ts.VariableDeclaration).initializer!.getText(ast)};

const window={clearTimeout(){},canopy:{workspaceReloadFailed:async()=>{},workspaceInitialized:async()=>{},saveWorkspace:value=>{receivedWorkspace=value;return savingWorkspace=storage.write('workspace',value);},reloadWorkspace:()=>reload?.()}};
const text=value=>{assert.equal(typeof value,'string');return value;};
const applyWorkspaceImport=${mainCallback('applyWorkspaceImport')},rollbackWorkspaceImport=${mainCallback('rollbackWorkspaceImport')};
const saveWorkspace=${save.arguments[0].getText(ast)},productionOnApply=${attribute(panel.attributes, 'onApply')},onApply=operation=>productionOnApply(async beforeTransfer=>{await beforeTransfer();return operation();}),flush=${attribute(panel.attributes, 'flush')},onSave=${attribute(appearance.attributes, 'onSave')},close=${attribute(backupDialog.attributes, 'onClose')},onKey=${onKey.initializer!.getText(ast)};
const workspaceCloseFlush=${closeFlush.arguments[0].getText(ast)};
let preloadApi;
const ipcRenderer=Object.assign(new EventEmitter(),{invoke:async(channel,...args)=>window.canopy[channel.slice('canopy:'.length)](...args)});
runInNewContext(${JSON.stringify(preload)},{exports:{},require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name,api)=>preloadApi=api}})});
preloadApi.onWorkspaceFlush(workspaceCloseFlush,${closeFlush.arguments[1].getText(ast)});
let closeSequence=0;
async function attemptMainQuit({unavailable=false,onPending=async()=>{},consent=0,initialFailure=false,allowTimeout=false}={}) {
  let closing=false,closingWindow,closeApproved=false,quitting=true,handoffCanceled=false,closed=false,quitCalls=0,prevented=false;
  let expireClose,prompts=0;const warnings=[];
  const setTimeout=(callback,ms)=>{const timer=globalThis.setTimeout(callback,ms);if(ms===15000)expireClose=()=>{clearTimeout(timer);callback();};return timer;};
  let complete;const done=new Promise(resolve=>complete=resolve),errors=[];
  const console={error:(...args)=>{errors.push(args);complete();}};
  const created=new EventEmitter();created.webContents=Object.assign(new EventEmitter(),{isCrashed:()=>unavailable,executeJavaScript:script=>runInNewContext(script,{window:{canopy:preloadApi}}),send:(channel,id)=>ipcRenderer.emit(channel,{},id)});
  created.isDestroyed=()=>closed;created.destroy=()=>{closed=true;created.emit('closed');if(workspaceClose.current.owner!==undefined)ipcRenderer.emit('canopy:workspaceCloseReleased',{},workspaceClose.current.owner);complete();};
  let workspaceOwner=created,workspaceInitializationError;
  const rendererUnavailable=unavailable,rendererLoaded=Promise.resolve();
  const windowStateSaver={flush:async()=>{},resume(){}},handoffs={pause(){},resume(){}},saveBounds=()=>{};
  const dialog={showMessageBox:async(_window,options)=>{warnings.push(options);if(!unavailable&&!initialFailure&&!allowTimeout)throw Error('Healthy renderer must not require abandonment consent');prompts++;return {response:consent};}};
  const app={quit:()=>{quitCalls++;created.close();}};
  const flushRenderer=${mainCallback('flushRenderer')};
  const flushBeforeClose=${mainCallback('flushBeforeClose')};
  const onClose=${mainCallback('close')};
  created.close=()=>{if(closeApproved)created.destroy();else onClose({preventDefault(){prevented=true;}});};
  created.close();
  try {await onPending(()=>({closed,quitCalls,prevented,errors,prompts}),()=>expireClose());}
  catch(error) {expireClose?.();throw error;}
  let timeout;
  try {await Promise.race([done,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Main close did not settle')),5000);})]);}
  finally {clearTimeout(timeout);}
  return {closed,quitCalls,prevented,errors,prompts,warnings};
}
const backup=createBackup({...baseline,theme:'light',tabs:[],activeTabId:null,savedViews:[],activeSavedViewId:null},backupConnections);
const mapping=Object.fromEntries(backupConnections.map(c=>[c.id,c.id]));
await storage.write('workspace',baseline);
workspaceLoaded.current=false;workspaceRef.current={...baseline,theme:'system'};
assert.match((await workspaceCloseFlush()).initializationError,/workspace.*load/i);
assert.match(reportedErrors.workspace,/Couldn’t save workspace: Workspace has not loaded/);
assert.equal(await bytes(),JSON.stringify(baseline));
await assert.rejects(onSave('system','default'),/workspace.*load/i);
assert.equal(await bytes(),JSON.stringify(baseline));
const unloadedClose=await attemptMainQuit({initialFailure:true});assert.equal(unloadedClose.closed,false);assert.equal(unloadedClose.quitCalls,0);assert.match(String(unloadedClose.errors[0]?.[1]),/workspace.*load/i);assert.equal(await bytes(),JSON.stringify(baseline));
workspaceLoaded.current=true;workspaceRef.current=baseline;const loadedRetry=await attemptMainQuit();assert.equal(loadedRetry.closed,true);assert.deepEqual(loadedRetry.errors,[]);

await fs.writeFile(${JSON.stringify(join(directory, 'credentials.json'))},'FAKE SAMPLE SENTINEL');
const preview=await transfer.preview(backup,mapping,'replace');
let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
globalThis.rendererStageGate=async(file,contents)=>{if(file.includes('workspace.json.')&&file.endsWith('.tmp')&&JSON.parse(contents).theme==='light'){globalThis.rendererStageGate=undefined;enter();await held;}};
let reloadEnter,reloadRelease;const reloading=new Promise(r=>reloadEnter=r),reloadHeld=new Promise(r=>reloadRelease=r);reload=()=>{reloadEnter();return reloadHeld;};
let drain;pendingWorkspaceSave.current=new Promise(r=>drain=r);
const queued=assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
const applying=onApply(()=>applyWorkspaceImport(preview.token));drain();await queued;await entered;
const heldApplyBytes=await bytes();assert.equal(heldApplyBytes,JSON.stringify(baseline));
assert.equal(active,true);close();assert.equal(dialog,'backup');
let prevented=false;onKey({defaultPrevented:false,preventDefault(){prevented=true;}});assert.equal(prevented,true);
await assert.rejects(onSave('system','default'),/transfer is in progress/);
await assert.rejects(flush(),/transfer is in progress/);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
await assert.rejects(onApply(()=>rollbackWorkspaceImport()),/transfer is in progress/);
assert.equal(await bytes(),heldApplyBytes);
const heldClose=await attemptMainQuit({allowTimeout:true,onPending:async(state,expire)=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false,'Healthy close must wait for admitted Apply');await assert.rejects(onApply(()=>rollbackWorkspaceImport()),/Workspace is closing/);expire();}});assert.equal(heldClose.closed,false);assert.equal(heldClose.quitCalls,0);assert.match(String(heldClose.errors[0]?.[1]),/close deadline/i);assert.equal(await bytes(),heldApplyBytes);
const abandonedApplyClose=await attemptMainQuit({unavailable:true,onPending:async(state,expire)=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false);expire();}});
assert.equal(abandonedApplyClose.closed,false);assert.equal(abandonedApplyClose.prompts,1);assert.equal(abandonedApplyClose.quitCalls,0);assert.equal(pendingWorkspaceTransfers.size,1);assert.equal(await bytes(),heldApplyBytes);
const lostApplyClose=await attemptMainQuit({unavailable:true,onPending:async state=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false,'renderer loss must wait for held Apply with idle bounds');assert.equal(state().quitCalls,0);release();}});await reloading;
assert.equal(lostApplyClose.closed,true);assert.equal(lostApplyClose.prompts,0);assert.equal(lostApplyClose.quitCalls,1);assert.equal(pendingWorkspaceTransfers.size,0);
assert.equal(await bytes(),JSON.stringify(preview.workspace));
assert.deepEqual(await storage.read('workspace'),persisted(preview.workspace));
const committedHeldReloadBytes=await bytes();const committedClose=await attemptMainQuit();assert.equal(committedClose.closed,true);assert.equal(committedClose.quitCalls,1);assert.deepEqual(committedClose.errors,[]);assert.equal(await bytes(),committedHeldReloadBytes);
await assert.rejects(onSave('system','default'),/transfer is in progress/);
await assert.rejects(flush(),/transfer is in progress/);
reloadRelease();await applying;
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
assert.deepEqual(await storage.read('workspace'),persisted(preview.workspace));
console.log('PASS held actual staging, dismissal/global/direct saves, duplicate Apply, and held/completed reload preserve imported data');
// New renderer hydration owns its own open barrier and flushes before guarded Undo.
const beforeUndoFlush=await bytes();
workspaceRef.current=hydrate(recoverWorkspaceViews(await storage.read('workspace')));workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;
let undoEnter,undoRelease;const undoEntered=new Promise(r=>undoEnter=r),undoHeld=new Promise(r=>undoRelease=r);
globalThis.rendererStageGate=async(file,contents)=>{if(file.includes('workspace.json.')&&file.endsWith('.tmp')&&JSON.parse(contents).theme===baseline.theme){globalThis.rendererStageGate=undefined;undoEnter();await undoHeld;}};
let undoReloadEnter,undoReloadRelease;const undoReloading=new Promise(r=>undoReloadEnter=r),undoReloadHeld=new Promise(r=>undoReloadRelease=r);reload=()=>{undoReloadEnter();return undoReloadHeld;};
const undoing=onApply(()=>rollbackWorkspaceImport());await undoEntered;
const heldUndoBytes=await bytes();assert.deepEqual(JSON.parse(heldUndoBytes),JSON.parse(beforeUndoFlush));
assert.notEqual(heldUndoBytes,beforeUndoFlush);assert.equal(heldUndoBytes,JSON.stringify(workspaceRef.current));
// Exact comparisons detect even value-equivalent writes during the hold.
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},beforeUndoFlush);
const reorderedDuringHold=await bytes();assert.deepEqual(JSON.parse(reorderedDuringHold),JSON.parse(heldUndoBytes));assert.throws(()=>assert.equal(reorderedDuringHold,heldUndoBytes));
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},JSON.stringify({...JSON.parse(heldUndoBytes),theme:'system'}));
const changedDuringHold=await bytes();assert.throws(()=>assert.equal(changedDuringHold,heldUndoBytes));
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},heldUndoBytes);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);await assert.rejects(flush(),/transfer is in progress/);
assert.equal(await bytes(),heldUndoBytes);const lostUndoClose=await attemptMainQuit({unavailable:true,onPending:async state=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false,'renderer loss must wait for held Undo with idle bounds');assert.equal(state().quitCalls,0);undoRelease();}});await undoReloading;assert.equal(lostUndoClose.closed,true);assert.equal(lostUndoClose.prompts,0);assert.equal(pendingWorkspaceTransfers.size,0);
assert.equal(await bytes(),JSON.stringify(baseline));await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);
assert.equal(await bytes(),JSON.stringify(baseline));undoReloadRelease();await undoing;assert.deepEqual(await storage.read('workspace'),persisted(baseline));
console.log('PASS Undo after hydration and explicit flush restores original workspace');
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;workspaceRef.current=baseline;
await assert.rejects(onApply(async()=>{throw Error('failed transfer');}),/failed transfer/);assert.equal(active,false);await assert.doesNotReject(()=>saveWorkspace(baseline));
workspaceRef.current={...baseline,theme:'system'};const recoveredClose=await attemptMainQuit();assert.equal(recoveredClose.closed,true);assert.equal(recoveredClose.quitCalls,1);assert.deepEqual(recoveredClose.errors,[]);assert.equal((await storage.read('workspace')).theme,'system');workspaceRef.current=baseline;await saveWorkspace(baseline);
const regularSave=window.canopy.saveWorkspace;let operationCalled=false;const beforeRejectedFlush=await bytes();window.canopy.saveWorkspace=async()=>{throw Error('pre-transfer save failed');};
await assert.rejects(onApply(async()=>{operationCalled=true;}),/pre-transfer save failed/);assert.equal(operationCalled,false);assert.equal(workspaceTransferBusy.current,false);assert.equal(active,false);assert.equal(await bytes(),beforeRejectedFlush);
window.canopy.saveWorkspace=regularSave;workspaceRef.current={...baseline,theme:'system'};const preflushRecoveredClose=await attemptMainQuit();assert.equal(preflushRecoveredClose.closed,true);assert.deepEqual(preflushRecoveredClose.errors,[]);assert.equal((await storage.read('workspace')).theme,'system');workspaceRef.current=baseline;await saveWorkspace(baseline);
const next=await transfer.preview(backup,mapping,'replace');reload=()=>{throw Error('reload failed');};
await assert.rejects(onApply(()=>transfer.apply(next.token)),/Restart Canopy/);
await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);assert.deepEqual(await storage.read('workspace'),persisted(next.workspace));
const failedReloadBytes=await bytes();const restartClose=await attemptMainQuit();assert.equal(restartClose.closed,true);assert.equal(restartClose.quitCalls,1);assert.deepEqual(restartClose.errors,[]);assert.equal(workspaceTransferBusy.current,true);assert.equal(await bytes(),failedReloadBytes);await assert.rejects(saveWorkspace(baseline),/transfer is in progress/);assert.equal(await bytes(),failedReloadBytes);
console.log('PASS failed transfer restores normal quit; failed reload after committed transfer retains old-document barrier and permits clean quit without changing bytes');
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;reload=()=>{};
workspaceRef.current={...migrateViews(recoverWorkspaceViews(await storage.read('workspace'))),reading:{...baseline.reading,textSize:'medium'}};
await saveWorkspace(workspaceRef.current);const edited=await storage.read('workspace');
await assert.rejects(onApply(()=>rollbackWorkspaceImport()),/changed after preview/);
assert.deepEqual(await storage.read('workspace'),persisted(edited));assert.equal(workspaceTransferBusy.current,false);
console.log('PASS guarded Undo after subsequent edits rejects and preserves imported roots/settings and those edits');
assert.equal(await fs.readFile(${JSON.stringify(join(directory, 'credentials.json'))},'utf8'),'FAKE SAMPLE SENTINEL');
async function transferDuringCloseSave(operation) {
  let saveEnter,saveRelease;
  const saveEntered=new Promise(r=>saveEnter=r),saveHeld=new Promise(r=>saveRelease=r);
  globalThis.rendererStageGate=async(file)=>{if(file.includes('workspace.json.')&&file.endsWith('.tmp')){globalThis.rendererStageGate=undefined;saveEnter();await saveHeld;}};
  const closing=attemptMainQuit();await saveEntered;
  let operationCalled=false;
  await assert.rejects(onApply(async()=>{operationCalled=true;return operation();}),/Workspace is closing/);
  assert.equal(operationCalled,false);
  assert.equal(workspaceClose.current.paused,true);
  saveRelease();
  const result=await closing;
  assert.equal(result.closed,true);
  assert.equal(result.quitCalls,1);
  assert.deepEqual(result.errors,[]);
  assert.equal(workspaceTransferCommitted.current,false);
}
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;workspaceRef.current=baseline;reload=()=>{};
await saveWorkspace(baseline);
const concurrentPreview=await transfer.preview(backup,mapping,'replace');
await transferDuringCloseSave(()=>transfer.apply(concurrentPreview.token));
assert.equal(await bytes(),JSON.stringify(baseline));
workspaceRef.current=hydrate(recoverWorkspaceViews(await storage.read('workspace')));workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;
await transferDuringCloseSave(()=>rollbackWorkspaceImport());
assert.equal(await bytes(),JSON.stringify(workspaceRef.current));
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;workspaceRef.current=baseline;
const ordinaryClose=await attemptMainQuit();assert.equal(ordinaryClose.closed,true);assert.equal(ordinaryClose.quitCalls,1);assert.deepEqual(ordinaryClose.errors,[]);
console.log('PASS numbered preload close pauses input and refuses new Apply/Undo during final save; ordinary close recovers');
async function healthyTransferClose(operation,expected) {
  let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  const applying=onApply(async()=>{enter();await held;return operation();});await entered;
  const closing=await attemptMainQuit({onPending:async state=>{
    await new Promise(r=>setImmediate(r));assert.equal(state().closed,false);
    assert.equal(workspaceClose.current.paused,true);
    await assert.rejects(onApply(()=>Promise.resolve()),/Workspace is closing/);
    release();
  }});
  await applying;
  assert.equal(closing.closed,true);assert.deepEqual(closing.errors,[]);
  assert.equal(await bytes(),JSON.stringify(expected));
}
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;workspaceRef.current=baseline;
const healthyPreview=await transfer.preview(backup,mapping,'replace');
await healthyTransferClose(()=>applyWorkspaceImport(healthyPreview.token),healthyPreview.workspace);
workspaceRef.current=hydrate(recoverWorkspaceViews(await storage.read('workspace')));workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;
await healthyTransferClose(()=>rollbackWorkspaceImport(),baseline);
workspaceTransferBusy.current=false;workspaceClose.current.endTransfer();workspaceTransferReload.current=undefined;active=false;workspaceRef.current=baseline;
let failHealthyEnter,failHealthyRelease;const failHealthyEntered=new Promise(r=>failHealthyEnter=r),failHealthyHeld=new Promise(r=>failHealthyRelease=r);
const rejectedTransfer=assert.rejects(onApply(async()=>{failHealthyEnter();await failHealthyHeld;throw Error('healthy held failure');}),/healthy held failure/);
await failHealthyEntered;
const healthyFailedClose=await attemptMainQuit({onPending:async state=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false);failHealthyRelease();}});
await rejectedTransfer;assert.equal(healthyFailedClose.closed,true);assert.deepEqual(healthyFailedClose.errors,[]);assert.equal(workspaceTransferBusy.current,false);
assert.equal(await bytes(),JSON.stringify(baseline));await saveWorkspace(baseline);
console.log('PASS healthy close awaits admitted Apply/Undo commit and saves available workspace after precommit failure');

const failurePreview=await transfer.preview(backup,mapping,'replace');
let failEnter,failRelease;const failEntered=new Promise(r=>failEnter=r),failHeld=new Promise(r=>failRelease=r);
globalThis.rendererStageGate=async(file,contents)=>{if(file.includes('workspace.json.')&&file.endsWith('.tmp')&&JSON.parse(contents).theme==='light'){globalThis.rendererStageGate=undefined;failEnter();await failHeld;throw Error('held transfer storage failure');}};
const failingApply=onApply(()=>applyWorkspaceImport(failurePreview.token));
const failedApply=assert.rejects(failingApply,/held transfer storage failure/);await failEntered;
const failedClose=await attemptMainQuit({unavailable:true,onPending:async state=>{await new Promise(r=>setImmediate(r));assert.equal(state().closed,false);failRelease();await failedApply;}});
assert.equal(failedClose.closed,false);assert.equal(failedClose.prompts,1);assert.equal(failedClose.quitCalls,0);assert.equal(pendingWorkspaceTransfers.size,0);assert.equal(workspaceTransferBusy.current,false);assert.equal(await bytes(),JSON.stringify(baseline));
assert.equal((await fs.readdir(${JSON.stringify(directory)})).some(name=>name.endsWith('.tmp')),false);
const failedTransferRetry=await attemptMainQuit({unavailable:true});assert.equal(failedTransferRetry.closed,true);assert.equal(failedTransferRetry.prompts,0);
console.log('PASS unavailable renderer warns on failed transfer, preserves original bytes, cleans staging, and retries close');
const unreadableBytes='{unreadable saved workspace fixture';
await fs.writeFile(${JSON.stringify(join(directory, 'workspace.json'))},unreadableBytes);
workspaceLoaded.current=false;
for(const choice of [0,0,1]){
  await assert.rejects(storage.read('workspace'),/Could not read saved workspace/);
  await assert.rejects(saveWorkspace(baseline),/not loaded/);
  const result=await attemptMainQuit({initialFailure:true,consent:choice});
  assert.equal(result.closed,choice===1);assert.equal(result.prompts,1);assert.equal(result.quitCalls,choice===1?1:0);
  assert.equal(await bytes(),unreadableBytes);
  assert.equal(result.warnings[0].defaultId,0);assert.equal(result.warnings[0].cancelId,0);
  assert.match(result.warnings[0].detail,/saved workspace will be left unchanged/);
  assert.doesNotMatch(result.warnings[0].detail,/renderer is unavailable/i);
}
console.log('PASS repeated unreadable file keeps exact bytes through Keep open, cancel and explicit Close anyway');



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
              /[\\/](storage|replace-file)\.ts$/.test(a.importer)
                ? { path: 'fs', namespace: 'gate' }
                : undefined,
            );
            b.onLoad({ filter: /.*/, namespace: 'gate' }, () => ({
              contents:
                "export * from 'node:fs/promises';import {open as nativeOpen,writeFile as write} from 'node:fs/promises';export async function open(file,...args){const handle=await nativeOpen(file,...args),writeHandle=handle.writeFile.bind(handle);handle.writeFile=async(contents,...writeArgs)=>{const result=await writeHandle(contents,...writeArgs);await globalThis.rendererStageGate?.(String(file),contents);return result;};return handle;}export async function writeFile(file,contents,...args){await write(file,contents,...args);await globalThis.rendererStageGate?.(String(file),contents);}",
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

for (const outcome of ['success', 'disconnect-failure', 'write-failure'])
  test(`Disconnect settlement preserves final snapshot semantics through ${outcome}`, async () => {
    const source = sourceFile(rendererSource);
    const connections = findNode(
      source,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === 'Connections',
    );
    const attribute = connections.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) && property.name.getText() === 'disconnect',
    ) as ts.JsxAttribute;
    const document = {
      body: { inert: false },
      activeElement: null,
      defaultView: {
        HTMLElement: class {},
        addEventListener() {},
        removeEventListener() {},
      },
    };
    const pending = gate();
    const h = rendererFixture(
      document as unknown as Document,
      async () => {
        if (outcome === 'write-failure')
          throw Error('final workspace write failed');
      },
      true,
      rendererSource,
    );
    const initial = {
      ...h.workspaceRef.current,
      closedTabs: [],
      tabs: [
        {
          id: 'old',
          connectionId: 'old',
          rootKey: 'OLD-1',
          expanded: [],
          hideDone: false,
          scrollTop: 0,
        },
      ],
      activeTabId: 'old',
    };
    h.setWorkspace(initial);
    let completed = false;
    const disconnect = execute(
      (attribute.initializer as ts.JsxExpression).expression!.getText(),
      {
        ...h.context,
        window: { canopy: { disconnect: () => pending.promise } },
      },
    );
    try {
      const accepted = disconnect('old', () => {
        completed = true;
        h.context.storeWorkspace({ ...initial, tabs: [], activeTabId: null });
      });
      const settled =
        outcome === 'disconnect-failure'
          ? assert.rejects(accepted, /disconnect refused/)
          : accepted;
      const closing = h.api.flushWorkspace(1);
      const flushed =
        outcome === 'write-failure'
          ? assert.rejects(closing, /final workspace write failed/)
          : closing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(h.writes.length, 0);
      assert.deepEqual(h.saveArguments, []);
      assert.equal(completed, false);
      await assert.rejects(
        disconnect('old', () => {}),
        /Workspace is closing/,
      );
      if (outcome === 'disconnect-failure')
        pending.reject(Error('disconnect refused'));
      else pending.release();
      await settled;
      await flushed;
      assert.equal(completed, outcome !== 'disconnect-failure');
      if (outcome === 'write-failure') {
        assert.match(h.errors().workspace, /final workspace write failed/);
        assert.equal(h.saveArguments.length, 1);
        assert.deepEqual(h.saveArguments.at(-1)![0], {
          ...initial,
          tabs: [],
          activeTabId: null,
        });
      } else {
        assert.deepEqual(
          h.writes.at(-1),
          outcome === 'disconnect-failure'
            ? initial
            : { ...initial, tabs: [], activeTabId: null },
        );
        assert.equal(h.errors().workspace, undefined);
      }
    } finally {
      pending.release();
      h.dispose();
    }
  });

for (const kind of ['apply', 'undo'])
  for (const outcome of [
    'close',
    'keep-open',
    'reload-failure',
    'save-failure',
    'transfer-failure',
  ])
    test(`real preload ${kind} admission across held pre-transfer save: ${outcome}`, async () => {
      const { JSDOM } = createRequire(import.meta.url)('jsdom');
      const d = new JSDOM('<body><button>Edit</button>', {
        pretendToBeVisual: true,
      });
      d.window.document.body.inert = false;
      const focus = d.window.document.querySelector('button');
      focus.focus();
      const held = gate();
      let disk = '';
      const h = rendererFixture(
        d.window.document,
        async (value) => {
          disk = JSON.stringify(value);
        },
        false,
        rendererSource,
      );
      h.context.pendingWorkspaceSave.current = held.promise;
      const ast = sourceFile(rendererSource);
      const panel = findNode(
        ast,
        (node): node is ts.JsxSelfClosingElement =>
          ts.isJsxSelfClosingElement(node) &&
          node.tagName.getText() === 'WorkspaceBackupPanel',
      );
      const attribute = panel.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onApply',
      ) as ts.JsxAttribute;
      const reloadRef = { current: undefined as Promise<void> | undefined };
      let transfers = 0,
        reloads = 0;
      h.workspaceRef.current = { ...h.workspaceRef.current, theme: 'dark' };
      disk = JSON.stringify({ ...h.workspaceRef.current, theme: 'system' });
      const committed = JSON.stringify({
        ...h.workspaceRef.current,
        theme: 'light',
      });
      h.forward(async (name) => {
        if (name === 'canopy:reloadWorkspace') {
          reloads++;
          if (outcome === 'reload-failure') throw Error('reload refused');
          return;
        }
        if (name === 'canopy:update' || name === 'canopy:workspaceReloadFailed')
          return;
        assert.equal(
          name,
          kind === 'apply'
            ? 'canopy:applyWorkspaceImport'
            : 'canopy:rollbackWorkspaceImport',
        );
        transfers++;
        if (outcome === 'transfer-failure') throw Error('transfer refused');
        disk = committed;
        return JSON.parse(committed);
      });
      h.context.reloadTransferredWorkspace = execute(
        callbackOf(ast, 'reloadTransferredWorkspace'),
        { ...h.context, workspaceTransferReload: reloadRef },
      );
      let redraws = 0;
      const storeWorkspace = h.context.storeWorkspace;
      h.context.storeWorkspace = (update) => {
        redraws++;
        storeWorkspace(update);
      };
      h.register();
      const onApply = execute(
        (attribute.initializer as ts.JsxExpression).expression!.getText(),
        {
          ...h.context,
          saveWorkspace: h.save,
          setWorkspaceTransferActive() {},
        },
      );
      const panelAst = sourceFile('src/renderer/WorkspaceBackupPanel.tsx');
      const call = findNode(
        panelAst,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          node.expression.getText() === 'onApply' &&
          node.arguments[0]
            .getText()
            .includes(
              kind === 'apply'
                ? 'applyWorkspaceImport'
                : 'rollbackWorkspaceImport',
            ),
      );
      const operation = execute(call.arguments[0].getText(), {
        window: { canopy: h.api },
        token: 'accepted',
      });
      const applying = onApply(operation);
      const observed =
        outcome === 'save-failure' || outcome === 'transfer-failure'
          ? assert.rejects(applying, /save refused|transfer refused/)
          : applying;
      assert.equal(d.window.document.body.inert, true);
      assert.throws(
        () => h.controller.beginTransfer(d.window.document),
        /transfer is in progress/,
      );
      await assert.rejects(
        h.controller.track(async () => {}),
        /transfer is in progress/,
      );
      let clicks = 0;
      focus.addEventListener('click', () => clicks++);
      focus.click();
      assert.equal(clicks, 0);
      const original = h.workspaceRef.current;
      h.setWorkspace((value: any) => ({ ...value, theme: 'dark' }));
      assert.equal(h.workspaceRef.current, original);
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        h.api.update('sample', 'ONE', {}),
        /transfer is in progress/,
      );
      await assert.rejects(
        h.api.saveWorkspace(original),
        /transfer is in progress/,
      );
      assert.equal(transfers, 0);
      let closeSettled = false;
      const closing = assert
        .doesNotReject(() => h.api.flushWorkspace(7))
        .then(() => {
          closeSettled = true;
        });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.controller.paused, true);
      assert.equal(
        closeSettled,
        false,
        'close must await the held transfer save',
      );
      for (const method of [
        () => h.api.applyWorkspaceImport('late'),
        () => h.api.rollbackWorkspaceImport(),
      ])
        await assert.rejects(method, /Workspace is closing/);
      if (outcome === 'save-failure') {
        // The production save closure already holds the API object.
        const originalSave = h.api.saveWorkspace;
        h.api.saveWorkspace = async () => {
          h.api.saveWorkspace = originalSave;
          throw Error('save refused');
        };
        held.release();
        await assert.doesNotReject(() => observed);
        h.api.saveWorkspace = originalSave;
      } else {
        held.release();
        await assert.doesNotReject(() => observed);
      }
      await closing;
      assert.equal(closeSettled, true);
      if (outcome === 'save-failure' || outcome === 'transfer-failure')
        assert.equal(
          JSON.stringify(h.writes.at(-1)),
          JSON.stringify(h.workspaceRef.current),
          'failed transfer close saves current payload',
        );
      assert.equal(transfers, outcome === 'save-failure' ? 0 : 1);
      assert.equal(reloads, 0, 'reload must defer while close owns the pause');
      const failed =
        outcome === 'save-failure' || outcome === 'transfer-failure';
      if (failed) {
        assert.equal(
          h.writes.length,
          outcome === 'save-failure' ? 1 : 2,
          'failed transfer must perform its final close write',
        );
        assert.equal(h.saveArguments.at(-1)![1], true);
      }
      assert.equal(h.controller.blocked, true);
      const beforeRelease = redraws;
      h.release(6);
      assert.equal(
        redraws,
        beforeRelease,
        'stale release cannot redraw or retry',
      );
      assert.equal(h.controller.paused, true);
      assert.equal(reloads, 0);
      if (outcome !== 'close') {
        h.release(7);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.controller.paused, false);
        assert.equal(h.controller.blocked, !failed);
        assert.equal(d.window.document.body.inert, !failed);
        assert.equal(reloads, failed ? 0 : 1);
        if (outcome === 'reload-failure')
          assert.match(h.errors().workspace, /Restart Canopy/);
        if (failed) {
          assert.equal(d.window.document.activeElement, focus);
          focus.click();
          assert.equal(clicks, 1);
          h.setWorkspace((value: any) => ({ ...value, theme: 'light' }));
          assert.equal(h.workspaceRef.current.theme, 'light');
          await assert.doesNotReject(() => h.api.update('sample', 'ONE', {}));
        } else {
          await assert.rejects(h.save(original), /transfer is in progress/);
          const count = h.writes.length;
          await h.api.flushWorkspace(8);
          assert.equal(
            h.writes.length,
            count,
            'committed transfer close preserves disk',
          );
          assert.equal(disk, committed);
          h.release(8);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            reloads,
            outcome === 'reload-failure' ? 2 : 1,
            'release retries failure and reuses successful reload',
          );
        }
      }
      assert.equal(disk, failed ? JSON.stringify(original) : committed);
      h.dispose();
      d.window.close();
    });

for (const dialogFailure of [false, true])
  test(`failed transfer reload reports natively and preserves barriers: dialog failure=${dialogFailure}`, async () => {
    const { JSDOM } = createRequire(import.meta.url)('jsdom');
    const d = new JSDOM('<body><button>Edit</button>', {
      pretendToBeVisual: true,
    });
    d.window.document.body.inert = false;
    const rendererSource =
      process.env.CANOPY_TRANSFER_RENDERER_SOURCE ??
      process.env.CANOPY_CLOSE_RENDERER_SOURCE ??
      'src/renderer/App.tsx';
    const h = rendererFixture(
      d.window.document,
      async () => {},
      true,
      rendererSource,
    );
    const message = gate();
    const original = Error('reload refused');
    let reports = 0;
    let reloads = 0;
    h.forward(async (name) => {
      if (name === 'canopy:rollbackWorkspaceImport')
        return h.workspaceRef.current;
      if (name === 'canopy:reloadWorkspace') {
        reloads++;
        throw original;
      }
      assert.equal(name, 'canopy:workspaceReloadFailed');
      reports++;
      assert.equal(d.window.document.body.inert, true);
      assert.equal(h.controller.blocked, true);
      await message.promise;
    });
    await h.api.rollbackWorkspaceImport();
    h.controller.beginTransfer(d.window.document);
    const ref = { current: undefined as Promise<void> | undefined };
    const reload = execute(
      callbackOf(sourceFile(rendererSource), 'reloadTransferredWorkspace'),
      { ...h.context, workspaceTransferReload: ref },
    );
    let settled = false;
    const result = reload().finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(result, (error) => {
      assert.equal(
        (error as Error).message,
        'Workspace transferred, but reload failed. Restart Canopy before editing.',
      );
      assert.equal((error as Error).cause, original);
      return true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(reports, 1);
      assert.equal(reloads, 1);
      assert.equal(settled, false);
      assert.equal(reload(), ref.current, 'in-flight recovery must be reused');
      await assert.rejects(
        h.api.update('sample', 'SAMPLE-1', { summary: 'blocked' }),
        /transfer is in progress/,
      );
      await assert.rejects(
        h.api.saveWorkspace(h.workspaceRef.current),
        /transfer is in progress/,
      );
      if (dialogFailure) message.reject(Error('native dialog unavailable'));
      else message.release();
      await rejected;
      assert.ok(
        ref.current === undefined,
        'completed recovery must release the retry promise',
      );
      assert.equal(h.controller.blocked, true);
      assert.equal(d.window.document.body.inert, true);
      assert.equal(h.writes.length, 0);
      assert.equal(reports, 1);
      h.setWorkspace((value: typeof h.workspaceRef.current) => ({
        ...value,
        theme: 'light',
      }));
      assert.equal(h.workspaceRef.current.theme, 'system');
    } finally {
      message.release();
      await rejected;
      h.dispose();
      h.controller.endTransfer();
      d.window.close();
    }
  });
