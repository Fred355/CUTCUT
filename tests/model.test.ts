import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newProject,
  createClip,
  splitClip,
  changeClip,
  moveClip,
  projectSchema,
  uid,
  endFrame,
  centerClip,
  clipRect,
  type Asset,
} from '../src/shared/model';
const fixture = () => {
  const p = newProject('测试');
  const a: Asset = {
    id: uid(),
    name: '素材',
    kind: 'video',
    path: 'assets/source.mp4',
    durationFrames: 300,
    width: 640,
    height: 480,
    hasAudio: true,
    hdr: false,
  };
  p.assets = [a];
  p.tracks[1].clips = [createClip(p, a)];
  return p;
};
test('拆分保持连续源帧，裁剪不允许越界，拒绝同轨重叠', () => {
  let p = fixture();
  const original = p.tracks[1].clips[0];
  p = splitClip(p, original.id, 60);
  assert.deepEqual(
    p.tracks[1].clips.map((c) => [c.start, c.in, c.duration]),
    [
      [0, 0, 60],
      [60, 60, 240],
    ],
  );
  assert.equal(endFrame(p), 300);
  assert.throws(() => changeClip(p, p.tracks[1].clips[1].id, { start: 59 }));
  assert.throws(() => changeClip(p, original.id, { in: 299, duration: 2 }));
  assert.throws(() => splitClip(p, original.id, 0));
});
test('支持同类型跨轨移动，拒绝错误类型；居中保持比例', () => {
  let p = fixture();
  const id = p.tracks[1].clips[0].id;
  assert.throws(() => moveClip(p, id, p.tracks[2].id, 0));
  p.tracks.unshift({ id: uid(), name: '叠加', kind: 'video', muted: false, clips: [] });
  p = moveClip(p, id, p.tracks[0].id, 15);
  assert.equal(p.tracks[2].clips.length, 0);
  assert.equal(p.tracks[0].clips[0].start, 15);
  const c = centerClip(p, p.assets[0], p.tracks[0].clips[0]);
  assert.deepEqual(clipRect(p, p.assets[0], c), { x: 240, y: 0, width: 1440, height: 1080 });
});
test('不信任外部工程：拒绝路径遍历、重复 ID、非法数值与版本', () => {
  for (const relative of [
    '../outside.mp4',
    '/etc/passwd',
    'assets/../../x',
    'C:\\x',
    'assets//x',
  ]) {
    const p = fixture();
    p.assets[0].path = relative;
    assert.equal(projectSchema.safeParse(p).success, false);
  }
  const p = fixture();
  p.tracks[0].id = p.id;
  assert.equal(projectSchema.safeParse(p).success, false);
  assert.equal(projectSchema.safeParse({ ...fixture(), version: 2 }).success, false);
  const q = fixture();
  assert.throws(() => changeClip(q, q.tracks[1].clips[0].id, { x: Infinity }));
});

test('拆分保留音量、静音和独立文字轨的完整时间范围', async () => {
  const { createTextClip } = await import('../src/shared/model');
  let p = fixture();
  const video = p.tracks[1].clips[0];
  video.volume = 0.4;
  const caption = createTextClip(p, video.id, 100);
  p.tracks[0].clips = [caption];
  assert.equal(caption.start, 0);
  assert.equal(caption.duration, 300);
  p = splitClip(p, video.id, 120);
  assert.deepEqual(
    p.tracks[1].clips.map((c) => [c.volume, c.muted, c.in]),
    [
      [0.4, false, 0],
      [0.4, false, 120],
    ],
  );
  assert.deepEqual(p.tracks[0].clips, [caption]);
  // Explicitly shortened existing captions are never silently extended by splitting video.
  p.tracks[0].clips[0].duration = 60;
  p = splitClip(p, p.tracks[1].clips[1].id, 180);
  assert.equal(p.tracks[0].clips[0].duration, 60);
});

test('画布四角缩放保持比例、锚点和文字字号范围', async () => {
  const { resizeVisual } = await import('../src/shared/transform');
  const p = fixture(),
    c = p.tracks[1].clips[0];
  const rect = { x: 100, y: 200, width: 800, height: 600 };
  assert.deepEqual(resizeVisual(c, rect, 'se', { x: 500, y: 500 }), { scale: 0.5, x: 100, y: 200 });
  assert.deepEqual(resizeVisual(c, rect, 'nw', { x: 500, y: 500 }), { scale: 0.5, x: 500, y: 500 });
  const text = { ...c, text: '中文', fontSize: 64 };
  const patch = resizeVisual(text, rect, 'se', { x: 500, y: 500 });
  assert.equal(patch.fontSize, 32);
  assert.equal(patch.scale, undefined);
  assert.equal(resizeVisual(text, rect, 'se', { x: 100000, y: 100000 }).fontSize, 400);
});
