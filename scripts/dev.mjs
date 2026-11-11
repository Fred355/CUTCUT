import { spawn } from 'node:child_process';
import { createServer } from 'vite';
await import('./build-main.mjs');
const server = await createServer();
await server.listen();
const { default: electron } = await import('electron');
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, CUTCUT_DEV_URL: 'http://127.0.0.1:5173' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
