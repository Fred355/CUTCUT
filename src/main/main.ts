import { RuntimeBuilder } from './runtime-builder';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeModels } from './native-models';
import { NativeTools } from './native-tools';
import { localBusy, localBlocked, retryLocalRelease } from './local-queue';
import {
  routeFor,
  resolvedSettings,
  resolveChoice,
  assertRouteAuthorization,
} from '../shared/services';
import { listModels, probeService } from './service-probes';
import { AITasks, projectHash } from './ai-tasks';
import { compileProposal, transcriptSchema } from '../shared/studio';
import { checkpoint } from './history';
import { callModel } from './providers';
import { AppState } from './app-state';
import { app, BrowserWindow, dialog, ipcMain, protocol, Menu, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaResponse } from './media-response';
import { ProjectStore, safeFile, atomicWrite } from './store';
import { exportVideo } from './exporter';
import { errorMessage, type Project } from '../shared/model';
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cutcut-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
let win: BrowserWindow;
let state: AppState;
const store = new ProjectStore();
let ai: AITasks;
let native: NativeTools;
let models: NativeModels;
let runtimeBuilder: RuntimeBuilder;
let exportDone: Promise<void> = Promise.resolve();
let dirty = false,
  exporting: AbortController | null = null,
  queue = Promise.resolve(),
  busy = false;
const font = () =>
  path.join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    'resources/fonts/NotoSansCJKsc-Regular.otf',
  );
