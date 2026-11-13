import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin')
  throw new Error('请在 macOS 上运行打包，以包含匹配架构的 FFmpeg/ffprobe。');
const check = spawnSync('npx', ['--no-install', 'tsx', 'scripts/check-native.ts', '--installer'], {
  stdio: 'inherit',
});
if (check.status !== 0) process.exit(check.status || 1);
const result = spawnSync(
  'npx',
  ['--no-install', 'electron-builder', '--mac', process.arch === 'arm64' ? '--arm64' : '--x64'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
