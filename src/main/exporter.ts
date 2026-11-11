import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { textLines } from '../shared/text';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { binaries, run, probe, toneMap } from './media';
import { safeFile } from './store';
import { projectSchema, endFrame, clipRect, type Project } from '../shared/model';
import type { ExportEvent } from '../shared/bridge';
export async function exportVideo(
  project: Project,
  root: string,
  target: string,
  font: string,
  signal: AbortSignal,
  onEvent: (e: ExportEvent) => void,
) {
  const p = projectSchema.parse(project),
    end = endFrame(p);
  if (!end) throw new Error('空工程无法导出');
  const seconds = end / p.fps;
  const work = await fs.mkdtemp(path.join(path.dirname(target), '.cutcut-render-'));
  const tmp = path.join(work, 'output.mp4');
  try {
    if (!GlobalFonts.registerFromPath(font, 'CutcutSans')) throw new Error('无法加载中文字体');
    const args = ['-nostdin', '-y', '-v', 'error', '-filter_complex_threads', '2'];
    const filters: string[] = [
      `color=c=black:s=${p.width}x${p.height}:r=${p.fps}:d=${seconds},format=rgba[base]`,
      `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds}[silence]`,
    ];
    let input = 0,
      visual = 'base';
    const audios = ['[silence]'];
    for (const track of [...p.tracks].reverse()) {
      for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
        const tag = c.id.replaceAll('-', ''),
          start = c.start / p.fps,
          duration = c.duration / p.fps,
          finish = (c.start + c.duration) / p.fps;
        if (track.kind === 'text') {
          const canvas = createCanvas(p.width, p.height),
            ctx = canvas.getContext('2d');
          ctx.font = `${c.fontSize}px CutcutSans`;
          ctx.fillStyle = c.color;
          ctx.globalAlpha = c.opacity;
          ctx.textBaseline = 'alphabetic';
          for (const line of textLines(c, (text) => ctx.measureText(text)))
            ctx.fillText(line.text, line.x, line.y);
          const file = path.join(work, `${tag}.png`);
          await fs.writeFile(file, await canvas.encode('png'));
          args.push('-loop', '1', '-framerate', String(p.fps), '-t', String(duration), '-i', file);
          const i = input++,
            fg = `f${tag}`,
            next = `v${tag}`;
          filters.push(`[${i}:v]format=rgba,setpts=PTS-STARTPTS+${start}/TB[${fg}]`);
          filters.push(
            `[${visual}][${fg}]overlay=0:0:format=rgb:eof_action=pass:repeatlast=0:enable='gte(t,${start})*lt(t,${finish})'[${next}]`,
          );
          visual = next;
          continue;
        }
        const a = p.assets.find((a) => a.id === c.assetId)!;
        const source = await safeFile(root, a.path);
        if (a.kind === 'image') args.push('-loop', '1', '-framerate', String(p.fps));
        else args.push('-ss', String(c.in / p.fps));
        args.push('-threads', '2', '-t', String(duration), '-i', source);
        const i = input++;
        if (a.kind !== 'audio') {
          const r = clipRect(p, a, c);
          const w = Math.max(2, Math.round(r.width / 2) * 2),
            h = Math.max(2, Math.round(r.height / 2) * 2);
          if (w > 8192 || h > 8192) throw new Error('画面缩放超过 8192 像素，请缩小素材');
          const fg = `f${tag}`,
            next = `v${tag}`;
          filters.push(
            `[${i}:v]${a.hdr ? toneMap + ',' : ''}fps=${p.fps},scale=${w}:${h},setsar=1,format=rgba,colorchannelmixer=aa=${c.opacity},setpts=PTS-STARTPTS+${start}/TB[${fg}]`,
          );
          filters.push(
            `[${visual}][${fg}]overlay=x=${c.x}:y=${c.y}:format=rgb:eof_action=pass:repeatlast=0:enable='gte(t,${start})*lt(t,${finish})'[${next}]`,
          );
          visual = next;
        }
        if (a.hasAudio && !c.muted && !track.muted && c.volume > 0) {
          const label = `a${tag}`;
          filters.push(
            `[${i}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${c.volume},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[${label}]`,
          );
          audios.push(`[${label}]`);
        }
      }
    }
    filters.push(`[${visual}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);
    filters.push(
      `${audios.join('')}amix=inputs=${audios.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[aout]`,
    );
    await fs.writeFile(path.join(work, 'filters.txt'), filters.join(';\n'));
    args.push(
      '-filter_complex_script',
      'filters.txt',
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-t',
      String(seconds),
      '-r',
      String(p.fps),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      tmp,
    );
    onEvent({ status: 'rendering', progress: 0 });
    let partial = '';
    await run(binaries().ffmpeg, args, {
      cwd: work,
      signal,
      onData: (data) => {
        partial += data;
        const lines = partial.split('\n');
        partial = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('out_time_ms=')) {
            const v = Number(line.slice(12));
            if (Number.isFinite(v))
              onEvent({ status: 'rendering', progress: Math.min(0.98, v / 1_000_000 / seconds) });
          }
        }
      },
    });
    onEvent({ status: 'validating', progress: 0.99 });
    const info = await probe(tmp, signal);
    if (
      info.streams.find((s) => s.codec_type === 'video')?.codec_name !== 'h264' ||
      info.streams.find((s) => s.codec_type === 'audio')?.codec_name !== 'aac' ||
      Math.abs(Number(info.format.duration) - seconds) > 0.15
    )
      throw new Error('导出文件验证失败');
    await run(
      binaries().ffmpeg,
      ['-nostdin', '-v', 'error', '-xerror', '-i', tmp, '-f', 'null', '-'],
      { signal },
    );
    if (signal.aborted) throw new Error('操作已取消');
    await fs.rename(tmp, target);
    onEvent({ status: 'done', progress: 1, message: target });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
