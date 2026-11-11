import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/main/store';
import { readVersion } from '../src/main/history';
test('持久版本可迁移，恢复前保留未保存工作，拒绝篡改及路径穿越', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-history-'));
  try {
    const store = new ProjectStore();
    const p = await store.create(tmp, '原始', false);
    await store.save({ ...p, name: '版本二' });
    const entries = await store.versions();
    assert.equal(entries.length, 2);
    const original = entries.find((e) => e.label === '原保存版本')!;
    const migrated = path.join(tmp, '迁移 工程');
    await fs.rename(store.root, migrated);
    const reopened = new ProjectStore();
    await reopened.read(path.join(migrated, 'project.cutcut'), false);
    const restored = await reopened.restoreVersion(original.id, {
      ...reopened.project!,
      name: '未保存工作',
    });
    assert.equal(restored.project.name, '原始');
    const history = await reopened.versions();
    assert.equal(history.length, 3);
    const before = history.find((e) => e.label === '恢复前的工作副本')!;
    assert.equal((await readVersion(migrated, before.id, p.id)).project.name, '未保存工作');
    await assert.rejects(readVersion(migrated, '../project.cutcut', p.id));
    const file = path.join(migrated, '.cutcut-history', before.id + '.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.project.name = 'tampered';
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(readVersion(migrated, before.id, p.id), /校验失败/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
