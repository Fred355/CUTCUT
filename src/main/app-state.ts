import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, safeFile } from './store';
import {
  settingsSchema,
  defaultSettings,
  providers,
  type DashboardData,
  type Provider,
  type RecentProject,
  type SettingsView,
  type Settings,
} from '../shared/studio';
import type { Project } from '../shared/model';

export type SecretStorage = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};
type State = {
  version: 1;
  settings: Settings;
  keys: Partial<Record<Provider, string>>;
  projects: RecentProject[];
  exports: Record<string, number>;
};
export class AppState {
  private state: State = {
    version: 1,
    settings: structuredClone(defaultSettings),
    keys: {},
    projects: [],
    exports: {},
  };
  private memory = new Map<Provider, string>();
  private writes = Promise.resolve();
  constructor(
    readonly root: string,
    private secrets: SecretStorage,
  ) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.root, 'studio.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.projects) || !data.keys || !data.exports)
        throw new Error('本地设置格式无效');
      this.state = { ...data, settings: settingsSchema.parse(data.settings) };
    } catch (e: any) {
      if (e.code !== 'ENOENT')
        throw new Error('无法读取本地设置；请保留 studio.json 后检查文件权限或恢复备份');
    }
  }
  private persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const task = this.writes.then(() => atomicWrite(path.join(this.root, 'studio.json'), snapshot));
    this.writes = task.catch(() => {});
    return task;
  }
  key(provider: Provider): string {
    if (this.memory.has(provider)) return this.memory.get(provider)!;
    const encrypted = this.state.keys[provider];
    if (!encrypted || !this.secrets.available()) return '';
    try {
      return this.secrets.decrypt(Buffer.from(encrypted, 'base64'));
    } catch {
      return '';
    }
  }
  view(): SettingsView {
    return {
      settings: structuredClone(this.state.settings),
      secureStorage: this.secrets.available(),
      keys: Object.fromEntries(providers.map((p) => [p, !!this.key(p)])) as Record<
        Provider,
        boolean
      >,
    };
  }
  async update(settings: Settings) {
    this.state.settings = settingsSchema.parse(settings);
    await this.persist();
    return this.view();
  }
  async setKey(provider: Provider, value: string) {
    if (!providers.includes(provider) || typeof value !== 'string' || value.length > 2000)
      throw new Error('密钥参数无效');
    value = value.trim();
    delete this.state.keys[provider];
    this.memory.delete(provider);
    if (value) {
      if (this.secrets.available())
        this.state.keys[provider] = this.secrets.encrypt(value).toString('base64');
      else this.memory.set(provider, value);
    }
    await this.persist();
    return this.view();
  }
  async register(p: Project, file: string) {
    const previous = this.state.projects.find((x) => x.id === p.id);
    const coverAsset = p.assets.find((a) => a.thumbnail);
    let cover = previous?.cover;
    if (coverAsset?.thumbnail) {
      try {
        const source = await safeFile(path.dirname(file), coverAsset.thumbnail);
        await fs.mkdir(path.join(this.root, 'covers'), { recursive: true });
        await fs.copyFile(source, path.join(this.root, 'covers', `${p.id}.jpg`));
        cover = p.id;
      } catch {
        /* A missing cache must not prevent saving a project. */
      }
    }
    const entry: RecentProject = {
      id: p.id,
      name: p.name,
      file,
      updatedAt: new Date().toISOString(),
      portrait: p.height > p.width,
      assets: p.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      cover,
    };
    this.state.projects = [entry, ...this.state.projects.filter((x) => x.id !== p.id)].slice(
      0,
      500,
    );
    await this.persist();
  }
  project(id: string) {
    const p = this.state.projects.find((p) => p.id === id);
    if (!p) throw new Error('工程未登记');
    return p;
  }
  async cover(id: string) {
    this.project(id);
    return safeFile(this.root, `covers/${id}.jpg`);
  }
  async exported(now = new Date()) {
    const day = localDay(now);
    this.state.exports[day] = (this.state.exports[day] || 0) + 1;
    this.state.exports = Object.fromEntries(
      Object.entries(this.state.exports)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 366),
    );
    await this.persist();
  }
  async dashboard(): Promise<DashboardData> {
    const projects = await Promise.all(
      this.state.projects.map(async (p) => ({
        ...p,
        missing: !(await fs.stat(p.file).catch(() => null))?.isFile(),
      })),
    );
    return {
      projects,
      exportsToday: this.state.exports[localDay(new Date())] || 0,
      assetsCount: projects.reduce((n, p) => n + p.assets.length, 0),
      storagePath: this.root,
    };
  }
}
function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