function confirmDiscard() {
  return (
    !dirty ||
    dialog.showMessageBoxSync(win, {
      type: 'question',
      message: '工程有未保存的修改',
      detail: '请取消并保存工程，或放弃本次修改。',
      buttons: ['取消', '放弃修改'],
      defaultId: 0,
      cancelId: 0,
    }) === 1
  );
}
function register(channel: string, fn: (...args: any[]) => Promise<any>) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame !== win.webContents.mainFrame) throw new Error('不允许的调用来源');
    const task = queue.then(async () => {
      busy = true;
      try {
        return await fn(...args);
      } catch (error) {
        throw new Error(errorMessage(error));
      } finally {
        busy = false;
      }
    });
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  });
}
async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#101215',
    title: 'CUTCUT',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('close', (e) => {
    if (
      exporting ||
      busy ||
      runtimeBuilder?.active ||
      ai?.job?.status === 'running' ||
      native?.job?.status === 'running'
    ) {
      e.preventDefault();
      dialog.showMessageBoxSync(win, {
        message: '请等待当前操作完成，或先取消导出 / AI 任务；运行程序安装可在软件设置中取消。',
      });
      return;
    }
    if (!confirmDiscard()) e.preventDefault();
    else dirty = false;
  });
  if (!app.isPackaged && process.env.CUTCUT_DEV_URL === 'http://127.0.0.1:5173')
    await win.loadURL(process.env.CUTCUT_DEV_URL);
  else await win.loadFile(path.join(__dirname, '../dist/index.html'));
}
app.whenReady().then(async () => {
  state = new AppState(app.getPath('userData'), {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  try {
    await state.init();
  } catch (e) {
    dialog.showErrorBox('设置读取或迁移失败', errorMessage(e));
    app.quit();
    return;
  }
  const resourceRoot = path.join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    'resources',
  );
  let locks = [];
  try {
    locks = JSON.parse(
      await fs.readFile(path.join(resourceRoot, 'native', 'models.lock.json'), 'utf8'),
    );
  } catch {}
  models = new NativeModels(path.join(state.root, 'models'), undefined, undefined, locks);
  runtimeBuilder = new RuntimeBuilder(path.join(state.root, 'runtime-tools'), resourceRoot);
  native = new NativeTools(
    path.join(state.root, 'generated'),
    resourceRoot,
    models,
    runtimeBuilder.installedRoot,
  );
  ai = new AITasks(undefined, native);
  let probing: AbortController | null = null;
  app.on('before-quit', () => probing?.abort());
  const readIPC = (channel: string, fn: (...args: any[]) => Promise<any>) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.senderFrame !== win.webContents.mainFrame) throw new Error('不允许的调用来源');
      try {
        return await fn(...args);
      } catch (e) {
        throw new Error(errorMessage(e));
      }
    });
  readIPC('service:cancel', async () => {
    probing?.abort();
  });
  const probeTask = async (fn: (signal: AbortSignal) => Promise<any>) => {
    if (exporting) throw new Error('请等待导出结束再测试模型');
    if (probing) throw new Error('已有连接测试，请先取消或等待完成');
    const controller = new AbortController();
    probing = controller;
    try {
      return await fn(controller.signal);
    } finally {
      probing = null;
    }
  };
  readIPC('service:models', async (id) =>
    probeTask((signal) => {
      const s = state.view().settings.services.find((s) => s.id === id);
      if (!s) throw new Error('服务不存在');
      return listModels(s, state.key(id), signal);
    }),
  );
  readIPC('service:probe', async (id, model, cap) =>
    probeTask((signal) => {
      if (typeof model !== 'string' || model.length > 150 || !['text', 'vision'].includes(cap))
        throw new Error('测试参数无效');
      return probeService(state.view().settings, id, model, cap, state.key(id), signal);
    }),
  );
  readIPC('studio:test-model', async (role) =>
    probeTask(async (signal) => {
      if (!['planner', 'worker', 'vision'].includes(role)) throw new Error('角色无效');
      const settings = state.view().settings;
      const c = resolveChoice(settings, role);
      const r = await probeService(
        settings,
        c.serviceId!,
        c.model,
        'text',
        state.key(c.serviceId!),
        signal,
      );
      return { inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0 };
    }),
  );
  readIPC('feature:configure', async (raw, test) => {
    if (typeof test !== 'boolean') throw new Error('测试参数无效');
    const view = await state.configure(raw);
    if (!test) return { view, ok: true, message: '配置已保存' };
    try {
      const choice = resolveChoice(view.settings, raw.role);
      if (raw.role === 'speech') {
        await probeTask((sig) =>
          listModels(
            view.settings.services.find((s) => s.id === choice.serviceId)!,
            state.key(choice.serviceId!),
            sig,
          ),
        );
        return { view, ok: true, message: '认证与模型列表接口已响应；语音识别请用素材单独验证' };
      }
      const result = await probeTask((sig) =>
        probeService(
          view.settings,
          choice.serviceId!,
          choice.model,
          raw.role === 'vision' ? 'vision' : 'text',
          state.key(choice.serviceId!),
          sig,
        ),
      );
      return { view, ok: true, message: result.message };
    } catch (e) {
      return { view, ok: false, message: '配置已保存，测试失败：' + errorMessage(e) };
    }
  });
  const checkedBackend = (b: unknown) => {
    if (b !== 'cpu' && b !== 'metal') throw new Error('计算后端无效');
    return b;
  };
  readIPC('runtime:prerequisites', async (b) => runtimeBuilder.prerequisites(checkedBackend(b)));
  register('runtime:build', async (e, b) => {
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running')
      throw new Error('请先等待或取消当前剪辑任务');
    return runtimeBuilder.start(e, checkedBackend(b));
  });
  readIPC('runtime:status', async () => runtimeBuilder.job);
  readIPC('runtime:cancel', async () => runtimeBuilder.cancel());
  register('runtime:tool', async (tool) => {
    if (tool === 'cmake') {
      await shell.openExternal('https://cmake.org/download/');
      return '已打开 CMake 官方下载页。Mac 请安装 CMake.app 到“应用程序”，然后返回重新检查。';
    }
    if (tool === 'xcode' && process.platform === 'darwin') {
      try {
        await promisify(execFile)('/usr/bin/xcode-select', ['--install'], {
          timeout: 15000,
          maxBuffer: 32768,
        });
        return '请完成 macOS 弹出的编译工具安装，再返回检查。';
      } catch {
        throw new Error('系统工具安装未启动；可能已安装或需要先完成系统更新，请检查 macOS 提示。');
      }
    }
    throw new Error('此系统不支持该安装入口');
  });
  readIPC('native:status', async () => ({
    engines: await native.status(state.view().settings),
    blocked: localBlocked(),
    modelsPath: models.root,
  }));
  readIPC('model:info', (id) => models.lock(id));
  readIPC('model:download', async (id) => {
    models.start(id);
  });
  register('model:import', async (id) => {
    models.spec(id);
    const d = await dialog.showOpenDialog(win, {
      title: '选择对应的完整模型文件',
      properties: ['openFile'],
    });
    if (d.canceled) return false;
    models.start(id, d.filePaths[0]);
    return true;
  });
  readIPC('model:cancel', (id) => models.cancel(id));
  readIPC('model:delete', (id) => models.remove(id));
  readIPC('native:storage', async () => ({
    modelsPath: models.root,
    modelsBytes: (await native.status(state.view().settings)).reduce(
      (n, e) => n + e.model.bytes,
      0,
    ),
    cachePath: native.root,
    cacheBytes: await native.cacheBytes(),
  }));
  register('native:clear-cache', async () => native.clearCache());
  readIPC('native:retry-release', async () => retryLocalRelease());
  register('generation:start', async (request) => {
    if (exporting || ai.job?.status === 'running') throw new Error('请等待导出或 AI 任务完成');
    if (!store.project || request.projectId !== store.project.id) throw new Error('工程已变化');
    return native.start(request, state.view().settings);
  });
  readIPC('generation:status', async () => native.job);
  readIPC('generation:cancel', async () => native.cancel());
  register('generation:import', async (id, projectId) => {
    if (store.project?.id !== projectId) throw new Error('工程已变化，不能加入其他工程');
    const file = native.result(id, projectId);
    if (native.job?.imported) throw new Error('该结果已经加入素材库');
    const asset = await store.importOne(file);
    native.job!.imported = true;
    dirty = true;
    return asset;
  });
  register('project:close', async (current, rendererDirty) => {
    current = store.validate(current);
    if (typeof rendererDirty !== 'boolean') throw new Error('关闭参数无效');
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running') {
      const answer = await dialog.showMessageBox(win, {
        message: '当前工程仍有任务运行',
        buttons: ['取消任务并关闭', '返回工程'],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response !== 0) return false;
      exporting?.abort();
      ai.cancel();
      await native.cancel();
      await ai.cancelAndWait();
      await exportDone;
    }
    if (dirty || rendererDirty) {
      const answer = await dialog.showMessageBox(win, {
        message: '保存工程修改后关闭？',
        buttons: ['保存并关闭', '不保存关闭', '取消'],
        defaultId: 0,
        cancelId: 2,
      });
      if (answer.response === 2) return false;
      if (answer.response === 0) {
        await store.save(current);
        await state.register(current, store.file);
      }
    }
    await native.clear();
    await store.close(true);
    ai.clear();
    dirty = false;
    return true;
  });
  const routing = (request: any) => {
    if (
      !request ||
      !['roughcut', 'transcribe'].includes(request.kind) ||
      !Array.isArray(request.assetIds) ||
      request.assetIds.length > 8
    )
      throw new Error('任务参数无效');
    const project = store.validate(request.project);
    if (request.assetIds.some((id: unknown) => !project.assets.some((a) => a.id === id)))
      throw new Error('素材不存在');
    return routeFor(
      state.view().settings,
      request.kind,
      project.assets.some((a) => request.assetIds.includes(a.id) && a.kind !== 'audio'),
    );
  };
  register('ai:route', async (request) => routing(request));
  register('ai:start', async (request) => {
    if (exporting || native.job?.status === 'running') throw new Error('请等待导出或素材生成完成');
    const route = routing(request);
    assertRouteAuthorization(route, request);
    const project = store.validate(request.project),
      settings = resolvedSettings(state.view().settings);
    return ai.start({ ...request, project }, store.root, settings, (id) => state.key(id));
  });
  register('ai:status', async () => ai.job);
  register('ai:cancel', async () => ai.cancel());
  register('ai:check', async (id, current) => {
    current = store.validate(current);
    if (
      !ai.job ||
      ai.job.id !== id ||
      ai.job.status !== 'done' ||
      projectHash(current) !== ai.job.inputHash
    )
      throw new Error('任务或工程已变化，请重新生成，避免时间码错位');
  });
  register('ai:transcript', async (id, raw) => {
    const job = ai.job;
    if (!job || job.id !== id || job.status !== 'done' || !job.result?.transcript)
      throw new Error('转写任务不存在');
    const transcript = transcriptSchema.parse(raw),
      original = job.result.transcript;
    if (
      transcript.assetId !== original.assetId ||
      transcript.segments.length !== original.segments.length ||
      transcript.segments.some(
        (s, i) =>
          s.id !== original.segments[i].id ||
          s.startMs !== original.segments[i].startMs ||
          s.endMs !== original.segments[i].endMs,
      )
    )
      throw new Error('文稿编辑只能修改文字');
    await safeFile(ai.root, 'cache');
    await atomicWrite(
      path.join(ai.root, 'cache', `transcript-${id}.json`),
      JSON.stringify(transcript),
    );
    job.result.transcript = transcript;
  });
  register('ai:srt', async (text) => {
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('字幕内容无效');
    const d = await dialog.showSaveDialog(win, {
      title: '导出字幕',
      filters: [{ name: 'SRT', extensions: ['srt'] }],
      defaultPath: '字幕.srt',
    });
    if (d.canceled || !d.filePath) return false;
    if (path.extname(d.filePath).toLowerCase() !== '.srt') throw new Error('请选择 .srt 文件名');
    await atomicWrite(d.filePath, text);
    return true;
  });
  register('ai:apply', async (id, current) => {
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running')
      throw new Error('请等待当前任务完成或先取消');
    current = store.validate(current);
    const job = ai.job;
    if (!job || job.id !== id || job.status !== 'done' || !job.result?.proposal || !ai.source)
      throw new Error('没有可应用的初剪方案');
    if (projectHash(current) !== job.inputHash)
      throw new Error('工程已变化，请重新生成方案，避免覆盖后续编辑');
    const result = compileProposal(
      ai.source,
      job.result.proposal,
      !!job.result.portrait,
      job.result.assetIds,
    );
    const d = await dialog.showOpenDialog(win, {
      title: '选择初剪新工程存放位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (d.canceled) return null;
    await checkpoint(store.root, current, 'AI 初剪前的工作副本');
    const next = new ProjectStore();
    const empty = await next.create(d.filePaths[0], result.name, result.height > result.width);
    const project = { ...result, id: empty.id };
    try {
      for (const a of project.assets) {
        const source = await safeFile(ai.root, a.path);
        await fs.mkdir(path.dirname(path.join(next.root, a.path)), { recursive: true });
        await fs.copyFile(source, path.join(next.root, a.path), fs.constants.COPYFILE_EXCL);
      }
      next.project = project;
      await next.save(project);
    } catch (e) {
      await fs.rm(next.root, { recursive: true, force: true });
      throw e;
    }
    await store.read(next.file, false);
    dirty = false;
    await state.register(project, store.file);
    return { project, missing: [], recovered: false };
  });
  register('studio:dashboard', () => state.dashboard());
  register('studio:settings', async () => state.view());
  register('studio:update-settings', async (s) => state.update(s));
  register('studio:key', async (p, k) => state.setKey(p, k));
  register('studio:reveal', async (id) => {
    shell.showItemInFolder(state.project(id).file);
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'CUTCUT', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      {
        label: '文件',
        submenu: [
          {
            label: '关闭工程',
            accelerator: 'CmdOrCtrl+W',
            click: () => {
              if (busy) return;
              if (store.project) win.webContents.send('project:request-close');
              else win.close();
            },
          },
        ],
      },
      {
        label: '编辑',
        submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]),
  );
  protocol.handle('cutcut-media', async (request) => {
    try {
      const u = new URL(request.url);
      if (u.host === 'cover')
        return mediaResponse(await state.cover(decodeURIComponent(u.pathname.slice(1))), request);
      if (u.host === 'generated') {
        if (!store.project) throw new Error('工程已关闭');
        return mediaResponse(
          native.result(decodeURIComponent(u.pathname.slice(1)), store.project.id),
          request,
        );
      }
      if (u.host !== 'asset') throw new Error('无效媒体地址');
      const file = await store.media(
        decodeURIComponent(u.pathname.slice(1)),
        u.searchParams.get('kind') || 'preview',
      );
      return await mediaResponse(file, request);
    } catch {
      return new Response('素材不可用', { status: 404 });
    }
  });
  register('project:create', async (name: string, portrait: boolean) => {
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running')
      throw new Error('请等待当前任务完成或先取消');
    if (!confirmDiscard()) return null;
    if (typeof name !== 'string' || typeof portrait !== 'boolean') throw new Error('工程参数无效');
    const d = await dialog.showOpenDialog(win, {
      title: '选择项目存放位置（将创建独立项目文件夹）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (d.canceled) return null;
    const p = await store.create(d.filePaths[0], name, portrait);
    await state.register(p, store.file);
    dirty = false;
    return { project: p, missing: [], recovered: false };
  });
  register('project:open', async (recentId?: string) => {
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running')
      throw new Error('请等待当前任务完成或先取消');
    if (!confirmDiscard()) return null;
    const recent = recentId ? state.project(recentId) : null;
    const exists = recent && (await fs.stat(recent.file).catch(() => null));
    const d = exists
      ? { canceled: false, filePaths: [recent!.file] }
      : await dialog.showOpenDialog(win, {
          filters: [{ name: 'CUTCUT 工程', extensions: ['cutcut'] }],
          properties: ['openFile'],
        });
    if (d.canceled) return null;
    const file = d.filePaths[0];
    let recover = false;
    try {
      const draft = await fs.stat(path.join(path.dirname(file), '.cutcut-recovery.json'));
      const saved = await fs.stat(file);
      if (draft.mtimeMs > saved.mtimeMs) {
        recover =
          (
            await dialog.showMessageBox(win, {
              message: '发现自动恢复草稿',
              buttons: ['恢复草稿', '打开已保存版本'],
              defaultId: 0,
              cancelId: 1,
            })
          ).response === 0;
      }
    } catch {}
    const opened = await store.read(file, recover);
    await state.register(opened.project, store.file);
    dirty = recover;
    return opened;
  });
  register('project:versions', async () => store.versions());
  register('project:restore-version', async (id, current) => {
    if (exporting || ai.job?.status === 'running' || native.job?.status === 'running')
      throw new Error('请等待当前任务完成或先取消');
    const opened = await store.restoreVersion(id, current);
    dirty = false;
    await state.register(opened.project, store.file);
    return opened;
  });
  register('project:save', async (p: Project) => {
    await store.save(p);
    await state.register(p, store.file);
    dirty = false;
  });
  register('project:autosave', async (p: Project) => store.autosave(p));
  register('assets:import', async () => {
    if (!store.project) throw new Error('请先创建工程');
    const d = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '视频、图片、声音',
          extensions: ['mp4', 'mov', 'jpg', 'jpeg', 'png', 'mp3', 'wav', 'm4a'],
        },
      ],
    });
    return importPaths(d.filePaths);
  });
  async function importPaths(paths: unknown) {
    if (!store.project) throw new Error('请先创建工程');
    if (
      !Array.isArray(paths) ||
      paths.length > 200 ||
      paths.some(
        (file) => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'),
      )
    )
      throw new Error('导入文件列表无效（每批最多 200 个文件）');
    const assets = [],
      errors = [];
    for (const file of paths as string[]) {
      try {
        if (!(await fs.stat(file)).isFile()) throw new Error('请选择文件，不支持拖入文件夹');
        assets.push(await store.importOne(file));
      } catch (error) {
        errors.push(`${path.basename(file)}：${errorMessage(error)}`);
      }
    }
    return { assets, errors };
  }
  register('assets:import-paths', importPaths);
  register('assets:relink', async (id: string) => {
    const d = await dialog.showOpenDialog(win, {
      title: '选择同一份原始素材',
      properties: ['openFile'],
    });
    return d.canceled ? null : store.relink(id, d.filePaths[0]);
  });
  register('export:start', async (p: Project) => {
    if (
      localBusy() ||
      localBlocked() ||
      ai.job?.status === 'running' ||
      native.job?.status === 'running'
    )
      throw new Error('请等待本地 AI 任务完成，并处理模型释放错误后再导出');
    if (exporting) throw new Error('已有导出任务');
    p = store.validate(p);
    if ((await store.missing(p)).length) throw new Error('请先重新定位缺失素材');
    const d = await dialog.showSaveDialog(win, {
      title: '导出 MP4 成片',
      defaultPath: path.join(store.root, `${p.name.replace(/[<>:"/\\|?*]/g, '_')}.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    });
    if (d.canceled || !d.filePath) return false;
    const target = d.filePath.endsWith('.mp4') ? d.filePath : d.filePath + '.mp4';
    if (
      path.resolve(target).startsWith(path.join(store.root, 'assets') + path.sep) ||
      path.resolve(target).startsWith(path.join(store.root, 'cache') + path.sep)
    )
      throw new Error('请勿将成片写入素材或缓存目录');
    const realParent = await fs.realpath(path.dirname(target));
    const realRoot = await fs.realpath(store.root);
    for (const directory of ['assets', 'cache']) {
      const protectedRoot = path.join(realRoot, directory);
      if (realParent === protectedRoot || realParent.startsWith(protectedRoot + path.sep))
        throw new Error('请勿覆盖项目素材或缓存');
    }
    if (target !== d.filePath) {
      let exists = false;
      try {
        await fs.stat(target);
        exists = true;
      } catch {}
      if (
        exists &&
        (
          await dialog.showMessageBox(win, {
            message: '目标 MP4 已存在，是否替换？',
            buttons: ['取消', '替换'],
            defaultId: 0,
            cancelId: 0,
          })
        ).response !== 1
      )
        return false;
    }
    if (
      localBusy() ||
      localBlocked() ||
      String(ai.job?.status) === 'running' ||
      String(native.job?.status) === 'running'
    )
      throw new Error('本地任务状态已变化，请等待任务完成后再导出');
    const abort = new AbortController();
    exporting = abort;
    exportDone = exportVideo(p, store.root, target, font(), abort.signal, (event) => {
      if (event.status === 'done') void state.exported().catch(() => {});
      if (!win.isDestroyed()) win.webContents.send('export:progress', event);
    })
      .catch((e) => {
        if (!win.isDestroyed())
          win.webContents.send('export:progress', {
            status: abort.signal.aborted ? 'cancelled' : 'error',
            progress: 0,
            message: errorMessage(e),
          });
      })
      .finally(() => {
        exporting = null;
      });
    return true;
  });
  register('export:cancel', async () => {
    exporting?.abort();
  });
  ipcMain.on('project:dirty', (event, value) => {
    if (event.senderFrame === win.webContents.mainFrame) dirty = !!value && !!store.project;
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
