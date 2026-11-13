import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { modelCatalog, type ModelSpec, type ModelLock, type ModelState } from '../shared/native';
import { atomicWrite } from './store';
import { z } from 'zod';
const lockSchema = z.object({
  id: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(20_000_000_000),
  url: z.string().url(),
});
export function validateModelLock(raw: unknown, spec: ModelSpec): ModelLock {
  const lock = lockSchema.parse(raw);
  if (
    lock.id !== spec.id ||
    lock.url !== `https://huggingface.co/${spec.repo}/resolve/${lock.revision}/${spec.file}`
  )
    throw new Error('模型清单与来源不匹配');
  return lock;
}
export function validateBundledLocks(raw: unknown): ModelLock[] {
  if (!Array.isArray(raw) || raw.length !== modelCatalog.length)
    throw new Error('模型下载清单不完整');
  return modelCatalog.map((spec) => {
    const matches = raw.filter((l) => l?.id === spec.id);
    if (matches.length !== 1) throw new Error('模型下载清单缺失或重复：' + spec.id);
    return validateModelLock(matches[0], spec);
  });
}
export async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const b of createReadStream(file)) {
    signal?.throwIfAborted();
    hash.update(b);
  }
  return hash.digest('hex');
}
export class NativeModels {
  private resolving = new Map<string, Promise<ModelLock>>();
  private states = new Map<string, ModelState>();
  private jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private leases = new Map<string, number>();
  constructor(
    readonly root: string,
    private fetcher: typeof fetch = (u, i) => fetch(u, i),
    private catalog: ModelSpec[] = modelCatalog,
    private bundledLocks: ModelLock[] = [],
  ) {}
  spec(id: string) {
    const spec = this.catalog.find((s) => s.id === id);
    if (!spec) throw new Error('未知模型');
    return spec;
  }
  file(id: string) {
    return path.join(this.root, id, this.spec(id).file);
  }
  private lockFile(id: string) {
    this.spec(id);
    return path.join(this.root, id, 'lock.json');
  }
  private checkLock(raw: unknown, id: string) {
    return validateModelLock(raw, this.spec(id));
  }
  async lock(id: string, signal?: AbortSignal): Promise<ModelLock> {
    this.spec(id);
    const current = this.resolving.get(id);
    if (current) return current;
    const pending = this.resolveLock(id, signal).finally(() => this.resolving.delete(id));
    this.resolving.set(id, pending);
    return pending;
  }
  private async resolveLock(id: string, signal?: AbortSignal): Promise<ModelLock> {
    try {
      return this.checkLock(JSON.parse(await fs.readFile(this.lockFile(id), 'utf8')), id);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    let lock = this.bundledLocks.find((l) => l.id === id);
    if (!lock) {
      const s = this.spec(id);
      const response = await this.fetcher(
        `https://huggingface.co/api/models/${s.repo}?blobs=true`,
        {
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error(`无法读取官方模型下载信息（HTTP ${response.status}）`);
      const data: any = await response.json();
      const f = data.siblings?.find((f: any) => f.rfilename === s.file);
      lock = {
        id,
        revision: data.sha,
        sha256: f?.lfs?.sha256,
        bytes: f?.lfs?.size,
        url: `https://huggingface.co/${s.repo}/resolve/${data.sha}/${s.file}`,
      };
    }
    lock = this.checkLock(lock, id);
    await fs.mkdir(path.dirname(this.lockFile(id)), { recursive: true });
    await atomicWrite(this.lockFile(id), JSON.stringify(lock, null, 2));
    return lock;
  }
  async status(id: string): Promise<ModelState> {
    this.spec(id);
    const inUse = !!this.leases.get(id);
    const running = this.states.get(id);
    if (this.jobs.has(id)) return { ...running!, inUse };
    const stat = await fs.stat(this.file(id)).catch(() => null);
    let lock: ModelLock | undefined;
    try {
      lock = this.checkLock(JSON.parse(await fs.readFile(this.lockFile(id), 'utf8')), id);
    } catch {}
    let verified = false;
    try {
      const receipt = JSON.parse(
        await fs.readFile(path.join(path.dirname(this.file(id)), 'verified.json'), 'utf8'),
      );
      verified =
        !!stat &&
        !!lock &&
        stat.size === lock.bytes &&
        receipt.sha256 === lock.sha256 &&
        receipt.mtimeMs === stat.mtimeMs;
    } catch {}
    return {
      id,
      installed: verified,
      bytes: stat?.size || 0,
      downloadBytes: lock?.bytes,
      sha256: lock?.sha256,
      status: running?.status === 'error' ? 'error' : verified ? 'ready' : 'missing',
      received: 0,
      error: running?.error,
      inUse,
    };
  }
  async acquire(id: string, signal?: AbortSignal) {
    if (this.jobs.has(id)) throw new Error('模型正在下载或校验');
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
    try {
      const l = await this.lock(id, signal);
      if ((await hashFile(this.file(id), signal)) !== l.sha256)
        throw new Error('模型校验失败，请重新下载');
      return { file: this.file(id), release: () => this.release(id) };
    } catch (e) {
      this.release(id);
      throw e;
    }
  }
  private release(id: string) {
    this.leases.set(id, Math.max(0, (this.leases.get(id) || 1) - 1));
  }
  async remove(id: string) {
    this.spec(id);
    if (this.jobs.has(id) || this.leases.get(id))
      throw new Error('模型正在使用，请先取消或等待完成');
    await fs.rm(this.file(id), { force: true });
    await fs.rm(path.join(path.dirname(this.file(id)), 'verified.json'), { force: true });
    this.states.delete(id);
  }
  private async receipt(id: string, l: ModelLock) {
    const stat = await fs.stat(this.file(id));
    await atomicWrite(
      path.join(path.dirname(this.file(id)), 'verified.json'),
      JSON.stringify({ sha256: l.sha256, mtimeMs: stat.mtimeMs }),
    );
  }
  private async response(url: string, signal: AbortSignal): Promise<Response> {
    for (let i = 0; i < 6; i++) {
      const u = new URL(url);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        !['huggingface.co', 'hf.co'].some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
      )
        throw new Error('模型下载跳转到未批准的域名');
      const r = await this.fetcher(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        await r.body?.cancel();
        url = new URL(r.headers.get('location') || '', url).href;
        continue;
      }
      if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`);
      return r;
    }
    throw new Error('模型下载跳转过多');
  }
  start(id: string, source?: string) {
    this.spec(id);
    if (this.jobs.has(id) || this.leases.get(id)) throw new Error('模型正在使用');
    const abort = new AbortController();
    const state: ModelState = {
      id,
      installed: false,
      bytes: 0,
      status: 'downloading',
      received: 0,
      inUse: false,
    };
    this.states.set(id, state);
    const done = (async () => {
      const l = await this.lock(id, abort.signal);
      state.downloadBytes = l.bytes;
      state.sha256 = l.sha256;
      const dir = path.dirname(this.file(id));
      await fs.mkdir(dir, { recursive: true });
      const temp = path.join(dir, randomUUID() + '.partial');
      try {
        const free = await fs.statfs(dir);
        if (free.bavail * free.bsize < l.bytes + 64 * 1024 * 1024)
          throw new Error('磁盘剩余空间不足');
        const handle = await fs.open(temp, 'wx', 0o600);
        const hash = createHash('sha256');
        try {
          const input = source
            ? createReadStream(source)
            : (
                await this.response(
                  l.url,
                  AbortSignal.any([abort.signal, AbortSignal.timeout(4 * 60 * 60 * 1000)]),
                )
              ).body;
          if (!input) throw new Error('没有下载内容');
          for await (const chunk of input as AsyncIterable<Uint8Array>) {
            abort.signal.throwIfAborted();
            state.received += chunk.length;
            if (state.received > l.bytes) throw new Error('模型文件大小不匹配');
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        state.status = 'verifying';
        abort.signal.throwIfAborted();
        if (state.received !== l.bytes || hash.digest('hex') !== l.sha256)
          throw new Error('模型大小或 SHA-256 校验失败');
        await fs.rename(temp, this.file(id));
        await this.receipt(id, l);
        state.status = 'ready';
        state.installed = true;
        state.bytes = l.bytes;
      } finally {
        await fs.rm(temp, { force: true });
      }
    })()
      .catch((e) => {
        state.status = 'error';
        state.error = abort.signal.aborted
          ? '下载或导入已取消'
          : e instanceof Error
            ? e.message
            : String(e);
      })
      .finally(() => {
        this.jobs.delete(id);
      });
    this.jobs.set(id, { abort, done });
    return state;
  }
  async cancel(id: string) {
    const j = this.jobs.get(id);
    j?.abort.abort();
    await j?.done;
  }
  async wait(id: string) {
    await this.jobs.get(id)?.done;
    return this.status(id);
  }
}
