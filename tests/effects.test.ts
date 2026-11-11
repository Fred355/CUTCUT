import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newProject, createClip, projectSchema, sourceFrame } from '../src/shared/model';
import { changeSpeed, dissolve, evaluatedClip } from '../src/shared/effects';
import { exportVideo } from '../src/main/exporter';
import { binaries, run, probe } from '../src/main/media';
const asset = {
  id: 'a',
  path: 'a.mp4',
  name: 'a',
  kind: 'video' as const,
  width: 320,
  height: 180,
  durationFrames: 120,
  hasAudio: true,
  hdr: false,
};
test('效果工程升级、关键帧插值及溶解余量', () => {
  const p = newProject('effects');
  p.assets = [asset];
  const c = createClip(p, asset);
  p.tracks = [{ id: 't', name: '视频', kind: 'video', muted: false, clips: [c] }];
  const next = projectSchema.parse(changeSpeed(p, c.id, 2));
  assert.equal(next.version, 2);
  assert.equal(next.tracks[0].clips[0].duration, 60);
  assert.equal(sourceFrame(next.tracks[0].clips[0], 15), 30);
  const animated = {
    ...c,
    keyframes: [
      { property: 'x' as const, frame: 0, value: 0, interpolation: 'linear' as const },
      { property: 'x' as const, frame: 30, value: 300, interpolation: 'linear' as const },
    ],
  };
  assert.equal(evaluatedClip(animated, 15).x, 150);
  p.tracks[0].clips = [
    { ...c, duration: 60 },
    { ...c, id: 'next', start: 60, in: 15, duration: 60 },
  ];
  const cross = projectSchema.parse(dissolve(p, c.id, 15));
  assert.equal(cross.tracks[0].clips[0].start, 45);
  assert.equal(cross.tracks[0].clips[0].in, 0);
  assert.throws(() => dissolve(p, c.id, 16), /余量/);
});
test('真实变速、音轨与动画导出', { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-effects-'));
  try {
    const ff = binaries().ffmpeg;
    await run(ff, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=320x180:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-c:a',
      'aac',
      '-shortest',
      path.join(root, 'a.mp4'),
    ]);
    const p = newProject('effects');
    p.version = 2;
    p.assets = [asset];
    const c = {
      ...createClip(p, asset),
      duration: 60,
      speed: 2,
      scale: 0.25,
      fadeIn: 6,
      fadeOut: 6,
      keyframes: [
        { property: 'x' as const, frame: 0, value: 0, interpolation: 'linear' as const },
        { property: 'x' as const, frame: 59, value: 500, interpolation: 'linear' as const },
      ],
    };
    p.tracks = [{ id: 't', name: 'v', kind: 'video', muted: false, clips: [c] }];
    const out = path.join(root, 'out.mp4');
    await exportVideo(
      p,
      root,
      out,
      path.resolve('resources/fonts/NotoSansCJKsc-Regular.otf'),
      new AbortController().signal,
      () => {},
    );
    const info = await probe(out);
    assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.1);
    assert.equal(info.streams.find((s) => s.codec_type === 'audio')?.codec_name, 'aac');
    const frame = path.join(root, 'frame.rgb');
    await run(ff, [
      '-y',
      '-v',
      'error',
      '-ss',
      '1',
      '-i',
      out,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      frame,
    ]);
    const rgb = await fs.readFile(frame);
    const red = (x: number, y: number) => rgb[(y * 1920 + x) * 3];
    assert.ok(red(350, 100) > 180);
    assert.ok(red(20, 100) < 30);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
