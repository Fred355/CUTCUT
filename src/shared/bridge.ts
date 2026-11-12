import type { ServiceSettings, RoutePreview } from './services';
import type { AIRequest, AIJob, Transcript } from './studio';
import type { DashboardData, SettingsView, Settings, Provider } from './studio';
import type { Project } from './model';
export type Opened = { project: Project; missing: string[]; recovered: boolean };
export type ExportEvent = {
  status: 'rendering' | 'validating' | 'done' | 'cancelled' | 'error';
  progress: number;
  message?: string;
};
export interface Bridge {
  aiRoute(request: Pick<AIRequest, 'kind' | 'project' | 'assetIds'>): Promise<RoutePreview>;
  serviceModels(id: string): Promise<string[]>;
  serviceProbe(
    id: string,
    model: string,
    capability: 'text' | 'vision',
  ): Promise<{
    capability: string;
    revision: number;
    model: string;
    serviceId: string;
    message: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
  cancelProbe(): Promise<void>;
  aiStart(request: AIRequest): Promise<AIJob>;
  aiStatus(): Promise<AIJob | null>;
  aiCancel(): Promise<void>;
  aiCheck(id: string, current: Project): Promise<void>;
  aiApply(id: string, current: Project): Promise<Opened | null>;
  aiTranscript(id: string, transcript: Transcript): Promise<void>;
  exportSRT(text: string): Promise<boolean>;
  versions(): Promise<{ id: string; createdAt: string; label: string; clips: number }[]>;
  restoreVersion(id: string, current: Project): Promise<Opened>;
  testModel(
    role: 'planner' | 'worker' | 'vision',
  ): Promise<{ inputTokens: number; outputTokens: number }>;
  dashboard(): Promise<DashboardData>;
  settings(): Promise<SettingsView>;
  updateSettings(settings: ServiceSettings): Promise<SettingsView>;
  setKey(provider: string, key: string): Promise<SettingsView>;
  openRecent(id: string): Promise<Opened | null>;
  revealProject(id: string): Promise<void>;
  create(name: string, portrait: boolean): Promise<Opened | null>;
  open(): Promise<Opened | null>;
  save(p: Project): Promise<void>;
  autosave(p: Project): Promise<void>;
  importDroppedFiles(files: File[]): Promise<{ assets: Project['assets']; errors: string[] }>;
  importAssets(): Promise<{ assets: Project['assets']; errors: string[] }>;
  relink(id: string): Promise<Project['assets'][number] | null>;
  export(p: Project): Promise<boolean>;
  cancelExport(): Promise<void>;
  setDirty(dirty: boolean): void;
  onExport(fn: (e: ExportEvent) => void): () => void;
  mediaURL(id: string, kind?: 'preview' | 'thumbnail'): string;
}
declare global {
  interface Window {
    cutcut?: Bridge;
  }
}
