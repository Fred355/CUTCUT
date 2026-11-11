import { binaries, run } from '../src/main/media';
for (const [name, bin] of Object.entries(binaries()))
  console.log(name, bin, (await run(bin, ['-version'])).split('\n')[0]);
const filters = await run(binaries().ffmpeg, ['-hide_banner', '-filters']);
for (const f of ['overlay', 'zscale', 'tonemap', 'alimiter'])
  if (!filters.includes(f)) throw new Error(`FFmpeg 缺少必要滤镜 ${f}`);
console.log('媒体工具功能检查通过');
const { readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const [expected, font] = (await readFile('resources/fonts/SHA256SUMS', 'utf8')).trim().split(/\s+/);
if (
  createHash('sha256')
    .update(await readFile(font))
    .digest('hex') !== expected
)
  throw new Error('随附中文字体的 SHA-256 校验失败');
console.log('中文字体 SHA-256 校验通过');
