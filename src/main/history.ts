import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, safeFile } from './store';
import { projectSchema, type Project } from '../shared/model';
export type VersionEntry = { id: string; createdAt: string; label: string; clips: number };
export async function checkpoint(root: string, project: Project, label: string) {
  project = projectSchema.parse(project);
  await fs.mkdir(path.join(root, '.cutcut-history'), { recursive: true });
  const directory = await safeFile(root, '.cutcut-history');
  const id = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const file = path.join(directory, id + '.json');
  try {
    await fs.access(file);
    return;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  await atomicWrite(
    file,
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), label, project }),
  );
}
export async function readVersion(root: string, id: string, projectId: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('版本 ID 无效');
  const file = await safeFile(root, `.cutcut-history/${id}.json`);
  if ((await fs.stat(file)).size > 10000000) throw new Error('历史版本文件过大');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  const project = projectSchema.parse(record.project);
  if (
    record.version !== 1 ||
    project.id !== projectId ||
    createHash('sha256').update(JSON.stringify(project)).digest('hex') !== id
  )
    throw new Error('历史版本校验失败');
  return { project, createdAt: String(record.createdAt), label: String(record.label) };
}
export async function listVersions(root: string, projectId: string): Promise<VersionEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(await safeFile(root, '.cutcut-history'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const result: VersionEntry[] = [];
  for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
    const id = file.slice(0, -5);
    const r = await readVersion(root, id, projectId);
    result.push({
      id,
      createdAt: r.createdAt,
      label: r.label,
      clips: r.project.tracks.reduce((n, t) => n + t.clips.length, 0),
    });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
