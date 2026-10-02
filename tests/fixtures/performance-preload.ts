import { contextBridge, ipcRenderer } from 'electron';
import type { TreeSnapshot } from '../../src/shared/types';

// Audit-only, identical in paired builds. Keep compact metadata, never retain
// additional issue snapshots or install this in ordinary application builds.
const events: object[] = [];
const requests = new Map<string, string>();
const record = (
  event: string,
  root: string,
  snapshot?: TreeSnapshot,
  requestId?: string,
) => {
  events.push({
    event,
    root,
    requestId,
    at: performance.now(),
    count: snapshot?.issues.length,
    incomplete: snapshot ? Boolean(snapshot.incomplete) : undefined,
  });
};
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel, ...args) => {
  if (channel !== 'canopy:tree') return invoke(channel, ...args);
  const root = String(args[1]),
    requestId = String(args[2] ?? 'baseline');
  requests.set(requestId, root);
  record('ipc-request', root, undefined, requestId);
  try {
    const snapshot = await invoke(channel, ...args);
    record('ipc-delivery', root, snapshot, requestId);
    return snapshot;
  } catch (error) {
    record('ipc-error', root, undefined, requestId);
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
  events: () => ({ events, timeOrigin: performance.timeOrigin }),
});
// Bundle the exact source's preload as a lazy require for sandbox compatibility;
// instrumentation is installed first.
require('canopy:production-preload');
