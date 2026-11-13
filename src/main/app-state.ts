import { randomUUID } from 'node:crypto';
import { featureConfigSchema, type FeatureConfig } from '../shared/services';
import {
  serviceSettingsSchema,
  defaultServiceSettings,
  migrateSettings,
  migrateV2,
  serviceIdentity,
  roleNames,
  roles,
  type ServiceSettings,
} from '../shared/services';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, safeFile } from './store';
import {
  type DashboardData,
  type Provider,
  type RecentProject,
  type SettingsView,
} from '../shared/studio';
import type { Project } from '../shared/model';

export type SecretStorage = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};
type State = {
  version: 3;
  settings: ServiceSettings;
  keys: Record<string, string>;
  projects: RecentProject[];
  exports: Record<string, number>;
};
export class AppState {
  private state: State = {
    version: 3,
    settings: structuredClone(defaultServiceSettings),
    keys: {},
    projects: [],
    exports: {},
  };
  private memory = new Map<string, string>();
  private writes = Promise.resolve();
  constructor(
    readonly root: string,
    private secrets: SecretStorage,
  ) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    let loaded = false;
    try {
      const file = path.join(this.root, 'studio.json');
      const original = await fs.readFile(file, 'utf8');
      loaded = true;
      const data = JSON.parse(original);
      if (
        ![1, 2, 3].includes(data.version) ||
        !Array.isArray(data.projects) ||
        !data.keys ||
        !data.exports
      )
        throw new Error('本地设置格式无效');
      if (data.version < 3) {
        const migrated =
          data.version === 1
            ? migrateSettings(data.settings, data.keys)
            : { settings: migrateV2(data.settings), keys: data.keys };
        const next = { ...data, ...migrated, version: 3 };
        const backup = await fs.open(
          path.join(this.root, `studio-v${data.version}-backup-${Date.now()}.json`),
          'wx',
          0o600,
        );
        try {
          await backup.writeFile(original);
          await backup.sync();
        } finally {
          await backup.close();
        }
        await atomicWrite(file, JSON.stringify(next, null, 2));
        this.state = next;
      } else this.state = { ...data, settings: serviceSettingsSchema.parse(data.settings) };
    } catch (e: any) {
      if (loaded || e.code !== 'ENOENT')
        throw new Error('无法读取本地设置；请保留 studio.json 后检查文件权限或恢复备份');
    }
  }
  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.writes.then(fn);
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async commit(next: State) {
    await atomicWrite(path.join(this.root, 'studio.json'), JSON.stringify(next, null, 2));
    this.state = next;
  }
  key(provider: string): string {
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
      keys: Object.fromEntries(this.state.settings.services.map((s) => [s.id, !!this.key(s.id)])),
    };
  }
  async update(raw: ServiceSettings, credential?: { id: string; value: string }) {
    return this.transaction(async () => {
      const settings = serviceSettingsSchema.parse(raw),
        old = this.state.settings;
      if (settings.revision !== old.revision) throw new Error('设置已变化，请刷新后再保存');
      for (const service of old.services)
        if (!settings.services.some((s) => s.id === service.id)) {
          const used = roles.filter((r) => old.bindings[r].serviceId === service.id);
          if (used.length)
            throw new Error(`请先解除绑定：${used.map((r) => roleNames[r]).join('、')}`);
        }
      const keys = { ...this.state.keys };
      const removed: string[] = [];
      for (const service of old.services) {
        const next = settings.services.find((s) => s.id === service.id);
        if (!next || serviceIdentity(next) !== serviceIdentity(service)) {
          delete keys[service.id];
          removed.push(service.id);
        }
      }
      if (credential) {
        if (
          typeof credential.value !== 'string' ||
          credential.value.length > 2000 ||
          !settings.services.some((s) => s.id === credential!.id)
        )
          throw new Error('凭据参数无效');
        credential = { ...credential, value: credential.value.trim() };
        delete keys[credential.id];
        if (credential.value && this.secrets.available())
          keys[credential.id] = this.secrets.encrypt(credential.value).toString('base64');
      }
      const next = { ...this.state, keys, settings: { ...settings, revision: old.revision + 1 } };
      await this.commit(next);
      for (const id of removed) this.memory.delete(id);
      if (credential) {
        this.memory.delete(credential.id);
        if (credential.value && !this.secrets.available())
          this.memory.set(credential.id, credential.value);
      }
      return this.view();
    });
  }
  async configure(raw: FeatureConfig) {
    const r = featureConfigSchema.parse(raw),
      settings = this.view().settings;
    if (r.revision !== settings.revision) throw new Error('设置已变化，请刷新后保存');
    let service = { ...r.service };
    const old = settings.services.find((s) => s.id === service.id);
    if (
      old &&
      serviceIdentity(old) !== serviceIdentity(service) &&
      roles.some((role) => role !== r.role && settings.bindings[role].serviceId === service.id)
    )
      service.id = randomUUID();
    settings.services = settings.services.some((s) => s.id === service.id)
      ? settings.services.map((s) => (s.id === service.id ? service : s))
      : [...settings.services, service];
    settings.bindings[r.role] = { serviceId: service.id, model: r.model };
    return this.update(
      settings,
      r.secret === undefined ? undefined : { id: service.id, value: r.secret },
    );
  }
  async setKey(id: string, value: string) {
    return this.transaction(async () => {
      if (
        !this.state.settings.services.some((s) => s.id === id) ||
        typeof value !== 'string' ||
        value.length > 2000
      )
        throw new Error('服务或密钥参数无效');
      value = value.trim();
      const keys = { ...this.state.keys };
      delete keys[id];
      if (value && this.secrets.available())
        keys[id] = this.secrets.encrypt(value).toString('base64');
      const next = {
        ...this.state,
        keys,
        settings: { ...this.state.settings, revision: this.state.settings.revision + 1 },
      };
      await this.commit(next);
      this.memory.delete(id);
      if (value && !this.secrets.available()) this.memory.set(id, value);
      return this.view();
    });
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
    await this.transaction(() =>
      this.commit({
        ...this.state,
        projects: [entry, ...this.state.projects.filter((x) => x.id !== p.id)].slice(0, 500),
      }),
    );
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
    await this.transaction(async () => {
      const day = localDay(now),
        exports = { ...this.state.exports };
      exports[day] = (exports[day] || 0) + 1;
      await this.commit({
        ...this.state,
        exports: Object.fromEntries(
          Object.entries(exports)
            .sort(([a], [b]) => b.localeCompare(a))
            .slice(0, 366),
        ),
      });
    });
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
