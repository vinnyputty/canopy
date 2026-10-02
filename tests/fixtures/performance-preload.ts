import { contextBridge, ipcRenderer } from 'electron';
import type { TreeSnapshot } from '../../src/shared/types';

// Audit-only, identical in paired builds. Keep compact metadata, never retain
// additional issue snapshots or install this in ordinary application builds.
const events: object[] = [];
const requests = new Map<string, string>();
let serial = 0,
  generation = 0;
let armed: { generation: number; roots: Set<string> } | undefined;
const record = (
  event: string,
  root: string,
  snapshot?: TreeSnapshot,
  requestId?: string,
  manualGeneration?: number,
) => {
  events.push({
    event,
    root,
    requestId,
    manualGeneration,
    at: performance.now(),
    count: snapshot?.issues.length,
    incomplete: snapshot ? Boolean(snapshot.incomplete) : undefined,
  });
};
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel, ...args) => {
  if (channel !== 'canopy:tree') return invoke(channel, ...args);
  const root = String(args[1]),
    requestId = String(args[2] ?? `baseline-${++serial}`);
  const manualGeneration = armed?.roots.delete(root)
    ? armed.generation
    : undefined;
  requests.set(requestId, root);
  record('ipc-request', root, undefined, requestId, manualGeneration);
  try {
    const snapshot = await invoke(channel, ...args);
    record('ipc-delivery', root, snapshot, requestId, manualGeneration);
    return snapshot;
  } catch (error) {
    record('ipc-error', root, undefined, requestId, manualGeneration);
    throw error;
  } finally {
    requests.delete(requestId);
  }
};
ipcRenderer.on(
  'canopy:treeProgress',
  (_event, requestId: string, snapshot: TreeSnapshot) => {
    record(
      'ipc-progress',
      requests.get(requestId) ?? snapshot.rootKey,
      snapshot,
      requestId,
    );
  },
);
contextBridge.exposeInMainWorld('canopyPerfAudit', {
  events: () => ({
    events,
    timeOrigin: performance.timeOrigin,
    active: requests.size,
  }),
  arm: (roots: string[]) => {
    if (requests.size)
      throw new Error('Manual audit marker requires idle IPC roots.');
    armed = { generation: ++generation, roots: new Set(roots) };
    return generation;
  },
});
// Bundle the exact source's preload as a lazy require for sandbox compatibility;
// instrumentation is installed first.
require('canopy:production-preload');
