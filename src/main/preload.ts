import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, ExportEvent } from '../shared/bridge';
const bridge: Bridge = {
  create: (...args) => ipcRenderer.invoke('project:create', ...args),
  open: () => ipcRenderer.invoke('project:open'),
  save: (p) => ipcRenderer.invoke('project:save', p),
  autosave: (p) => ipcRenderer.invoke('project:autosave', p),
  importAssets: () => ipcRenderer.invoke('assets:import'),
  relink: (id) => ipcRenderer.invoke('assets:relink', id),
  export: (p) => ipcRenderer.invoke('export:start', p),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  setDirty: (dirty) => ipcRenderer.send('project:dirty', dirty),
  onExport: (fn) => {
    const listener = (_: unknown, event: ExportEvent) => fn(event);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  mediaURL: (id, kind = 'preview') => `cutcut-media://asset/${encodeURIComponent(id)}?kind=${kind}`,
};
contextBridge.exposeInMainWorld('cutcut', bridge);
