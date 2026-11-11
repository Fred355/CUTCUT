import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { binaries, run } from '../src/main/media';
const output = path.resolve('resources/toolchain');
await fs.mkdir(output, { recursive: true });
const manifest: Record<string, unknown> = { platform: process.platform, arch: process.arch };
for (const [name, file] of Object.entries(binaries())) {
  manifest[name] = {
    version: (await run(file, ['-version'])).split('\n')[0],
    sha256: createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex'),
  };
}
const ff = binaries().ffmpeg;
for (const suffix of ['LICENSE', 'README'])
  await fs.copyFile(`${ff}.${suffix}`, path.join(output, `ffmpeg.${suffix}`));
await fs.copyFile('node_modules/@napi-rs/canvas/LICENSE', path.join(output, 'canvas.LICENSE'));
await fs.copyFile(
  'node_modules/@ffprobe-installer/ffprobe/README.md',
  path.join(output, 'ffprobe.README.md'),
);
await fs.writeFile(path.join(output, 'media-tools.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  'Recorded media tool versions, SHA-256 and license notices for',
  process.platform,
  process.arch,
);
