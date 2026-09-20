import { contextBridge, ipcRenderer } from 'electron';
import type { CanopyAPI } from '../shared/types';
const api: CanopyAPI = {
  currentUser: (id) => ipcRenderer.invoke('canopy:currentUser', id),
  connections: () => ipcRenderer.invoke('canopy:connections'),
  connect: (input) => ipcRenderer.invoke('canopy:connect', input),
  disconnect: (id) => ipcRenderer.invoke('canopy:disconnect', id),
  tree: (id, key) => ipcRenderer.invoke('canopy:tree', id, key),
  preview: (id, key) => ipcRenderer.invoke('canopy:preview', id, key),
  copyText: (value) => ipcRenderer.invoke('canopy:copyText', value),
  search: (id, query, options) =>
    ipcRenderer.invoke('canopy:search', id, query, options),
  cancelSearch: (id, requestId) =>
    ipcRenderer.invoke('canopy:cancelSearch', id, requestId),
  priorities: (id, key, refresh) =>
    ipcRenderer.invoke('canopy:priorities', id, key, refresh),
  transitions: (id, key, refresh) =>
    ipcRenderer.invoke('canopy:transitions', id, key, refresh),
  invalidateChoices: (id, key) =>
    ipcRenderer.invoke('canopy:invalidateChoices', id, key),
  cachedUsers: (id) => ipcRenderer.invoke('canopy:cachedUsers', id),
  assignees: (id, key, query, startAt, refresh) =>
    ipcRenderer.invoke('canopy:assignees', id, key, query, startAt, refresh),
  validateAssignee: (id, key, accountId, refresh) =>
    ipcRenderer.invoke('canopy:validateAssignee', id, key, accountId, refresh),
  update: (id, key, patch) =>
    ipcRenderer.invoke('canopy:update', id, key, patch),
  rank: (id, key, before, position) =>
    ipcRenderer.invoke('canopy:rank', id, key, before, position),
  priorityOrder: (id, keys) =>
    ipcRenderer.invoke('canopy:priorityOrder', id, keys),
  loadWorkspace: () => ipcRenderer.invoke('canopy:loadWorkspace'),
  saveWorkspace: (workspace) =>
    ipcRenderer.invoke('canopy:saveWorkspace', workspace),
  copyIssueLink: (id, key) =>
    ipcRenderer.invoke('canopy:copyIssueLink', id, key),
  openIssue: (id, key) => ipcRenderer.invoke('canopy:openIssue', id, key),
};
contextBridge.exposeInMainWorld('canopy', api);
