import { contextBridge, ipcRenderer } from 'electron';
import type { CanopyAPI } from '../shared/types';
const api: CanopyAPI = {
  currentUser: (id) => ipcRenderer.invoke('canopy:currentUser', id),
  connections: () => ipcRenderer.invoke('canopy:connections'),
  connect: (input) => ipcRenderer.invoke('canopy:connect', input),
  disconnect: (id) => ipcRenderer.invoke('canopy:disconnect', id),
  tree: (id, key) => ipcRenderer.invoke('canopy:tree', id, key),
  search: (id, query) => ipcRenderer.invoke('canopy:search', id, query),
  editOptions: (id, key, query) =>
    ipcRenderer.invoke('canopy:editOptions', id, key, query),
  update: (id, key, patch) =>
    ipcRenderer.invoke('canopy:update', id, key, patch),
  rank: (id, key, before) => ipcRenderer.invoke('canopy:rank', id, key, before),
  loadWorkspace: () => ipcRenderer.invoke('canopy:loadWorkspace'),
  saveWorkspace: (workspace) =>
    ipcRenderer.invoke('canopy:saveWorkspace', workspace),
  copyIssueLink: (id, key) =>
    ipcRenderer.invoke('canopy:copyIssueLink', id, key),
  openIssue: (id, key) => ipcRenderer.invoke('canopy:openIssue', id, key),
};
contextBridge.exposeInMainWorld('canopy', api);
