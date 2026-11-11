import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Asset } from '../shared/model';
const require = createRequire(
  typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json'),
);
export function binaries() {
  const unpack = (p: string) => p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  return {
    ffmpeg: process.env.CUTCUT_FFMPEG || unpack(require('ffmpeg-static')),
    ffprobe: process.env.CUTCUT_FFPROBE || unpack(require('@ffprobe-installer/ffprobe').path),
  };
}
export async function run(
  bin: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onData?: (s: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '',
      err = '';
    const child = spawn(bin, args, { cwd: options.cwd, signal: options.signal, windowsHide: true });
    child.stdout.on('data', (b) => {
      out = (out + b).slice(-2_000_000);
      options.onData?.(String(b));
    });
    child.stderr.on('data', (b) => {
      err = (err + b).slice(-12000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              options.signal?.aborted
                ? '操作已取消'
                : `${path.basename(bin)} 失败 (${code})：${err.slice(-3000)}`,
            ),
          ),
    );
  });
}
export async function probe(file: string, signal?: AbortSignal) {
  return JSON.parse(
    await run(
      binaries().ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { signal },
    ),
  ) as { streams: any[]; format: { duration?: string } };
}
export async function describe(file: string): Promise<Omit<Asset, 'id' | 'name' | 'path'>> {
  const data = await probe(file);
  const v = data.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic),
    a = data.streams.find((s) => s.codec_type === 'audio');
  const ext = path.extname(file).toLowerCase();
  const image = ['.jpg', '.jpeg', '.png'].includes(ext);
  if (image && (!v || !['mjpeg', 'png'].includes(v.codec_name))) throw new Error('图片编码不支持');
  if (!image && !['.mp4', '.mov', '.mp3', '.wav', '.m4a'].includes(ext))
    throw new Error('不支持该文件格式');
  if (!v && !a) throw new Error('文件中没有可读取的画面或声音');
  if (!image && ['.mp4', '.mov'].includes(ext) && !v) throw new Error('视频文件没有画面轨');
  const duration = Number(data.format.duration || v?.duration || a?.duration || 0);
  if (!image && (!Number.isFinite(duration) || duration <= 0))
    throw new Error('无法读取有效素材时长');
  if (duration > 86400) throw new Error('素材时长超过 24 小时');
  let width = v?.width || 0,
    height = v?.height || 0;
  const rotation = Number(
    v?.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation || v?.tags?.rotate || 0,
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    kind: image ? 'image' : v ? 'video' : 'audio',
    durationFrames: image ? 90 : Math.floor(duration * 30),
    width,
    height,
    hasAudio: !!a,
    hdr: ['smpte2084', 'arib-std-b67'].includes(v?.color_transfer),
  };
}
export const toneMap =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
export async function prepareMedia(root: string, asset: Asset) {
  const source = path.join(root, asset.path),
    cache = path.join(root, 'cache');
  await fs.mkdir(cache, { recursive: true });
  const ff = binaries().ffmpeg;
  if (asset.kind === 'video') {
    asset.preview = `cache/${asset.id}.mp4`;
    await run(ff, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      `${asset.hdr ? toneMap + ',' : ''}scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      path.join(root, asset.preview),
    ]);
  }
  if (asset.kind === 'audio') {
    asset.preview = `cache/${asset.id}.wav`;
    await run(ff, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      source,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      path.join(root, asset.preview),
    ]);
  }
  if (asset.kind !== 'audio') {
    asset.thumbnail = `cache/${asset.id}.jpg`;
    await run(ff, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      path.join(root, asset.preview || asset.path),
      '-frames:v',
      '1',
      '-vf',
      'scale=240:240:force_original_aspect_ratio=decrease',
      '-threads',
      '1',
      path.join(root, asset.thumbnail),
    ]);
  }
  return asset;
}
