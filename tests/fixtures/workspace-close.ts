import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { WorkspaceClose } from '../../src/renderer/workspace-close';
import type { CanopyAPI, Workspace } from '../../src/shared/types';
import { withScrollPositions } from '../../src/renderer/scroll-position';
import { callback, execute, findNode, sourceFile } from '../source-probe';

export function gate() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    release = yes;
    reject = no;
  });
  return { promise, release, reject };
}

export function rendererFixture(
  document: Document,
  write: (value: Workspace) => Promise<void> = async () => {},
  registerImmediately = true,
) {
  const source = sourceFile(
    process.env.CANOPY_CLOSE_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
  );
  const controller = new WorkspaceClose();
  const workspaceClose = { current: controller };
  const workspaceRef = {
    current: {
      tabs: [],
      activeTabId: null,
      theme: 'system',
      shortcuts: {},
      sidebarCollapsed: false,
    } as Workspace,
  };
  const calls: string[] = [],
    writes: Workspace[] = [];
  let errors: Record<string, string> = {};
  let api!: CanopyAPI;
  const ipc = Object.assign(new EventEmitter(), {
    invoke: async (name: string, value: Workspace) => {
      calls.push(name);
      if (name === 'canopy:saveWorkspace') {
        await write(value);
        writes.push(structuredClone(value));
      }
    },
  });
  const preload = transformSync(
    readFileSync(
      process.env.CANOPY_CLOSE_PRELOAD_SOURCE ?? 'src/main/preload.ts',
      'utf8',
    ),
    { loader: 'ts', format: 'cjs' },
  ).code;
  runInNewContext(preload, {
    exports: {},
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: {
        exposeInMainWorld: (_name: string, value: CanopyAPI) => {
          api = value;
        },
      },
    }),
  });
  const storeWorkspace = (
    update: Workspace | ((current: Workspace) => Workspace),
  ) => {
    workspaceRef.current =
      typeof update === 'function' ? update(workspaceRef.current) : update;
  };
  const context = {
    workspaceClose,
    workspaceRef,
    storeWorkspace,
    document,
    flushSync: (work: () => void) => work(),
    useCallback: (fn: unknown) => fn,
    workspaceLoaded: { current: true },
    workspaceTransferBusy: { current: false },
    workspaceTransferCommitted: { current: false },
    pendingWorkspaceSave: { current: Promise.resolve() },
    workspaceSaveTimer: { current: null },
    scrollSaveTimer: { current: undefined },
    demoResetting: { current: false },
    scrollPositions: { current: new Map<string, number>() },
    withScrollPositions,
    setErrors: (
      update: (current: Record<string, string>) => Record<string, string>,
    ) => {
      errors = update(errors);
    },
    window: { clearTimeout, canopy: api },
  };
  const save = execute(callback(source, 'saveWorkspace'), context);
  const setWorkspace = execute(callback(source, 'setWorkspace'), context);
  const registration = findNode(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'useLayoutEffect' &&
      node.getText().includes('window.canopy.onWorkspaceFlush('),
  );
  let dispose: (() => void) | undefined;
  const register = () => {
    dispose = execute(registration.arguments[0].getText(), {
      ...context,
      ready: true,
      saveWorkspace: save,
    })();
    return dispose!;
  };
  if (registerImmediately) register();
  const appearance = findNode(
    source,
    (node): node is ts.JsxSelfClosingElement =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText() === 'AppearanceDialog',
  );
  const onSave = appearance.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onSave',
  ) as ts.JsxAttribute;
  const saveAppearance = execute(
    (onSave.initializer as ts.JsxExpression).expression!.getText(),
    {
      ...context,
      saveWorkspace: save,
      setWorkspace,
      appearanceSaving: { current: false },
      setAppearancePreview() {},
      setDialog() {},
    },
  );
  return {
    api,
    register,
    dispose: () => dispose?.(),
    controller,
    workspaceRef,
    calls,
    writes,
    context,
    setWorkspace,
    save,
    saveAppearance,
    release: (attempt: number) =>
      ipc.emit('canopy:workspaceCloseReleased', {}, attempt),
    errors: () => errors,
    executeScript: (script: string) =>
      runInNewContext(script, { window: { canopy: api } }),
    route: (name: string) =>
      execute(callback(source, name), {
        ...context,
        useCallback: (fn: unknown) => fn,
      }),
  };
}
