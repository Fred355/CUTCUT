import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  engineIds,
  type EngineId,
  type NativeOptions,
  type RuntimeBuildJob,
  type RuntimePrerequisites,
} from '../shared/native';
import { localRequest } from './local-queue';
import { atomicWrite } from './store';
import { NativeTools } from './native-tools';
import { NativeModels } from './native-models';
import { runtimeHome, installedRuntime } from './runtime-location';
const exec = promisify(execFile);
async function cmakePath() {
  const candidates = [
    process.env.CUTCUT_CMAKE,
    '/opt/homebrew/bin/cmake',
    '/usr/local/bin/cmake',
    '/Applications/CMake.app/Contents/bin/cmake',
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, 'cmake')),
  ];
  for (const file of candidates)
    if (
      file &&
      (await fs.access(file, fs.constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      return file;
  return 'cmake';
}
export async function buildPrerequisites(
  backend: NativeOptions['backend'],
  signal?: AbortSignal,
): Promise<RuntimePrerequisites & { cmake: string }> {
  const cmake = await cmakePath();
  const definitions = [
    { name: 'CMake', bin: cmake, args: ['--version'] },
    { name: 'Git', bin: 'git', args: ['--version'] },
    process.platform === 'darwin'
      ? { name: 'Xcode 命令行工具', bin: '/usr/bin/xcrun', args: ['--find', 'clang'] }
      : { name: 'C++ 编译器', bin: 'c++', args: ['--version'] },
  ];
  const tools = await Promise.all(
    definitions.map(async (d) => {
      try {
        const r = await exec(d.bin, d.args, { timeout: 15000, maxBuffer: 32768, signal });
        return {
          name: d.name,
          available: true,
          detail: r.stdout.trim().split('\n')[0].slice(0, 200),
        };
      } catch {
        return {
          name: d.name,
          available: false,
          detail:
            d.name === 'CMake'
              ? '请安装 CMake；Mac 可使用 CMake.app，无需在终端配置路径。'
              : d.name === 'Xcode 命令行工具'
                ? '请先完成系统编译工具安装。'
                : '未找到可用工具，或工具未完成系统配置。',
        };
      }
    }),
  );
  if (backend === 'metal' && process.platform !== 'darwin')
    tools.push({ name: 'Metal', available: false, detail: 'Metal 需要 macOS，请在本机选择 CPU。' });
  if (!['darwin', 'linux'].includes(process.platform))
    tools.push({ name: '系统', available: false, detail: '应用内编译目前支持 macOS 和 Linux。' });
  return {
    ready: tools.every((t) => t.available),
    platform: `${process.platform}-${process.arch}`,
    tools,
    cmake,
  };
}
export type BuildInvocation = {
  script: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onLine: (line: string) => void;
};
export async function runBuildProcess(input: BuildInvocation) {
  input.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [input.script, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined, error: Error | undefined;
    const terminate = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (e: any) {
        if (e.code !== 'ESRCH') error = e;
      }
    };
    const abort = () => {
      if (timer) return;
      terminate('SIGTERM');
      timer = setTimeout(() => terminate('SIGKILL'), 2000);
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.on('data', (b) => {
        pending += String(b);
        const lines = pending.split(/[\r\n]+/);
        pending = lines.pop()!.slice(-8192);
        for (const line of lines) input.onLine(line.slice(-2000));
      });
      stream.on('end', () => {
        if (pending) input.onLine(pending);
      });
    }
    child.on('error', (e) => {
      error = e;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      if (input.signal.aborted) reject(new Error('运行程序安装已取消'));
      else if (error) reject(error);
      else if (code !== 0) reject(new Error(`编译程序退出（${code}），请查看安装日志`));
      else resolve();
    });
  });
}
export class RuntimeBuilder {
  job: RuntimeBuildJob | null = null;
  private abort?: AbortController;
  private done: Promise<void> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly resources: string,
    private runner = runBuildProcess,
    private requirements = buildPrerequisites,
  ) {}
  get installedRoot() {
    return path.join(this.root, 'installed');
  }
  get active() {
    return this.job?.status === 'running' || this.job?.status === 'queued';
  }
  async prerequisites(backend: NativeOptions['backend']) {
    const { cmake, ...view } = await this.requirements(backend);
    return view;
  }
  start(engine: EngineId, backend: NativeOptions['backend']) {
    if (!engineIds.includes(engine) || !['cpu', 'metal'].includes(backend))
      throw new Error('运行程序参数无效');
    if (this.active) throw new Error('已有运行程序安装任务');
    const abort = new AbortController();
    this.abort = abort;
    const job: RuntimeBuildJob = {
      id: randomUUID(),
      engine,
      backend,
      status: 'queued',
      stage: '等待本地任务结束',
      startedAt: Date.now(),
      logs: [],
    };
    this.job = job;
    this.done = localRequest(abort.signal, async () => {
      job.status = 'running';
      job.stage = '检查编译工具';
      const requirements = await this.requirements(backend, abort.signal);
      abort.signal.throwIfAborted();
      if (!requirements.ready)
        throw new Error(
          '需要先安装：' +
            requirements.tools
              .filter((t) => !t.available)
              .map((t) => t.name)
              .join('、'),
        );
      await fs.mkdir(this.root, { recursive: true });
      const disk = await fs.statfs(this.root);
      if (disk.bavail * disk.bsize < 4 * 1024 ** 3)
        throw new Error('编译至少需要 4 GiB 可用空间，请清理磁盘后重试');
      const work = await fs.mkdtemp(path.join(this.root, 'install-'));
      let destination = '',
        committed = false;
      try {
        const stageRoot = path.join(work, 'resources'),
          cache = path.join(this.root, 'build-cache');
        await fs.mkdir(stageRoot, { recursive: true });
        await fs.mkdir(cache, { recursive: true });
        await this.runner({
          script: path.join(this.resources, 'native', 'build-native.mjs'),
          cwd: cache,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUTCUT_CMAKE: requirements.cmake },
          signal: abort.signal,
          args: [
            '--engine',
            engine,
            '--backend',
            backend,
            '--manifest',
            path.join(this.resources, 'native', 'sources.json'),
            '--work-root',
            cache,
            '--output-root',
            path.join(stageRoot, 'runtimes'),
            '--jobs',
            '2',
          ],
          onLine: (line) => {
            if (line.startsWith('CUTCUT_BUILD_STAGE ')) {
              try {
                const message = JSON.parse(line.slice('CUTCUT_BUILD_STAGE '.length)).message;
                if (typeof message === 'string') job.stage = message.slice(0, 160);
              } catch {}
            } else if (line.trim()) {
              job.logs.push(line);
              if (job.logs.length > 60) job.logs.shift();
            }
          },
        });
        abort.signal.throwIfAborted();
        job.stage = '校验编译结果';
        const check = new NativeTools('', stageRoot, new NativeModels(''));
        await check.runtime(engine, backend);
        abort.signal.throwIfAborted();
        const home = runtimeHome(this.installedRoot, engine, backend),
          previous = await installedRuntime(this.installedRoot, engine, backend).catch(() => null);
        await fs.mkdir(path.join(home, 'versions'), { recursive: true });
        destination = path.join(home, 'versions', job.id);
        await fs.rename(
          path.join(stageRoot, 'runtimes', `${process.platform}-${process.arch}`, engine, backend),
          destination,
        );
        abort.signal.throwIfAborted();
        job.stage = '完成安装';
        await atomicWrite(path.join(home, 'active.json'), JSON.stringify({ id: job.id }));
        committed = true;
        // Keep the preceding working version; cleanup never changes the active pointer.
        for (const name of await fs.readdir(path.join(home, 'versions'))) {
          const file = path.join(home, 'versions', name);
          if (file !== destination && file !== previous)
            await fs.rm(file, { recursive: true, force: true }).catch(() => {});
        }
        job.status = 'done';
        job.stage = '运行程序已安装，可继续使用已下载的模型';
      } finally {
        if (destination && !committed) await fs.rm(destination, { recursive: true, force: true });
        await fs.rm(work, { recursive: true, force: true });
      }
    })
      .catch((e) => {
        job.status = abort.signal.aborted ? 'cancelled' : 'error';
        job.stage = job.status === 'cancelled' ? '安装已取消' : '安装失败';
        job.message = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.abort = undefined;
      });
    return job;
  }
  async cancel() {
    this.abort?.abort();
    await this.done;
  }
  async wait() {
    await this.done;
    return this.job;
  }
}
