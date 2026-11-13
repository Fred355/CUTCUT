import { z } from 'zod';
export const engineIds = ['whisper', 'sd', 'audio'] as const;
export type EngineId = (typeof engineIds)[number];
export const nativeOptions = z.object({
  backend: z.enum(['metal', 'cpu']),
  modelId: z.string().max(100),
});
export const nativeDefaults = {
  whisper: { backend: 'metal' as const, modelId: 'whisper-small' },
  sd: { backend: 'metal' as const, modelId: 'sd15' },
  audio: { backend: 'metal' as const, modelId: 'magenta-small' },
};
export type NativeOptions = z.infer<typeof nativeOptions>;
export type ModelSpec = {
  id: string;
  engine: EngineId;
  name: string;
  repo: string;
  file: string;
  license: string;
  licenseURL: string;
};
export const modelCatalog: ModelSpec[] = [
  {
    id: 'whisper-small',
    engine: 'whisper',
    name: 'Whisper small 多语言',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-small.bin',
    license: 'MIT',
    licenseURL: 'https://github.com/openai/whisper/blob/main/LICENSE',
  },
  {
    id: 'sd15',
    engine: 'sd',
    name: 'Stable Diffusion 1.5',
    repo: 'stable-diffusion-v1-5/stable-diffusion-v1-5',
    file: 'v1-5-pruned-emaonly.safetensors',
    license: 'CreativeML Open RAIL-M',
    licenseURL:
      'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/blob/main/LICENSE',
  },
  {
    id: 'magenta-small',
    engine: 'audio',
    name: 'Magenta RealTime 2 Small Q8_0',
    repo: 'audio-cpp/Magenta-RealTime-2-GGUF',
    file: 'magenta-rt2-small-q8_0.gguf',
    license: 'CC-BY-4.0 + 上游使用条款',
    licenseURL: 'https://github.com/magenta/magenta-realtime',
  },
];
export type ModelLock = {
  id: string;
  revision: string;
  sha256: string;
  bytes: number;
  url: string;
};
export type ModelState = {
  id: string;
  installed: boolean;
  bytes: number;
  downloadBytes?: number;
  sha256?: string;
  status: 'missing' | 'ready' | 'downloading' | 'verifying' | 'error';
  received: number;
  error?: string;
  inUse: boolean;
};
export type EngineState = {
  id: EngineId;
  available: boolean;
  version: string;
  backend: 'metal' | 'cpu';
  model: ModelState;
};
export const generationSchema = z.object({
  projectId: z.string(),
  kind: z.enum(['image', 'music']),
  prompt: z.string().trim().min(1).max(2000),
  size: z.enum(['512x512', '512x768', '768x512']).default('512x512'),
  seconds: z.union([z.literal(10), z.literal(20), z.literal(30)]).default(10),
  seed: z.number().int().min(0).max(2147483647).default(42),
});
export type GenerationRequest = z.input<typeof generationSchema>;
export type GenerationJob = {
  id: string;
  projectId: string;
  kind: 'image' | 'music';
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: string;
  startedAt: number;
  message?: string;
  imported?: boolean;
};
