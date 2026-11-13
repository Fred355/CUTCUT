import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Bridge, ExportEvent } from '../shared/bridge';
const bridge: Bridge = {
  closeProject: (p, d) => ipcRenderer.invoke('project:close', p, d),
  onCloseProject: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('project:request-close', listener);
    return () => ipcRenderer.removeListener('project:request-close', listener);
  },
  configureFeature: (c, t) => ipcRenderer.invoke('feature:configure', c, t),
  nativeStatus: () => ipcRenderer.invoke('native:status'),
  modelInfo: (id) => ipcRenderer.invoke('model:info', id),
  downloadModel: (id) => ipcRenderer.invoke('model:download', id),
  importModel: (id) => ipcRenderer.invoke('model:import', id),
  cancelModel: (id) => ipcRenderer.invoke('model:cancel', id),
  deleteModel: (id) => ipcRenderer.invoke('model:delete', id),
  nativeStorage: () => ipcRenderer.invoke('native:storage'),
  clearGenerationCache: () => ipcRenderer.invoke('native:clear-cache'),
  retryLocalRelease: () => ipcRenderer.invoke('native:retry-release'),
  generate: (r) => ipcRenderer.invoke('generation:start', r),
  generationStatus: () => ipcRenderer.invoke('generation:status'),
  cancelGeneration: () => ipcRenderer.invoke('generation:cancel'),
  importGeneration: (id, p) => ipcRenderer.invoke('generation:import', id, p),
  generationURL: (id) => `cutcut-media://generated/${encodeURIComponent(id)}`,

  aiRoute: (r) => ipcRenderer.invoke('ai:route', r),
  serviceModels: (id) => ipcRenderer.invoke('service:models', id),
  serviceProbe: (id, m, c) => ipcRenderer.invoke('service:probe', id, m, c),
  cancelProbe: () => ipcRenderer.invoke('service:cancel'),
  aiStart: (request) => ipcRenderer.invoke('ai:start', request),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  aiCheck: (id, p) => ipcRenderer.invoke('ai:check', id, p),
  aiApply: (id, p) => ipcRenderer.invoke('ai:apply', id, p),
  aiTranscript: (id, t) => ipcRenderer.invoke('ai:transcript', id, t),
  exportSRT: (text) => ipcRenderer.invoke('ai:srt', text),
  versions: () => ipcRenderer.invoke('project:versions'),
  restoreVersion: (id, p) => ipcRenderer.invoke('project:restore-version', id, p),
  testModel: (role) => ipcRenderer.invoke('studio:test-model', role),
  dashboard: () => ipcRenderer.invoke('studio:dashboard'),
  settings: () => ipcRenderer.invoke('studio:settings'),
  updateSettings: (s) => ipcRenderer.invoke('studio:update-settings', s),
  setKey: (p, k) => ipcRenderer.invoke('studio:key', p, k),
  openRecent: (id) => ipcRenderer.invoke('project:open', id),
  revealProject: (id) => ipcRenderer.invoke('studio:reveal', id),
  create: (...args) => ipcRenderer.invoke('project:create', ...args),
  open: () => ipcRenderer.invoke('project:open'),
  save: (p) => ipcRenderer.invoke('project:save', p),
  autosave: (p) => ipcRenderer.invoke('project:autosave', p),
  importAssets: () => ipcRenderer.invoke('assets:import'),
  importDroppedFiles: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    if (!paths.length || paths.some((file) => !file))
      return Promise.reject(new Error('无法读取拖入文件，请从 Finder 拖入本地文件。'));
    return ipcRenderer.invoke('assets:import-paths', paths);
  },
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
