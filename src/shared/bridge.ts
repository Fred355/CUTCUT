import type { DashboardData, SettingsView, Settings, Provider } from './studio';
import type { Project } from './model';
export type Opened = { project: Project; missing: string[]; recovered: boolean };
export type ExportEvent = {
  status: 'rendering' | 'validating' | 'done' | 'cancelled' | 'error';
  progress: number;
  message?: string;
};
export interface Bridge {
  versions(): Promise<{ id: string; createdAt: string; label: string; clips: number }[]>;
  restoreVersion(id: string, current: Project): Promise<Opened>;
  testModel(
    role: 'planner' | 'worker' | 'vision',
  ): Promise<{ inputTokens: number; outputTokens: number }>;
  dashboard(): Promise<DashboardData>;
  settings(): Promise<SettingsView>;
  updateSettings(settings: Settings): Promise<SettingsView>;
  setKey(provider: Provider, key: string): Promise<SettingsView>;
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
