// Records immutable upstream revisions, exact sizes and SHA-256 without downloading weights.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/main/store';
import { NativeModels, validateBundledLocks } from '../src/main/native-models';
import { modelCatalog } from '../src/shared/native';
const target = 'resources/native/models.lock.json';
if (!process.argv.includes('--refresh') && (await fs.stat(target).catch(() => null)))
  throw new Error('已有固定清单；仅在明确升级模型时使用 --refresh');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-model-lock-'));
try {
  const models = new NativeModels(root);
  const locks = [];
  for (const m of modelCatalog) {
    console.log('Resolving', m.name);
    locks.push(await models.lock(m.id));
  }
  validateBundledLocks(locks);
  await atomicWrite(target, JSON.stringify(locks, null, 2) + '\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
