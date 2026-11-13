import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeModels } from '../src/main/native-models';
import { NativeTools, runNative, whisperSegments } from '../src/main/native-tools';
import { modelCatalog, type ModelLock } from '../src/shared/native';
import { defaultServiceSettings, resolveChoice, type Service } from '../src/shared/services';
import { AppState } from '../src/main/app-state';
import { localBlocked, localRequest, retryLocalRelease } from '../src/main/local-queue';
import { callModel } from '../src/main/providers';
import { ProjectStore } from '../src/main/store';
import sources from '../resources/native/sources.json';
import ffmpeg from 'ffmpeg-static';
import { exportVideo } from '../src/main/exporter';
import { createClip, uid } from '../src/shared/model';
import { probe } from '../src/main/media';
import { checkNativeBundle, checkNativeInstaller } from '../scripts/check-native';
const bytes = Buffer.from('controlled-model-fixture');
const sha = createHash('sha256').update(bytes).digest('hex');
const locks: ModelLock[] = modelCatalog.map((m) => ({
  id: m.id,
  revision: 'a'.repeat(40),
  sha256: sha,
  bytes: bytes.length,
  url: `https://huggingface.co/${m.repo}/resolve/${'a'.repeat(40)}/${m.file}`,
}));
const signal = () => new AbortController().signal;
const secretStorage = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(s),
  decrypt: (b: Buffer) => b.toString(),
};
test('Whisper Metal 失败终止进程；CPU 明确选择；崩溃和缺失运行时可诊断', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-gpu-'));
  try {
    const file = path.join(root, 'whisper-cli');
    await fs.writeFile(
      file,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[2],String(process.pid));process.stderr.write('whisper_backend_init_gpu: no GPU found\\n');setInterval(()=>{},1000);`,
      { mode: 0o755 },
    );
    const pidFile = path.join(root, 'pid');
    await assert.rejects(runNative(file, [pidFile], signal(), true), /Metal 初始化失败.*CPU/);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await fs.writeFile(
      file,
      `#!${process.execPath}\nprocess.stderr.write('whisper_backend_init_gpu: no GPU found\\n');`,
      { mode: 0o755 },
    );
    await runNative(file, [], signal(), false);
    await assert.rejects(runNative(path.join(root, 'missing'), [], signal()), /运行时无法启动/);
    await fs.writeFile(
      file,
      `#!${process.execPath}\nprocess.stderr.write('controlled failure');process.exit(7);`,
      { mode: 0o755 },
    );
    await assert.rejects(runNative(file, [], signal()), /退出（7）.*controlled failure/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('生成取消等待进程退出、清理产物；运行期间锁定模型和缓存，共享本地队列', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-native-cancel-'));
  try {
    const native = await fixtures(root),
      settings = structuredClone(defaultServiceSettings);
    settings.native.sd.backend = 'cpu';
    native.start({ projectId: 'first', kind: 'image', prompt: 'hang' }, settings);
    let pidFile = '';
    for (let i = 0; i < 200 && !pidFile; i++) {
      const dirs = await fs.readdir(native.root).catch(() => []);
      for (const dir of dirs) {
        const file = path.join(native.root, dir, 'image.png.pid');
        if (await fs.stat(file).catch(() => null)) pidFile = file;
      }
      if (!pidFile) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(pidFile, 'fixture process started');
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await assert.rejects(native.clearCache(), /进行中/);
    await assert.rejects(native.models.remove('sd15'), /正在使用/);
    let secondStarted = false;
    const second = localRequest(signal(), async () => {
      secondStarted = true;
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    });
    assert.equal(secondStarted, false);
    await native.cancel();
    await second;
    assert.equal(native.job!.status, 'cancelled');
    assert.equal(secondStarted, true);
    assert.deepEqual(await fs.readdir(native.root), []);
    native.start({ projectId: 'first', kind: 'image', prompt: 'crash' }, settings);
    for (let i = 0; i < 200 && String(native.job?.status) === 'running'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(native.job!.status, 'error');
    assert.match(native.job!.message!, /退出（7）/);
    assert.deepEqual(await fs.readdir(native.root), []);
    await native.models.remove('sd15');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('完整安装包检查拒绝缺失或伪造的模型清单、许可证与运行时文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-bundle-'));
  try {
    const native = await fixtures(root),
      resources = native.resources;
    await assert.rejects(checkNativeBundle(resources, ['cpu']), /模型清单/);
    await fs.mkdir(path.join(resources, 'native'));
    const file = path.join(resources, 'native', 'models.lock.json');
    await fs.writeFile(file, JSON.stringify([]));
    await assert.rejects(checkNativeBundle(resources, ['cpu']), /不完整/);
    await fs.writeFile(
      file,
      JSON.stringify(
        locks.map((l, i) => (i === 0 ? { ...l, url: 'https://example.com/weight' } : l)),
      ),
    );
    await assert.rejects(checkNativeBundle(resources, ['cpu']), /来源/);
    await fs.writeFile(file, JSON.stringify(locks));
    await assert.rejects(checkNativeBundle(resources, ['cpu']), /许可证/);
    for (const e of ['whisper', 'sd', 'audio']) {
      const dir = path.join(resources, 'runtimes', `${process.platform}-${process.arch}`, e, 'cpu');
      await fs.mkdir(path.join(dir, 'licenses'));
      const license = 'Protocol fixture, not redistributable upstream runtime';
      await fs.writeFile(path.join(dir, 'licenses', 'LICENSE'), license);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      manifest.files.push({
        path: 'licenses/LICENSE',
        sha256: createHash('sha256').update(license).digest('hex'),
      });
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    }
    await checkNativeBundle(resources, ['cpu']);
    await fs.appendFile(await native.runtime('sd', 'cpu'), 'tamper');
    await assert.rejects(checkNativeBundle(resources, ['cpu']), /校验失败/);
    await fs.writeFile(path.join(resources, 'native', 'sources.json'), JSON.stringify(sources));
    await assert.rejects(checkNativeInstaller(resources), /安装器/);
    await fs.writeFile(
      path.join(resources, 'native', 'build-native.mjs'),
      '// controlled installer fixture\n'.repeat(100),
    );
    await fs.rm(path.join(resources, 'runtimes'), { recursive: true });
    await checkNativeInstaller(resources);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('模型下载/导入：固定哈希、错误清理、使用租约、取消与磁盘不足', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-models-'));
  const statfs = fs.statfs;
  try {
    let corrupt = false,
      slow = false;
    const models = new NativeModels(
      root,
      async () =>
        new Response(
          new ReadableStream({
            async start(c) {
              if (slow) await new Promise((r) => setTimeout(r, 30));
              c.enqueue(corrupt ? Buffer.from('wrong') : bytes);
              c.close();
            },
          }),
        ),
      modelCatalog,
      locks,
    );
    models.start('whisper-small');
    assert.equal((await models.wait('whisper-small')).installed, true);
    const lease = await models.acquire('whisper-small');
    await assert.rejects(models.remove('whisper-small'), /正在使用/);
    lease.release();
    corrupt = true;
    models.start('whisper-small');
    const failed = await models.wait('whisper-small');
    assert.equal(failed.status, 'error');
    assert.equal(await fs.readFile(models.file('whisper-small'), 'utf8'), bytes.toString());
    assert.ok(
      !(await fs.readdir(path.dirname(models.file('whisper-small')))).some((n) =>
        n.endsWith('.partial'),
      ),
    );
    await models.remove('whisper-small');
    corrupt = false;
    slow = true;
    models.start('whisper-small');
    await models.cancel('whisper-small');
    assert.equal((await models.status('whisper-small')).installed, false);
    fs.statfs = (async () => ({ bavail: 0, bsize: 4096 })) as unknown as typeof fs.statfs;
    models.start('sd15');
    assert.match((await models.wait('sd15')).error!, /空间不足/);
    fs.statfs = statfs;
    const imported = path.join(root, '已有模型.bin');
    await fs.writeFile(imported, bytes);
    models.start('sd15', imported);
    assert.equal((await models.wait('sd15')).installed, true);
    await fs.appendFile(models.file('sd15'), 'tamper');
    await assert.rejects(models.acquire('sd15'), /校验失败/);
  } finally {
    fs.statfs = statfs;
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('v2→v3 备份，功能配置一次保存密钥，修改共享端点不影响其他功能', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-v3-'));
  try {
    const service: Service = {
      id: 'shared',
      name: 'Shared',
      kind: 'cloud',
      provider: 'openai',
      protocol: 'openai',
      baseURL: 'https://api.openai.com/v1',
      auth: 'provider',
      timeoutSeconds: 120,
    };
    const v2: any = {
      ...structuredClone(defaultServiceSettings),
      version: 2,
      theme: 'lime',
      services: [service],
    };
    delete v2.native;
    delete v2.releaseOllama;
    v2.bindings.planner = { serviceId: 'shared', model: 'first' };
    v2.bindings.worker = { serviceId: 'shared', model: 'second' };
    const old = {
        version: 2,
        settings: v2,
        keys: { shared: Buffer.from('old-key').toString('base64') },
        projects: [],
        exports: { '2026-11-12': 5 },
      },
      raw = JSON.stringify(old);
    await fs.writeFile(path.join(root, 'studio.json'), raw);
    const app = new AppState(root, secretStorage);
    await app.init();
    assert.equal(app.view().settings.version, 3);
    assert.equal(app.view().settings.theme, 'lime');
    assert.equal(app.key('shared'), 'old-key');
    assert.equal(
      await fs.readFile(
        path.join(
          root,
          (await fs.readdir(root)).find((n) => n.startsWith('studio-v2-backup'))!,
        ),
        'utf8',
      ),
      raw,
    );
    const saved = await app.configure({
      revision: app.view().settings.revision,
      role: 'planner',
      service: { ...service, baseURL: 'https://new.example/v1' },
      model: 'new-model',
      secret: 'new-key',
    });
    const id = saved.settings.bindings.planner.serviceId!;
    assert.notEqual(id, 'shared');
    assert.equal(app.key(id), 'new-key');
    assert.equal(app.key('shared'), 'old-key');
    assert.equal(saved.settings.bindings.worker.serviceId, 'shared');
    await assert.rejects(
      app.configure({ revision: 0, role: 'planner', service, model: 'oops', secret: 'bad' }),
      /已变化/,
    );
    assert.equal(app.key('shared'), 'old-key');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('Ollama 精确卸载本次模型，失败阻断队列且可恢复', async () => {
  const local: Service = {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    provider: 'compatible',
    protocol: 'openai',
    baseURL: 'http://127.0.0.1:11434/v1',
    auth: 'none',
    timeoutSeconds: 30,
    runtime: 'ollama',
  };
  const settings = { ...structuredClone(defaultServiceSettings), services: [local] };
  settings.bindings.worker = { serviceId: local.id, model: 'my-bonsai:27b' };
  const choice = resolveChoice(settings, 'worker'),
    seen: any[] = [];
  let fail = true;
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(init!.body as string);
    seen.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate'))
      return fail
        ? new Response('', { status: 500 })
        : Response.json({ done: true, done_reason: 'unload' });
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    await assert.rejects(
      callModel(choice, '', { instruction: 'test', text: 'hello' }, signal(), fetcher),
      /释放失败/,
    );
    assert.equal(localBlocked(), true);
    await assert.rejects(
      localRequest(signal(), async () => assert.fail('must not execute')),
      /释放失败/,
    );
    assert.equal(seen[1].body.model, 'my-bonsai:27b');
    assert.equal(seen[1].body.keep_alive, 0);
    fail = false;
    await retryLocalRelease();
    assert.equal(localBlocked(), false);
    assert.equal(await localRequest(signal(), async () => 42), 42);
  } finally {
    fail = false;
    await retryLocalRelease();
  }
});
async function fixtures(root: string) {
  const resources = path.join(root, 'resources'),
    models = new NativeModels(
      path.join(root, 'models'),
      async () => new Response(bytes),
      modelCatalog,
      locks,
    );
  for (const e of ['whisper', 'sd', 'audio'] as const) {
    const dir = path.join(
      resources,
      'runtimes',
      `${process.platform}-${process.arch}`,
      e,
      'cpu',
      'bin',
    );
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, sources[e].binary);
    const script = `#!${process.execPath}\nconst fs=require('node:fs');const {execFileSync}=require('node:child_process');const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];if(a.includes('hang')){fs.writeFileSync(get('-o')||get('--out'),'partial');fs.writeFileSync((get('-o')||get('--out'))+'.pid',String(process.pid));setInterval(()=>{},1000);}else if(a.includes('crash')){fs.writeFileSync(get('-o')||get('--out'),'partial');process.exit(7);}else if(${JSON.stringify(e)}==='whisper'){if(a.includes('-np'))process.exit(8);fs.writeFileSync(get('-of')+'.json',JSON.stringify({transcription:[{offsets:{from:0,to:700},text:'你好。'},{offsets:{from:1000,to:2000},text:'Hello.'}]}));}else if(${JSON.stringify(e)}==='sd'){execFileSync(${JSON.stringify(ffmpeg)},['-v','error','-y','-f','lavfi','-i','color=red:s='+get('-W')+'x'+get('-H'),'-frames:v','1','-threads','1',get('-o')]);}else{const duration=a.find(x=>x.startsWith('duration_sec=')).split('=')[1];execFileSync(${JSON.stringify(ffmpeg)},['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration='+duration,get('--out')]);}\n`;
    await fs.writeFile(file, script, { mode: 0o755 });
    await fs.writeFile(
      path.join(dir, '..', 'manifest.json'),
      JSON.stringify({
        commit: sources[e].commit,
        backend: 'cpu',
        platform: `${process.platform}-${process.arch}`,
        files: [
          {
            path: 'bin/' + sources[e].binary,
            sha256: createHash('sha256').update(script).digest('hex'),
          },
        ],
      }),
    );
    const id = modelCatalog.find((m) => m.engine === e)!.id;
    models.start(id);
    await models.wait(id);
  }
  return new NativeTools(path.join(root, 'generated'), resources, models);
}
test('模型已安装但运行程序缺失：独立诊断与应用内安装提示', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-runtime-state-'));
  try {
    const native = await fixtures(root),
      settings = structuredClone(defaultServiceSettings);
    for (const e of ['whisper', 'sd', 'audio'] as const) settings.native[e].backend = 'cpu';
    const initial = (await native.status(settings)).find((e) => e.id === 'audio')!;
    assert.equal(initial.available, true);
    assert.equal(initial.model.installed, true);
    const manifestFile = path.join(path.dirname(initial.runtimePath), '..', 'manifest.json');
    const manifest = await fs.readFile(manifestFile, 'utf8');
    await fs.rm(manifestFile);
    const missing = (await native.status(settings)).find((e) => e.id === 'audio')!;
    assert.equal(missing.available, false);
    assert.equal(missing.model.installed, true);
    assert.match(missing.runtimeIssue!, /未找到运行程序清单/);
    assert.match(missing.setupHint, /已下载的模型可保留/);
    await assert.rejects(native.runtime('audio', 'cpu'), /预期位置.*runtimes.*编译并安装/);

    await fs.writeFile(manifestFile, '{broken');
    assert.match(
      (await native.status(settings)).find((e) => e.id === 'audio')!.runtimeIssue!,
      /清单损坏/,
    );
    await fs.writeFile(manifestFile, manifest);
    await fs.rm(initial.runtimePath);
    const noExecutable = (await native.status(settings)).find((e) => e.id === 'audio')!;
    assert.equal(noExecutable.available, false);
    assert.equal(noExecutable.model.installed, true);
    assert.match(noExecutable.runtimeIssue!, /文件缺失/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('本地 CLI 协议替身：源时间码、真实 PNG/WAV、素材导入、项目隔离和取消', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-native-'));
  try {
    const native = await fixtures(root),
      settings = structuredClone(defaultServiceSettings);
    for (const e of ['whisper', 'sd', 'audio'] as const) settings.native[e].backend = 'cpu';
    const store = new ProjectStore();
    const project = await store.create(root, '本地工具 中文', false);
    let image;
    for (const size of ['512x512', '512x768', '768x512'] as const) {
      native.start({ projectId: project.id, kind: 'image', prompt: 'red', size }, settings);
      for (let i = 0; i < 200 && String(native.job?.status) === 'running'; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(native.job!.status, 'done', native.job!.message);
      assert.throws(() => native.result(native.job!.id, 'different-project'), /变化/);
      image = await store.importOne(native.result(native.job!.id, project.id));
      assert.equal(image.kind, 'image');
      assert.deepEqual([image.width, image.height], size.split('x').map(Number));
    }
    for (const seconds of [10, 20, 30] as const) {
      native.start({ projectId: project.id, kind: 'music', prompt: 'ambient', seconds }, settings);
      for (let i = 0; i < 200 && String(native.job?.status) === 'running'; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(native.job!.status, 'done', native.job!.message);
      const asset = await store.importOne(native.result(native.job!.id, project.id));
      assert.equal(asset.durationFrames, seconds * 30);
    }
    const music = project.assets.find((a) => a.kind === 'audio')!;
    project.tracks.push({
      id: uid(),
      name: '生成图片',
      kind: 'image',
      muted: false,
      clips: [createClip(project, image!)],
    });
    project.tracks.find((t) => t.kind === 'audio')!.clips = [
      { ...createClip(project, music), duration: 90 },
    ];
    await store.save(project);
    await store.read(store.file, false);
    const target = path.join(root, '生成素材成片.mp4');
    await exportVideo(
      store.project!,
      store.root,
      target,
      path.resolve('resources/fonts/NotoSansCJKsc-Regular.otf'),
      signal(),
      () => {},
    );
    const info = await probe(target);
    assert.equal(info.streams.find((s) => s.codec_type === 'video')?.codec_name, 'h264');
    assert.equal(info.streams.find((s) => s.codec_type === 'audio')?.codec_name, 'aac');
    assert.equal(Number(info.format.duration), 3);
    const work = path.join(root, 'speech-work');
    await fs.mkdir(work);
    const source = native.result(native.job!.id, project.id);
    const result = await native.transcribe(
      source,
      2,
      'auto',
      settings.native.whisper,
      signal(),
      work,
      () => {},
    );
    assert.equal(result[1].startMs, 1000);
    assert.equal(result[0].text, '你好。');
    assert.equal(whisperSegments({ transcription: [] }, 0, 1000).length, 0);
    const abort = new AbortController(),
      bin = await native.runtime('sd', 'cpu');
    const running = runNative(
      bin,
      ['hang', '-o', path.join(root, 'cancelled-output')],
      abort.signal,
    );
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(running, /取消/);
    assert.ok((await native.cacheBytes()) > 0);
    await native.clearCache();
    assert.equal(native.job, null);
    assert.equal(await native.cacheBytes(), 0);
    assert.ok((await fs.stat(path.join(store.root, image!.path))).size > 0);
    assert.ok((await fs.readdir(path.join(store.root, '.cutcut-history'))).length > 0);
    await store.autosave(project);
    await store.close(true);
    assert.equal(store.project, null);
    assert.equal(store.root, '');
    await assert.rejects(store.autosave(project), /会话/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
