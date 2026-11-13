import { checkpoint, listVersions, readVersion } from './history';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectSchema, assetSchema, newProject, type Project, type Asset } from '../shared/model';
import { describe, prepareMedia } from './media';
export async function atomicWrite(file: string, content: string) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const h = await fs.open(tmp, 'wx');
    try {
      await h.writeFile(content);
      await h.sync();
    } finally {
      await h.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function safeFile(root: string, relative: string) {
  const r = await fs.realpath(root),
    candidate = path.resolve(r, relative);
  if (!candidate.startsWith(r + path.sep)) throw new Error('文件必须位于工程目录');
  const real = await fs.realpath(candidate);
  if (!real.startsWith(r + path.sep)) throw new Error('工程素材不可链接到外部目录');
  return real;
}
export class ProjectStore {
  root = '';
  file = '';
  project: Project | null = null;
  private rebuilding = new Map<string, Promise<Asset>>();
  async create(parent: string, name: string, portrait: boolean) {
    const p = newProject(name.trim() || '未命名工程', portrait);
    projectSchema.parse(p);
    const folder = `${p.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}-${p.id.slice(0, 8)}`;
    const root = path.join(parent, folder);
    await fs.mkdir(root);
    const file = path.join(root, 'project.cutcut');
    try {
      await fs.mkdir(path.join(root, 'assets'));
      await fs.mkdir(path.join(root, 'cache'));
      await atomicWrite(file, JSON.stringify(p, null, 2));
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    // Switch sessions only after the new project is safely persisted.
    this.root = root;
    this.file = file;
    this.project = p;
    return p;
  }
  async read(file: string, recover: boolean) {
    const root = await fs.realpath(path.dirname(file));
    const source = recover ? path.join(root, '.cutcut-recovery.json') : file;
    const stat = await fs.stat(source);
    if (stat.size > 10_000_000) throw new Error('工程文件过大');
    const p = projectSchema.parse(JSON.parse(await fs.readFile(source, 'utf8')));
    this.root = root;
    this.file = file;
    this.project = p;
    return { project: p, missing: await this.missing(p), recovered: recover };
  }
  async missing(p: Project) {
    const ids: string[] = [];
    for (const a of p.assets) {
      try {
        await safeFile(this.root, a.path);
      } catch {
        ids.push(a.id);
      }
    }
    return ids;
  }
  validate(p: Project) {
    const parsed = projectSchema.parse(p);
    if (!this.project || p.id !== this.project.id) throw new Error('工程会话已变化，请重新打开');
    const registered = new Map(this.project.assets.map((a) => [a.id, a]));
    for (const a of parsed.assets) {
      const known = registered.get(a.id);
      if (!known || JSON.stringify(a) !== JSON.stringify(assetSchema.parse(known)))
        throw new Error('素材记录只能通过导入或重新定位更新');
    }
    return parsed;
  }
  async save(p: Project) {
    p = this.validate(p);
    const saved = projectSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    await checkpoint(this.root, saved, '原保存版本');
    await checkpoint(this.root, p, '保存检查点');
    await atomicWrite(this.file, JSON.stringify(p, null, 2));
    this.project = p;
    await fs.rm(path.join(this.root, '.cutcut-recovery.json'), { force: true });
  }
  async close(discardDraft: boolean) {
    if (discardDraft && this.root)
      await fs.rm(path.join(this.root, '.cutcut-recovery.json'), { force: true });
    this.root = '';
    this.file = '';
    this.project = null;
    this.rebuilding.clear();
  }
  async versions() {
    if (!this.project) throw new Error('请先打开工程');
    return listVersions(this.root, this.project.id);
  }
  async restoreVersion(id: string, current: Project) {
    current = this.validate(current);
    const record = await readVersion(this.root, id, current.id);
    await checkpoint(this.root, current, '恢复前的工作副本');
    const saved = projectSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    await checkpoint(this.root, saved, '恢复前已保存版本');
    await atomicWrite(this.file, JSON.stringify(record.project, null, 2));
    this.project = record.project;
    await fs.rm(path.join(this.root, '.cutcut-recovery.json'), { force: true });
    return {
      project: record.project,
      missing: await this.missing(record.project),
      recovered: false,
    };
  }
  async autosave(p: Project) {
    p = this.validate(p);
    await atomicWrite(path.join(this.root, '.cutcut-recovery.json'), JSON.stringify(p, null, 2));
  }
  async importOne(file: string): Promise<Asset> {
    if (!this.project) throw new Error('请先创建工程');
    const info = await describe(file),
      id = randomUUID();
    const relative = `assets/${id}${path.extname(file).toLowerCase()}`;
    await fs.mkdir(path.join(this.root, 'assets'), { recursive: true });
    await safeDirectory(this.root, 'assets');
    await safeDirectory(this.root, 'cache');
    const target = path.join(this.root, relative);
    try {
      await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
      const asset = await prepareMedia(this.root, {
        ...info,
        id,
        name: path.basename(file),
        path: relative,
      });
      this.project.assets.push(asset);
      return asset;
    } catch (e) {
      await fs.rm(target, { force: true });
      for (const suffix of ['.mp4', '.wav', '.jpg'])
        await fs.rm(path.join(this.root, 'cache', id + suffix), { force: true });
      throw e;
    }
  }
  async relink(id: string, file: string) {
    const old = this.project?.assets.find((a) => a.id === id);
    if (!old) throw new Error('素材不存在');
    const info = await describe(file);
    if (
      info.kind !== old.kind ||
      info.width !== old.width ||
      info.height !== old.height ||
      info.durationFrames !== old.durationFrames
    )
      throw new Error('替换素材的类型、尺寸和时长必须与原素材一致');
    const asset = await this.importOne(file);
    this.project!.assets = this.project!.assets.filter((a) => a.id !== asset.id).map((a) =>
      a.id === id ? { ...asset, id, name: old.name } : a,
    );
    return this.project!.assets.find((a) => a.id === id)!;
  }
  async media(id: string, kind: string) {
    const root = this.root;
    const asset = this.project?.assets.find((a) => a.id === id);
    if (!asset) throw new Error('素材不存在');
    let relative = kind === 'thumbnail' ? asset.thumbnail : asset.preview || asset.path;
    if (!relative) throw new Error('素材没有缩略图');
    try {
      return await safeFile(root, relative);
    } catch {
      await safeFile(root, asset.path);
      const key = `${root}:${id}:${asset.path}`;
      let pending = this.rebuilding.get(key);
      if (!pending) {
        pending = (async () => {
          await safeDirectory(root, 'cache');
          return prepareMedia(root, { ...asset });
        })();
        this.rebuilding.set(key, pending);
        pending.catch(() => {
          this.rebuilding.delete(key);
        });
      }
      const updated = await pending;
      relative = kind === 'thumbnail' ? updated.thumbnail : updated.preview || updated.path;
      // Regenerated cache paths do not mutate the user's authoritative asset record.
      return safeFile(root, relative!);
    }
  }
}
async function safeDirectory(root: string, name: string) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await safeFile(root, name);
}
