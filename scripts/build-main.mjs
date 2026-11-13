import { build } from 'esbuild';
await build({
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'ffmpeg-static', '@ffprobe-installer/ffprobe', '@napi-rs/canvas'],
});
await build({
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  entryPoints: ['scripts/build-native.mjs'],
  outfile: 'resources/native/build-native.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
