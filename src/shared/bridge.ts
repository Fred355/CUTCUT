import type { Project } from './model';
export type Opened = { project: Project; missing: string[]; recovered: boolean };
export type ExportEvent = {
  status: 'rendering' | 'validating' | 'done' | 'cancelled' | 'error';
  progress: number;
  message?: string;
};
export interface Bridge {
  create(name: string, portrait: boolean): Promise<Opened | null>;
  open(): Promise<Opened | null>;
  save(p: Project): Promise<void>;
  autosave(p: Project): Promise<void>;
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
