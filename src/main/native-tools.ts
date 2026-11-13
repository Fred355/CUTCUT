import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sources from '../../resources/native/sources.json';
import {
  generationSchema,
  type GenerationRequest,
  type GenerationJob,
  type EngineId,
  type NativeOptions,
  type EngineState,
} from '../shared/native';
import type { ServiceSettings } from '../shared/services';
import { NativeModels, hashFile } from './native-models';
import { localRequest } from './local-queue';
import { binaries, run, probe } from './media';
import { safeFile } from './store';
export async function runNative(
  bin: string,
  args: string[],
  signal: AbortSignal,
  requireWhisperGPU = false,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let stderr = '',
      timer: ReturnType<typeof setTimeout> | undefined,
      spawnError: Error | undefined,
      backendError = false;
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abort = () => {
      if (timer) return;
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', () => {});
    child.stderr.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-3000);
      if (
        requireWhisperGPU &&
        !backendError &&
        /whisper_backend_init_gpu: (no GPU found|failed to initialize)/.test(stderr)
      ) {
        backendError = true;
        abort();
      }
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('本地任务已取消'));
      else if (backendError)
        reject(new Error('Metal 初始化失败；请在语音识别设置中选择 CPU 后重试'));
      else if (spawnError) reject(new Error('本地运行时无法启动，请检查安装包及系统架构'));
      else if (code !== 0) reject(new Error(`本地运行时退出（${code}）：${stderr.slice(-1200)}`));
      else resolve();
    });
  });
}
export function whisperSegments(raw: any, offsetMs: number, durationMs: number) {
  if (!Array.isArray(raw.transcription)) throw new Error('Whisper 未返回带时间码的文稿');
  return raw.transcription.flatMap((s: any) => {
    const start = s.offsets?.from,
      end = s.offsets?.to;
    if (!Number.isFinite(start) || !Number.isFinite(end) || typeof s.text !== 'string') return [];
    const startMs = Math.max(offsetMs, offsetMs + Math.round(start)),
      endMs = Math.min(durationMs, offsetMs + Math.round(end));
    return endMs > startMs && s.text.trim()
      ? [{ id: randomUUID(), startMs, endMs, text: s.text.trim() }]
      : [];
  });
}
export class NativeTools {
  job: GenerationJob | null = null;
  private abort?: AbortController;
  private done: Promise<void> = Promise.resolve();
  private output = '';
  constructor(
    readonly root: string,
    readonly resources: string,
    readonly models: NativeModels,
  ) {}
  private dir(engine: EngineId, backend: NativeOptions['backend']) {
    return path.join(
      this.resources,
      'runtimes',
      `${process.platform}-${process.arch}`,
      engine,
      backend,
    );
  }
  async runtime(engine: EngineId, backend: NativeOptions['backend']) {
    if (backend === 'metal' && process.platform !== 'darwin')
      throw new Error('Metal 仅适用于 macOS，请在功能设置中选择 CPU');
    const dir = this.dir(engine, backend);
    let info: any;
    try {
      info = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      throw new Error(`${engine} ${backend} 运行时未随当前构建提供，请安装含本地工具的完整版本`);
    }
    if (
      info.commit !== sources[engine].commit ||
      info.backend !== backend ||
      info.platform !== `${process.platform}-${process.arch}` ||
      !Array.isArray(info.files) ||
      !info.files.some((f: any) => f.path === 'bin/' + sources[engine].binary)
    )
      throw new Error('运行时清单不匹配');
    for (const f of info.files) {
      if (typeof f.path !== 'string' || typeof f.sha256 !== 'string')
        throw new Error('运行时清单无效');
      const file = await safeFile(dir, f.path);
      if ((await hashFile(file)) !== f.sha256) throw new Error('运行时文件校验失败');
    }
    return safeFile(dir, 'bin/' + sources[engine].binary);
  }
  async status(settings: ServiceSettings): Promise<EngineState[]> {
    return Promise.all(
      (['whisper', 'sd', 'audio'] as EngineId[]).map(async (id) => {
        const backend = settings.native[id].backend;
        const available = !!(await fs
          .stat(path.join(this.dir(id, backend), 'manifest.json'))
          .catch(() => null));
        return {
          id,
          available,
          version: sources[id].commit,
          backend,
          model: await this.models.status(settings.native[id].modelId),
        };
      }),
    );
  }
  private async withModel<T>(
    engine: EngineId,
    options: NativeOptions,
    signal: AbortSignal,
    fn: (bin: string, model: string) => Promise<T>,
  ) {
    if (this.models.spec(options.modelId).engine !== engine) throw new Error('模型与运行时不匹配');
    return localRequest(signal, async () => {
      const bin = await this.runtime(engine, options.backend),
        lease = await this.models.acquire(options.modelId, signal);
      try {
        signal.throwIfAborted();
        return await fn(bin, lease.file);
      } finally {
        lease.release();
      }
    });
  }
  async transcribe(
    file: string,
    duration: number,
    language: string,
    options: NativeOptions,
    signal: AbortSignal,
    work: string,
    stage: (s: string) => void,
  ) {
    if (duration > 3600) throw new Error('本地单次转写支持最长 60 分钟');
    return this.withModel('whisper', options, signal, async (bin, model) => {
      const segments: ReturnType<typeof whisperSegments> = [];
      for (let offset = 0; offset < duration; offset += 300) {
        signal.throwIfAborted();
        stage(`本地识别 ${Math.floor(offset / 300) + 1}/${Math.ceil(duration / 300)}`);
        const wav = path.join(work, 'local-speech.wav'),
          prefix = path.join(work, 'whisper-result');
        await run(
          binaries().ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-ss',
            String(offset),
            '-i',
            file,
            '-t',
            String(Math.min(300, duration - offset)),
            '-vn',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            wav,
          ],
          { signal },
        );
        await runNative(
          bin,
          [
            '-m',
            model,
            '-f',
            wav,
            '-l',
            language,
            '-oj',
            '-of',
            prefix,
            ...(options.backend === 'cpu' ? ['-ng'] : []),
          ],
          signal,
          options.backend === 'metal',
        );
        const raw = JSON.parse(await fs.readFile(prefix + '.json', 'utf8'));
        segments.push(
          ...whisperSegments(raw, offset * 1000, Math.min(duration, offset + 300) * 1000),
        );
        await fs.rm(prefix + '.json', { force: true });
      }
      return segments;
    });
  }
  start(raw: GenerationRequest, settings: ServiceSettings) {
    if (this.job?.status === 'running') throw new Error('已有生成任务');
    const request = generationSchema.parse(raw);
    const engine = request.kind === 'image' ? 'sd' : 'audio';
    const options = structuredClone(settings.native[engine]);
    const controller = new AbortController();
    this.abort = controller;
    const job: GenerationJob = {
      id: randomUUID(),
      projectId: request.projectId,
      kind: request.kind,
      status: 'running',
      stage: '排队并检查模型',
      startedAt: Date.now(),
    };
    this.job = job;
    const previous = this.output;
    this.output = '';
    this.done = (async () => {
      if (previous) await fs.rm(path.dirname(previous), { recursive: true, force: true });
      await fs.mkdir(this.root, { recursive: true });
      const work = await fs.mkdtemp(path.join(this.root, 'generate-'));
      try {
        const target = path.join(work, request.kind === 'image' ? 'image.png' : 'music.wav');
        await this.withModel(engine, options, controller.signal, async (bin, model) => {
          job.stage = request.kind === 'image' ? '正在生成图片' : '正在生成音乐';
          const [w, h] = request.size.split('x');
          const args =
            engine === 'sd'
              ? [
                  '-m',
                  model,
                  '-p',
                  request.prompt,
                  '-W',
                  w,
                  '-H',
                  h,
                  '--backend',
                  options.backend,
                  '--steps',
                  '20',
                  '--seed',
                  String(request.seed),
                  '-o',
                  target,
                ]
              : [
                  '--model',
                  model,
                  '--family',
                  'magenta_realtime_2',
                  '--task',
                  'gen',
                  '--backend',
                  options.backend,
                  '--text',
                  request.prompt,
                  '--request-option',
                  `duration_sec=${request.seconds}`,
                  '--request-option',
                  `seed=${request.seed}`,
                  '--out',
                  target,
                ];
          await runNative(bin, args, controller.signal);
        });
        job.stage = '校验生成结果';
        const info = await probe(target, controller.signal);
        if (engine === 'sd') {
          const [w, h] = request.size.split('x').map(Number);
          if (!info.streams.some((s) => s.codec_name === 'png' && s.width === w && s.height === h))
            throw new Error('生成图片的尺寸或编码无效');
        } else if (
          !info.streams.some((s) => s.codec_type === 'audio') ||
          Math.abs(Number(info.format.duration) - request.seconds) > 0.5
        )
          throw new Error('生成音频的时长或编码无效');
        await run(binaries().ffmpeg, ['-v', 'error', '-i', target, '-f', 'null', '-'], {
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        this.output = target;
        job.status = 'done';
        job.stage = '生成完成，可预览后加入素材库';
      } finally {
        if (!this.output || path.dirname(this.output) !== work)
          await fs.rm(work, { recursive: true, force: true });
      }
    })()
      .catch((e) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'error';
        job.stage = job.status === 'cancelled' ? '已取消' : '生成失败';
        job.message = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.abort = undefined;
      });
    return job;
  }
  result(id: string, projectId: string) {
    if (
      !this.job ||
      this.job.id !== id ||
      this.job.projectId !== projectId ||
      this.job.status !== 'done' ||
      !this.output
    )
      throw new Error('生成结果不存在或工程已经变化');
    return this.output;
  }
  async cancel() {
    this.abort?.abort();
    await this.done;
  }
  async cacheBytes() {
    const walk = async (dir: string): Promise<number> => {
      let total = 0;
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) total += await walk(file);
        else if (e.isFile()) total += (await fs.stat(file)).size;
      }
      return total;
    };
    return walk(this.root);
  }
  async clearCache() {
    if (this.job?.status === 'running') throw new Error('生成任务进行中，不能清理缓存');
    await this.clear();
    await fs.rm(this.root, { recursive: true, force: true });
  }
  async clear() {
    await this.cancel();
    if (this.output) await fs.rm(path.dirname(this.output), { recursive: true, force: true });
    this.output = '';
    this.job = null;
  }
}
