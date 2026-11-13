import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineId, NativeOptions } from '../shared/native';
export const runtimeHome = (root: string, engine: EngineId, backend: NativeOptions['backend']) =>
  path.join(root, `${process.platform}-${process.arch}`, engine, backend);
export async function installedRuntime(
  root: string,
  engine: EngineId,
  backend: NativeOptions['backend'],
): Promise<string | null> {
  const home = runtimeHome(root, engine, backend);
  let pointer: any;
  try {
    pointer = JSON.parse(await fs.readFile(path.join(home, 'active.json'), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw new Error('已安装的运行程序记录损坏，请重新安装');
  }
  if (typeof pointer.id !== 'string' || !/^[a-f0-9-]{36}$/.test(pointer.id))
    throw new Error('运行程序安装记录无效');
  return path.join(home, 'versions', pointer.id);
}
