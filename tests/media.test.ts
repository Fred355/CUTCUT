import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectStore, atomicWrite, safeFile } from '../src/main/store';
import { binaries, run, probe, describe } from '../src/main/media';
import { exportVideo } from '../src/main/exporter';
import { createClip, uid, type Project } from '../src/shared/model';
const exec = promisify(execFile),
  font = path.resolve('resources/fonts/NotoSansCJKsc-Regular.otf');
test('真实媒体闭环与文件安全', { timeout: 180000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "原始 视频 '一'.mp4"),
    image = path.join(temp, '绿色.png'),
    audio = path.join(temp, '背景音乐.wav'),
    ff = binaries().ffmpeg;
  await run(ff, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=320x180:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=320x180:r=30:d=1',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    source,
  ]);
  await run(ff, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=lime:s=100x100',
    '-frames:v',
    '1',
    '-threads',
    '1',
    image,
  ]);
  await run(ff, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:a',
    'pcm_s16le',
    audio,
  ]);
  const store = new ProjectStore();
  await store.create(temp, '中文 工程', false);
  const videoAsset = await store.importOne(source),
    imageAsset = await store.importOne(image),
    audioAsset = await store.importOne(audio);
  let p = structuredClone(store.project!);
  const first = { ...createClip(p, videoAsset), duration: 15 };
  const second = { ...createClip(p, videoAsset, 15), duration: 15, in: 30 };
  p.tracks[1].clips = [first, second];
  p.tracks[0].clips = [
    {
      ...createClip(p, undefined, 0),
      duration: 15,
      text: "中文 CUTCUT 100% : '测试'",
      x: 600,
      y: 100,
      fontSize: 64,
    },
  ];
  p.tracks.splice(1, 0, {
    id: uid(),
    name: '画中画',
    kind: 'image',
    muted: false,
    clips: [{ ...createClip(p, imageAsset, 15), duration: 15, x: 0, y: 0, scale: 0.25 }],
  });
  p.tracks[3].clips = [{ ...createClip(p, audioAsset, 15), duration: 45, volume: 0.5 }];
  await t.test('复制素材、生成代理与缩略图、保存重开及草稿恢复', async () => {
    assert.notEqual(path.join(store.root, videoAsset.path), source);
    assert.equal(
      (await fs.readFile(source)).compare(
        await fs.readFile(path.join(store.root, videoAsset.path)),
      ),
      0,
    );
    assert.ok((await fs.stat(await store.media(videoAsset.id, 'preview'))).size > 0);
    await store.save(p);
    const reloaded = await store.read(store.file, false);
    assert.deepEqual(reloaded.project, p);
    await store.autosave({ ...p, name: '恢复版本' });
    assert.equal((await store.read(store.file, true)).project.name, '恢复版本');
    await store.save(p);
    await assert.rejects(fs.stat(path.join(store.root, '.cutcut-recovery.json')));
  });
  await t.test('真实 H.264/AAC 导出、图层、源入点、字幕、空白与混音', async () => {
    const output = path.join(temp, '导出 成片.mp4');
    const progress: number[] = [];
    await exportVideo(p, store.root, output, font, new AbortController().signal, (e) =>
      progress.push(e.progress),
    );
    assert.equal(progress.at(-1), 1);
    const info = await probe(output);
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 1920);
    assert.equal(v.height, 1080);
    assert.equal(info.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
    assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.1);
    const pixels = async (time: string) => {
      const { stdout } = await exec(
        ff,
        [
          '-v',
          'error',
          '-ss',
          time,
          '-i',
          output,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 10_000_000 },
      );
      return stdout;
    };
    const at = (buf: Buffer, x: number, y: number) => [
      ...buf.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3),
    ];
    const early = await pixels('0.2'),
      mid = await pixels('0.7'),
      gap = await pixels('1.5');
    assert.ok(at(early, 100, 100)[0] > 220, '底层为红色');
    assert.ok(
      at(mid, 100, 100)[1] > 220,
      '上层绿色画中画覆盖 ' + JSON.stringify(at(mid, 100, 100)),
    );
    assert.ok(at(mid, 900, 900)[2] > 220, '裁剪后的源入点为蓝色');
    assert.ok(
      at(gap, 100, 100).every((n) => n < 10),
      '尾部画面为空黑屏',
    );
    let white = 0;
    for (let y = 100; y < 200; y++)
      for (let x = 600; x < 1500; x++) if (at(early, x, y).every((n) => n > 200)) white++;
    assert.ok(white > 100, '中文字体产生可见字幕像素');
    const { stdout: pcm } = await exec(
      ff,
      ['-v', 'error', '-i', output, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 2_000_000 },
    );
    const rms = (from: number, to: number) => {
      let sum = 0,
        count = 0;
      for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000); i++) {
        sum += pcm.readFloatLE(i * 4) ** 2;
        count++;
      }
      return Math.sqrt(sum / count);
    };
    assert.ok(rms(0.1, 0.3) < 0.001, '音乐开始前保持静音');
    assert.ok(rms(0.7, 0.9) > 0.01, '音乐出现');
    assert.ok(rms(0.7, 0.9) < 0.07, '音量系数生效');
    await exportVideo(p, store.root, output, font, new AbortController().signal, () => {});
    assert.ok((await fs.stat(output)).size > 1000, '同一目标可再次导出');
  });
  await t.test('取消与失败保留已有成片，清理临时目录，拒绝空工程', async () => {
    const target = path.join(temp, 'existing.mp4');
    await fs.writeFile(target, 'original');
    const abort = new AbortController();
    await assert.rejects(
      exportVideo(p, store.root, target, font, abort.signal, (e) => {
        if (e.status === 'rendering' && e.progress > 0) abort.abort();
      }),
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    assert.equal((await fs.readdir(temp)).filter((x) => x.startsWith('.cutcut-render-')).length, 0);
    await assert.rejects(
      exportVideo(
        { ...p, tracks: [] },
        store.root,
        target,
        font,
        new AbortController().signal,
        () => {},
      ),
      /空工程/,
    );
    await assert.rejects(
      exportVideo(
        p,
        store.root,
        target,
        path.join(temp, 'missing-font'),
        new AbortController().signal,
        () => {},
      ),
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
  });
  await t.test('工程迁移、缺失检测与重新定位', async () => {
    await store.save(p);
    const migrated = path.join(temp, '迁移 工程');
    await fs.cp(store.root, migrated, { recursive: true });
    const other = new ProjectStore();
    assert.deepEqual((await other.read(path.join(migrated, 'project.cutcut'), false)).missing, []);
    await fs.rm(path.join(migrated, videoAsset.path));
    assert.deepEqual(await other.missing(p), [videoAsset.id]);
    const replacement = await other.relink(videoAsset.id, source);
    assert.equal(replacement.id, videoAsset.id);
    assert.deepEqual(await other.missing(other.project!), []);
  });
  await t.test('损坏文件、错误扩展名、外部符号链接被拒绝', async () => {
    const broken = path.join(temp, 'bad.mp4');
    await fs.writeFile(broken, 'broken');
    await assert.rejects(describe(broken));
    const unsupported = path.join(temp, 'source.xyz');
    await fs.copyFile(source, unsupported);
    await assert.rejects(describe(unsupported));
    await fs.symlink(source, path.join(store.root, 'assets', 'outside.mp4'));
    await assert.rejects(safeFile(store.root, 'assets/outside.mp4'));
    await assert.rejects(safeFile(store.root, '../anything'));
  });
  await t.test('磁盘写入失败保留原工程并清理临时文件', async () => {
    const before = await fs.readFile(store.file, 'utf8');
    const original = fs.open;
    t.mock.method(fs, 'open', async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    try {
      await assert.rejects(atomicWrite(store.file, 'corrupt'), /disk full/);
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(await fs.readFile(store.file, 'utf8'), before);
    assert.equal((await fs.readdir(store.root)).filter((x) => x.endsWith('.tmp')).length, 0);
  });
});

test('HDR 素材转 SDR、竖屏导出与视频原声', { timeout: 90000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-hdr-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'HDR.mp4'),
    ff = binaries().ffmpeg;
  await run(ff, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=gray:s=160x90:r=30:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=0.5',
    '-c:v',
    'libx265',
    '-x265-params',
    'pools=1:frame-threads=1:log-level=error',
    '-pix_fmt',
    'yuv420p10le',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-colorspace',
    'bt2020nc',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
  const store = new ProjectStore();
  await store.create(temp, '竖屏', true);
  const asset = await store.importOne(file);
  assert.equal(asset.hdr, true);
  assert.equal(asset.hasAudio, true);
  assert.ok(asset.preview);
  const p = structuredClone(store.project!);
  p.tracks[1].clips = [{ ...createClip(p, asset), duration: 15 }];
  const target = path.join(temp, 'portrait.mp4');
  await exportVideo(p, store.root, target, font, new AbortController().signal, () => {});
  const metadata = await probe(target),
    v = metadata.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.color_transfer, 'bt709');
  assert.equal(v.pix_fmt, 'yuv420p');
  const { stdout: pcm } = await exec(
    ff,
    ['-v', 'error', '-i', target, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1_000_000 },
  );
  let power = 0;
  for (let i = 0; i < pcm.length; i += 4) power += pcm.readFloatLE(i) ** 2;
  assert.ok(Math.sqrt(power / (pcm.length / 4)) > 0.02, '原视频音轨进入成片');
});
