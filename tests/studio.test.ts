import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProject, createClip } from '../src/shared/model';
import {
  mappedSentences,
  sentenceCuts,
  splitAtSentences,
  transcriptSRT,
  compileProposal,
  type Transcript,
} from '../src/shared/studio';
const transcript: Transcript = {
  version: 1,
  assetId: 'asset',
  fingerprint: 'test',
  engine: 'fixture',
  language: 'zh',
  segments: [
    { id: 's1', startMs: 0, endMs: 1000, text: '第一句。' },
    { id: 's2', startMs: 1500, endMs: 2500, text: '第二句。' },
  ],
};
function fixture() {
  const p = newProject('测试');
  const a = {
    id: 'asset',
    name: '视频',
    kind: 'video' as const,
    path: 'assets/a.mp4',
    durationFrames: 90,
    width: 320,
    height: 180,
    hasAudio: true,
    hdr: false,
  };
  p.assets = [a];
  const c = { ...createClip(p, a, 90), in: 15, duration: 60, volume: 0.4 };
  p.tracks = [{ id: 'track', name: '视频', kind: 'video', muted: false, clips: [c] }];
  return { p, c };
}
test('句子映射保留裁剪偏移及停顿，切分保留音量和源范围', () => {
  const { p, c } = fixture();
  assert.deepEqual(
    mappedSentences(transcript, c).map((s) => [s.start, s.duration]),
    [
      [90, 15],
      [120, 30],
    ],
  );
  const cuts = sentenceCuts(transcript, c);
  assert.deepEqual(cuts, [120]);
  const split = splitAtSentences(p, c.id, [120, 120, -1, 150]);
  assert.deepEqual(
    split.tracks[0].clips.map((c) => [c.start, c.in, c.duration, c.volume]),
    [
      [90, 15, 30, 0.4],
      [120, 45, 30, 0.4],
    ],
  );
  assert.match(transcriptSRT(p, transcript, [c.id]), /00:00:04,000 --> 00:00:05,000/);
});
test('初剪拒绝未知素材、源越界及画面重叠', () => {
  const { p } = fixture();
  const row = { assetId: 'asset', in: 0, start: 0, duration: 30, reason: 'test', volume: 1 };
  const proposal = { title: '初剪', summary: 'test', clips: [row] };
  assert.equal(compileProposal(p, proposal, false, ['asset']).tracks[0].clips.length, 1);
  assert.throws(() => compileProposal(p, proposal, false, []));
  assert.throws(() =>
    compileProposal(p, { ...proposal, clips: [{ ...row, in: 80 }] }, false, ['asset']),
  );
  assert.throws(() => compileProposal(p, { ...proposal, clips: [row, row] }, false, ['asset']));
});
