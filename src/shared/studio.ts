import { nativeOptions } from './native';
import type { ServiceSettings } from './services';
import { z } from 'zod';
import {
  centerClip,
  createClip,
  newProject,
  projectSchema,
  uid,
  type Clip,
  type Project,
} from './model';

export const providers = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'groq',
  'openrouter',
  'zai',
  'siliconflow',
  'requesty',
  'huggingface',
  'cloudflare',
  'cerebras',
  'bailian',
  'compatible',
] as const;
export type Provider = (typeof providers)[number];
export const providerNames: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic / Claude',
  gemini: 'Google / Gemini',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  zai: 'Z.AI',
  siliconflow: 'SiliconFlow',
  requesty: 'Requesty',
  huggingface: 'Hugging Face',
  cloudflare: 'Cloudflare Workers AI',
  cerebras: 'Cerebras',
  bailian: '阿里云百炼',
  compatible: '自定义 OpenAI 兼容 API',
};
export const themes = ['blue', 'lime', 'purple', 'light'] as const;
export const themeNames = { blue: '深海蓝', lime: '荧光绿', purple: '紫色', light: '浅色' };
export const modelChoiceSchema = z.object({
  provider: z.enum(providers),
  model: z.string().trim().max(150),
  vision: z.boolean(),
  serviceId: z.string().optional(),
  serviceName: z.string().optional(),
  releaseOllama: z.boolean().optional(),
  mode: z.enum(['local', 'cloud']).optional(),
  auth: z.enum(['none', 'bearer', 'provider']).optional(),
  protocol: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  timeoutSeconds: z.number().optional(),
  baseURL: z.string().max(500).optional(),
  accountId: z
    .string()
    .regex(/^[a-fA-F0-9]{0,32}$/)
    .optional(),
  region: z.enum(['cn', 'intl']).optional(),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
export const legacySettingsSchema = z.object({
  version: z.literal(1),
  theme: z.enum(themes),
  planner: modelChoiceSchema,
  worker: modelChoiceSchema,
  vision: modelChoiceSchema,
  speech: z.enum(['local', 'openai', 'groq']),
  language: z.enum(['auto', 'zh', 'en']),
  speechService: modelChoiceSchema.optional(),
  nativeSpeech: nativeOptions.optional(),
});
export type Settings = z.infer<typeof legacySettingsSchema>;
export const defaultSettings: Settings = {
  version: 1,
  theme: 'blue',
  planner: { provider: 'openai', model: '', vision: false },
  worker: { provider: 'deepseek', model: '', vision: false },
  vision: { provider: 'gemini', model: '', vision: true },
  speech: 'local',
  language: 'auto',
};
export type SettingsView = {
  settings: ServiceSettings;
  keys: Record<string, boolean>;
  secureStorage: boolean;
};
export type RecentProject = {
  id: string;
  name: string;
  file: string;
  updatedAt: string;
  portrait: boolean;
  assets: { id: string; name: string; kind: 'video' | 'image' | 'audio' }[];
  cover?: string;
  missing?: boolean;
};
export type DashboardData = {
  projects: RecentProject[];
  exportsToday: number;
  assetsCount: number;
  storagePath: string;
};

export const sentenceSchema = z
  .object({
    id: z.string().min(1).max(100),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().max(2000),
  })
  .refine((s) => s.endMs > s.startMs, '语句时间无效');
export const transcriptSchema = z
  .object({
    version: z.literal(1),
    assetId: z.string().max(100),
    fingerprint: z.string().max(200),
    engine: z.string().max(100),
    language: z.string().max(30),
    segments: z.array(sentenceSchema).max(20000),
  })
  .superRefine((t, ctx) => {
    if (new Set(t.segments.map((s) => s.id)).size !== t.segments.length)
      ctx.addIssue({ code: 'custom', message: '文稿包含重复语句 ID' });
    for (let i = 1; i < t.segments.length; i++)
      if (t.segments[i].startMs < t.segments[i - 1].endMs)
        ctx.addIssue({ code: 'custom', message: '语句时间不可重叠' });
  });
export type Transcript = z.infer<typeof transcriptSchema>;
export type Sentence = Transcript['segments'][number];
export function mappedSentences(transcript: Transcript, clip: Clip, fps = 30) {
  return transcript.segments.flatMap((s) => {
    const from = Math.max(clip.in, Math.round((s.startMs * fps) / 1000));
    const to = Math.min(
      clip.in + clip.duration * (clip.speed || 1),
      Math.round((s.endMs * fps) / 1000),
    );
    const start = clip.start + Math.round((from - clip.in) / (clip.speed || 1));
    const duration =
      Math.round((to - clip.in) / (clip.speed || 1)) -
      Math.round((from - clip.in) / (clip.speed || 1));
    return to > from && duration > 0 && s.text.trim() ? [{ ...s, start, duration }] : [];
  });
}
export function sentenceCuts(transcript: Transcript, clip: Clip, fps = 30): number[] {
  return [
    ...new Set(
      transcript.segments
        .slice(1)
        .map(
          (s) => clip.start + Math.round(((s.startMs * fps) / 1000 - clip.in) / (clip.speed || 1)),
        ),
    ),
  ]
    .filter((f) => f > clip.start && f < clip.start + clip.duration)
    .sort((a, b) => a - b);
}
export function splitAtSentences(p: Project, clipId: string, cuts: number[]): Project {
  const track = p.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  const clip = track?.clips.find((c) => c.id === clipId);
  if (!clip || track?.kind !== 'video') throw new Error('请选中一个视频片段');
  if (clip.keyframes?.length || clip.fadeIn || clip.fadeOut || clip.audioFadeOut)
    throw new Error('请先清除关键帧和淡入淡出，再按句切分');
  const points = [
    ...new Set(
      cuts.filter((f) => Number.isInteger(f) && f > clip.start && f < clip.start + clip.duration),
    ),
  ].sort((a, b) => a - b);
  if (!points.length) throw new Error('片段内没有有效的句子切点');
  const bounds = [clip.start, ...points, clip.start + clip.duration];
  return projectSchema.parse({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.flatMap((c) =>
        c.id !== clipId
          ? [c]
          : bounds.slice(0, -1).map((start, i) => ({
              ...c,
              id: i ? uid() : c.id,
              start,
              duration: bounds[i + 1] - start,
              in: c.in + Math.round((start - c.start) * (c.speed || 1)),
            })),
      ),
    })),
  });
}
export function addSubtitles(p: Project, transcript: Transcript, clipIds: string[]): Project {
  const selected = new Set(clipIds);
  const tracks = [...p.tracks];
  for (const source of p.tracks) {
    const clips = source.clips.filter(
      (c) => selected.has(c.id) && c.assetId === transcript.assetId,
    );
    const captions = clips
      .flatMap((c) =>
        mappedSentences(transcript, c, p.fps).map((s) => ({
          ...createClip(p, undefined, s.start),
          duration: s.duration,
          text: s.text,
          x: 70,
          y: p.height - 180,
          fontSize: p.width < p.height ? 48 : 54,
        })),
      )
      .sort((a, b) => a.start - b.start);
    // Keep below the existing 500-clips-per-track project limit.
    for (let offset = 0; offset < captions.length; offset += 500)
      tracks.unshift({
        id: uid(),
        name: '语音字幕',
        kind: 'text',
        muted: false,
        clips: captions.slice(offset, offset + 500),
      });
  }
  if (tracks.length === p.tracks.length) throw new Error('所选片段没有可生成字幕的语句');
  return projectSchema.parse({ ...p, tracks });
}
export function transcriptSRT(p: Project, transcript: Transcript, clipIds: string[]) {
  const selected = new Set(clipIds);
  const rows = p.tracks
    .flatMap((t) => t.clips)
    .filter((c) => selected.has(c.id) && c.assetId === transcript.assetId)
    .flatMap((c) => mappedSentences(transcript, c, p.fps))
    .sort((a, b) => a.start - b.start);
  const stamp = (f: number) => {
    const ms = Math.round((f * 1000) / p.fps);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return rows
    .map(
      (s, i) =>
        `${i + 1}\n${stamp(s.start)} --> ${stamp(s.start + s.duration)}\n${s.text.trim()}\n`,
    )
    .join('\n');
}

export const proposalSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().max(4000),
  clips: z
    .array(
      z.object({
        assetId: z.string().max(100),
        in: z.number().int().nonnegative(),
        duration: z.number().int().positive().max(108000),
        start: z.number().int().nonnegative().max(108000),
        reason: z.string().max(500),
        volume: z.number().min(0).max(2).default(1),
      }),
    )
    .min(1)
    .max(200),
});
export type EditProposal = z.infer<typeof proposalSchema>;
export function compileProposal(
  source: Project,
  proposal: EditProposal,
  portrait: boolean,
  allowedIds: string[],
): Project {
  proposal = proposalSchema.parse(proposal);
  const allowed = new Set(allowedIds),
    result = newProject(proposal.title, portrait);
  const used = new Set(proposal.clips.map((c) => c.assetId));
  if ([...used].some((id) => !allowed.has(id) || !source.assets.some((a) => a.id === id)))
    throw new Error('方案引用了未选择或不存在的素材');
  result.assets = source.assets.filter((a) => used.has(a.id));
  result.tracks = [];
  const visualIntervals: { start: number; end: number }[] = [];
  for (const row of proposal.clips) {
    const asset = result.assets.find((a) => a.id === row.assetId)!;
    if (asset.kind !== 'image' && row.in + row.duration > asset.durationFrames)
      throw new Error('AI 方案超出素材时长');
    if (row.start + row.duration > 108000) throw new Error('初剪最长支持 60 分钟');
    if (asset.kind !== 'audio') {
      if (visualIntervals.some((i) => row.start < i.end && row.start + row.duration > i.start))
        throw new Error('初剪画面片段不可重叠');
      visualIntervals.push({ start: row.start, end: row.start + row.duration });
    }
    let track = result.tracks.find(
      (t) =>
        t.kind === asset.kind &&
        t.clips.every(
          (c) => c.start + c.duration <= row.start || c.start >= row.start + row.duration,
        ),
    );
    if (!track) {
      track = {
        id: uid(),
        name: asset.kind === 'audio' ? '初剪音频' : '初剪画面',
        kind: asset.kind,
        muted: false,
        clips: [],
      };
      result.tracks.push(track);
    }
    let clip = {
      ...createClip(result, asset, row.start),
      in: asset.kind === 'image' ? 0 : row.in,
      duration: row.duration,
      volume: row.volume,
    };
    if (asset.kind !== 'audio') clip = centerClip(result, asset, clip);
    track.clips.push(clip);
  }
  return projectSchema.parse(result);
}
export type AIRequest = {
  project: Project;
  kind: 'transcribe' | 'roughcut';
  assetIds: string[];
  prompt?: string;
  targetSeconds?: number;
  portrait?: boolean;
  cloudConsent: boolean;
  routeRevision?: number;
};
export type AIResult = {
  transcript?: Transcript;
  proposal?: EditProposal;
  coverage?: string[];
  portrait?: boolean;
  assetIds: string[];
};
export type AIJob = {
  id: string;
  projectId: string;
  inputHash: string;
  configurationRevision?: number;
  startedAt?: number;
  indeterminate?: boolean;
  kind: AIRequest['kind'];
  status: 'running' | 'done' | 'cancelled' | 'error';
  stage: string;
  progress: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  usage?: { kind: 'local' | 'cloud'; input: number | null; output: number | null }[];
  message?: string;
  result?: AIResult;
};
export type SpeechStatus = {
  installed: boolean;
  bytes: number;
  runtime: boolean;
  downloading: boolean;
  progress: number;
  error?: string;
  model: string;
  expectedBytes: number;
  path: string;
};
