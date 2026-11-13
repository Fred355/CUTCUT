import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeTools } from '../src/main/native-tools';
import { NativeModels, validateBundledLocks } from '../src/main/native-models';
import { engineIds, type NativeOptions } from '../src/shared/native';

export async function checkNativeBundle(
  resources: string,
  backends: NativeOptions['backend'][] = ['cpu', 'metal'],
) {
  const lockFile = path.join(resources, 'native', 'models.lock.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch {
    throw new Error('缺少有效模型清单，请先执行 npm run models:lock');
  }
  validateBundledLocks(raw);
  const native = new NativeTools('', resources, new NativeModels(''));
  for (const engine of engineIds)
    for (const backend of backends) {
      await native.runtime(engine, backend);
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(
            resources,
            'runtimes',
            `${process.platform}-${process.arch}`,
            engine,
            backend,
            'manifest.json',
          ),
          'utf8',
        ),
      );
      if (!manifest.files.some((f: { path: string }) => f.path.startsWith('licenses/')))
        throw new Error(`${engine} ${backend} 缺少运行时许可证`);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkNativeBundle(
    path.resolve('resources'),
    process.argv.includes('--cpu-only') ? ['cpu'] : ['cpu', 'metal'],
  );
  console.log('运行时、哈希、许可证和固定模型清单检查通过（不代表模型推理已验收）');
}
