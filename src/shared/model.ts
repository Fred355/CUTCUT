import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const relative = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes(':') &&
      p.split('/').every((x) => x !== '..' && x !== '.' && x.length > 0),
    '无效的项目相对路径',
  );
const frame = z
  .number()
  .int()
  .min(0)
  .max(30 * 60 * 60 * 24);
export const assetSchema = z.object({
  id,
  name: z.string().max(250),
  kind: z.enum(['video', 'image', 'audio']),
  path: relative,
  preview: relative.optional(),
  thumbnail: relative.optional(),
  durationFrames: frame,
  width: z.number().int().min(0).max(32768),
  height: z.number().int().min(0).max(32768),
  hasAudio: z.boolean(),
  hdr: z.boolean().default(false),
});
export const clipSchema = z.object({
  id,
  assetId: id.optional(),
  start: frame,
  duration: frame.refine((n) => n > 0),
  in: frame,
  x: z.number().finite().min(-8192).max(8192),
  y: z.number().finite().min(-8192).max(8192),
  scale: z.number().min(0.01).max(10),
  opacity: z.number().min(0).max(1),
  volume: z.number().min(0).max(2),
  muted: z.boolean(),
  text: z.string().max(2000).optional(),
  fontSize: z.number().int().min(8).max(400).default(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#ffffff'),
});
export const trackSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  kind: z.enum(['video', 'image', 'text', 'audio']),
  muted: z.boolean(),
  clips: z.array(clipSchema).max(500),
});
export const projectSchema = z
  .object({
    version: z.literal(1),
    id,
    name: z.string().min(1).max(150),
    width: z.union([z.literal(1920), z.literal(1080)]),
    height: z.union([z.literal(1080), z.literal(1920)]),
    fps: z.literal(30),
    assets: z.array(assetSchema).max(1000),
    tracks: z.array(trackSchema).max(50),
  })
  .superRefine((p, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (p.width === p.height) bad('画布必须为横屏或竖屏');
    const ids = [
      p.id,
      ...p.assets.map((a) => a.id),
      ...p.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]),
    ];
    if (new Set(ids).size !== ids.length) bad('工程存在重复 ID');
    for (const t of p.tracks) {
      const sorted = [...t.clips].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        if (i && sorted[i - 1].start + sorted[i - 1].duration > c.start)
          bad('同一轨道的片段不可重叠');
        if (t.kind === 'text') {
          if (c.assetId || c.text === undefined) bad('文字片段数据无效');
          continue;
        }
        const a = p.assets.find((a) => a.id === c.assetId);
        if (!a) {
          bad('片段缺少素材');
          continue;
        }
        if (a.kind !== t.kind) bad('素材与轨道类型不匹配');
        if (a.kind !== 'image' && c.in + c.duration > a.durationFrames) bad('片段超出素材范围');
      }
    }
  });
export type Asset = z.infer<typeof assetSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Project = z.infer<typeof projectSchema>;
export const uid = () => crypto.randomUUID();
export function newProject(name: string, portrait = false): Project {
  return {
    version: 1,
    id: uid(),
    name,
    width: portrait ? 1080 : 1920,
    height: portrait ? 1920 : 1080,
    fps: 30,
    assets: [],
    tracks: [
      { id: uid(), name: '文字 01', kind: 'text', muted: false, clips: [] },
      { id: uid(), name: '视频 01', kind: 'video', muted: false, clips: [] },
      { id: uid(), name: '音乐 01', kind: 'audio', muted: false, clips: [] },
    ],
  };
}
export const endFrame = (p: Project) =>
  Math.max(0, ...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
export const activeAt = (c: Clip, frame: number) =>
  frame >= c.start && frame < c.start + c.duration;
export const sourceFrame = (c: Clip, frame: number) => c.in + frame - c.start;
export function clipRect(p: Project, a: Asset, c: Clip) {
  const fit = Math.min(p.width / a.width, p.height / a.height) * c.scale;
  return { x: c.x, y: c.y, width: a.width * fit, height: a.height * fit };
}
export function createClip(p: Project, a?: Asset, start = 0): Clip {
  return {
    id: uid(),
    ...(a ? { assetId: a.id } : {}),
    start,
    duration: a ? (a.kind === 'image' ? 90 : a.durationFrames) : 90,
    in: 0,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    volume: 1,
    muted: false,
    ...(!a ? { text: '输入文字' } : {}),
    fontSize: 64,
    color: '#ffffff',
  };
}
export function centerClip(p: Project, a: Asset, c: Clip): Clip {
  const r = clipRect(p, a, c);
  return { ...c, x: Math.round((p.width - r.width) / 2), y: Math.round((p.height - r.height) / 2) };
}
export function changeClip(p: Project, id: string, patch: Partial<Clip>): Project {
  return projectSchema.parse({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  });
}
export function splitClip(p: Project, id: string, at: number): Project {
  return projectSchema.parse({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.flatMap((c) => {
        if (c.id !== id) return [c];
        if (at <= c.start || at >= c.start + c.duration) throw new Error('请将播放头放在片段内部');
        const offset = at - c.start;
        const asset = p.assets.find((a) => a.id === c.assetId);
        return [
          { ...c, duration: offset },
          {
            ...c,
            id: uid(),
            start: at,
            duration: c.duration - offset,
            in: t.kind === 'text' || asset?.kind === 'image' ? c.in : c.in + offset,
          },
        ];
      }),
    })),
  });
}
export function moveClip(p: Project, id: string, targetId: string, start: number): Project {
  const from = p.tracks.find((t) => t.clips.some((c) => c.id === id)),
    to = p.tracks.find((t) => t.id === targetId);
  if (!from || !to || from.kind !== to.kind) throw new Error('只能移动到同类型轨道');
  const c = from.clips.find((c) => c.id === id)!;
  return projectSchema.parse({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: [
        ...t.clips.filter((c) => c.id !== id),
        ...(t.id === targetId ? [{ ...c, start }] : []),
      ],
    })),
  });
}
export function errorMessage(error: unknown) {
  return error instanceof z.ZodError
    ? error.issues.map((x) => x.message).join('；')
    : error instanceof Error
      ? error.message
      : String(error);
}
