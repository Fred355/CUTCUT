import { app, BrowserWindow, dialog, ipcMain, protocol, Menu } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaResponse } from './media-response';
import { ProjectStore } from './store';
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
const store = new ProjectStore();
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
    if (exporting || busy) {
      e.preventDefault();
      dialog.showMessageBoxSync(win, { message: '请等待当前操作完成，或先取消导出。' });
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'CUTCUT', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
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
    if (exporting) throw new Error('请等待导出结束');
    if (!confirmDiscard()) return null;
    if (typeof name !== 'string' || typeof portrait !== 'boolean') throw new Error('工程参数无效');
    const d = await dialog.showOpenDialog(win, {
      title: '选择项目存放位置（将创建独立项目文件夹）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (d.canceled) return null;
    const p = await store.create(d.filePaths[0], name, portrait);
    dirty = false;
    return { project: p, missing: [], recovered: false };
  });
  register('project:open', async () => {
    if (exporting) throw new Error('请等待导出结束');
    if (!confirmDiscard()) return null;
    const d = await dialog.showOpenDialog(win, {
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
    dirty = recover;
    return opened;
  });
  register('project:save', async (p: Project) => {
    await store.save(p);
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
    const abort = new AbortController();
    exporting = abort;
    void exportVideo(p, store.root, target, font(), abort.signal, (event) => {
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
    if (event.senderFrame === win.webContents.mainFrame) dirty = !!value;
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
