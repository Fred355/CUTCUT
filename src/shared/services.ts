import { z } from 'zod';
import {
  providers,
  providerNames,
  legacySettingsSchema,
  type Settings as LegacySettings,
  type ModelChoice,
} from './studio';
export const capabilities = [
  'chat',
  'vision',
  'speech-recognition',
  'image-generation',
  'music-generation',
] as const;
export type Capability = (typeof capabilities)[number];
export const roles = ['planner', 'worker', 'vision', 'speech'] as const;
export type Role = (typeof roles)[number];
export const roleNames = {
  planner: '高级规划',
  worker: '低成本执行',
  vision: '视觉分析',
  speech: '语音识别',
};
export const origins: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  siliconflow: 'https://api.siliconflow.cn/v1',
  requesty: 'https://router.requesty.ai/v1',
  huggingface: 'https://router.huggingface.co/v1',
  cloudflare: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  compatible: 'https://example.com/v1',
};
export function normalizeEndpoint(value: string, kind: 'local' | 'cloud') {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    /[?#]/.test(value) ||
    u.search ||
    u.hash ||
    !['http:', 'https:'].includes(u.protocol)
  )
    throw new Error('地址不能包含凭据、查询参数或片段');
  if (kind === 'local') {
    // Validate the literal host before URL normalization accepts alternate numeric forms.
    const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1] || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority))
      throw new Error('本地服务仅允许 localhost、127.0.0.1 或 ::1');
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  } else {
    if (u.protocol !== 'https:') throw new Error('云端服务必须使用 HTTPS');
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      !host.includes('.') ||
      host.startsWith('[') ||
      /^(127|10|0|169\.254|192\.168)\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
      throw new Error('云端地址不能是本机或局域网地址；本机服务请选择本地类型');
  }
  if (/\/(chat\/completions|messages|generateContent)\/?$/.test(u.pathname))
    throw new Error('请填写 Base URL，不要填写完整请求端点');
  return u.href.replace(/\/$/, '');
}
export const serviceSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['local', 'cloud']),
    provider: z.enum(providers),
    protocol: z.enum(['openai', 'anthropic', 'gemini']),
    baseURL: z.string().max(500),
    auth: z.enum(['none', 'bearer', 'provider']),
    timeoutSeconds: z.number().int().min(5).max(1800),
  })
  .superRefine((s, ctx) => {
    try {
      normalizeEndpoint(s.baseURL, s.kind);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : '地址无效' });
    }
    if (
      s.kind === 'local' &&
      (s.protocol !== 'openai' || s.provider !== 'compatible' || s.auth === 'provider')
    )
      ctx.addIssue({ code: 'custom', message: '本地服务使用 OpenAI 兼容协议，无认证或 Bearer' });
    if (s.kind === 'cloud' && s.auth === 'none')
      ctx.addIssue({ code: 'custom', message: '云端服务需要认证' });
    if (
      s.kind === 'cloud' &&
      ((s.protocol === 'anthropic' && s.provider !== 'anthropic') ||
        (s.protocol === 'gemini' && s.provider !== 'gemini'))
    )
      ctx.addIssue({ code: 'custom', message: '原生协议必须匹配厂商' });
  });
export type Service = z.infer<typeof serviceSchema>;
const binding = z.object({ serviceId: z.string().nullable(), model: z.string().trim().max(150) });
export const serviceSettingsSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    theme: z.enum(['blue', 'lime', 'purple', 'light']),
    services: z.array(serviceSchema).max(100),
    bindings: z.object({ planner: binding, worker: binding, vision: binding, speech: binding }),
    language: z.enum(['auto', 'zh', 'en']),
  })
  .superRefine((s, ctx) => {
    if (new Set(s.services.map((v) => v.id)).size !== s.services.length)
      ctx.addIssue({ code: 'custom', message: '服务 ID 重复' });
    for (const role of roles) {
      const b = s.bindings[role];
      if (b.serviceId && !s.services.some((v) => v.id === b.serviceId))
        ctx.addIssue({ code: 'custom', message: `${roleNames[role]} 引用了不存在的服务` });
    }
    const speech = s.services.find((v) => v.id === s.bindings.speech.serviceId);
    if (speech && (speech.kind !== 'cloud' || !['openai', 'groq'].includes(speech.provider)))
      ctx.addIssue({ code: 'custom', message: '语音适配器仅支持云端 OpenAI/Groq；本地识别未接入' });
  });
export type ServiceSettings = z.infer<typeof serviceSettingsSchema>;
export const defaultServiceSettings: ServiceSettings = {
  version: 2,
  revision: 0,
  theme: 'blue',
  services: [],
  bindings: {
    planner: { serviceId: null, model: '' },
    worker: { serviceId: null, model: '' },
    vision: { serviceId: null, model: '' },
    speech: { serviceId: null, model: '' },
  },
  language: 'auto',
};
export function serviceIdentity(s: Service) {
  return JSON.stringify([
    s.kind,
    s.provider,
    s.protocol,
    normalizeEndpoint(s.baseURL, s.kind),
    s.auth,
  ]);
}
export function cloudService(provider: Service['provider'], id: string = provider): Service {
  return {
    id,
    name: providerNames[provider],
    kind: 'cloud',
    provider,
    protocol: provider === 'anthropic' ? 'anthropic' : provider === 'gemini' ? 'gemini' : 'openai',
    baseURL: origins[provider],
    auth: 'provider',
    timeoutSeconds: 120,
  };
}
export function migrateSettings(raw: unknown, keys: Record<string, string>) {
  const old = legacySettingsSchema.parse(raw),
    settings = structuredClone(defaultServiceSettings),
    newKeys: Record<string, string> = { ...keys };
  settings.theme = old.theme;
  settings.language = old.language;
  const add = (choice: ModelChoice) => {
    const s = cloudService(choice.provider);
    s.baseURL =
      choice.provider === 'compatible'
        ? choice.baseURL || origins.compatible
        : choice.provider === 'cloudflare'
          ? `https://api.cloudflare.com/client/v4/accounts/${choice.accountId || 'ACCOUNT_ID'}/ai/v1`
          : choice.provider === 'bailian' && choice.region === 'intl'
            ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
            : s.baseURL;
    s.baseURL = normalizeEndpoint(s.baseURL, 'cloud');
    const existing = settings.services.find((v) => serviceIdentity(v) === serviceIdentity(s));
    if (existing) return existing.id;
    s.id = settings.services.some((v) => v.id === s.id)
      ? `${s.id}-${settings.services.length}`
      : s.id;
    settings.services.push(s);
    if (keys[choice.provider]) newKeys[s.id] = keys[choice.provider];
    return s.id;
  };
  for (const role of ['planner', 'worker', 'vision'] as const)
    settings.bindings[role] = { serviceId: add(old[role]), model: old[role].model };
  if (old.speech !== 'local')
    settings.bindings.speech = {
      serviceId: add({ provider: old.speech, model: '', vision: false }),
      model: old.speech === 'groq' ? 'whisper-large-v3' : 'whisper-1',
    };
  for (const provider of providers)
    if (
      provider !== 'compatible' &&
      keys[provider] &&
      !settings.services.some((s) => s.provider === provider)
    )
      add({ provider, model: '', vision: false });
  return { settings: serviceSettingsSchema.parse(settings), keys: newKeys };
}
export function resolveChoice(settings: ServiceSettings, role: Role): ModelChoice {
  const b = settings.bindings[role],
    s = settings.services.find((s) => s.id === b.serviceId);
  if (!s)
    throw new Error(
      `${roleNames[role]} 尚未绑定服务${role === 'speech' ? '，本地语音适配器未接入' : ''}`,
    );
  return {
    provider: s.provider,
    model: b.model,
    vision: role === 'vision',
    baseURL: normalizeEndpoint(s.baseURL, s.kind),
    mode: s.kind,
    auth: s.auth,
    protocol: s.protocol,
    timeoutSeconds: s.timeoutSeconds,
    serviceId: s.id,
    serviceName: s.name,
  };
}
export function resolvedSettings(s: ServiceSettings): LegacySettings {
  const absent: ModelChoice = { provider: 'compatible', model: '', vision: false };
  const pick = (r: Role) => (s.bindings[r].serviceId ? resolveChoice(s, r) : { ...absent });
  const speech = s.services.find((v) => v.id === s.bindings.speech.serviceId);
  return {
    version: 1,
    theme: s.theme,
    planner: pick('planner'),
    worker: pick('worker'),
    vision: pick('vision'),
    language: s.language,
    speech:
      speech?.provider === 'groq' ? 'groq' : speech?.provider === 'openai' ? 'openai' : 'local',
    speechService: speech ? resolveChoice(s, 'speech') : undefined,
  };
}
export type RoutePreview = {
  revision: number;
  kind: 'roughcut' | 'transcribe';
  destinations: {
    role: Role;
    serviceId: string;
    name: string;
    kind: 'local' | 'cloud';
    endpoint: string;
    model: string;
    content: string;
  }[];
  requiresCloudConsent: boolean;
};
export function routeFor(
  settings: ServiceSettings,
  kind: RoutePreview['kind'],
  hasVisual: boolean,
): RoutePreview {
  const list: Role[] =
    kind === 'transcribe'
      ? ['speech']
      : hasVisual
        ? ['vision', 'worker', 'planner']
        : ['worker', 'planner'];
  const destinations = list.map((role) => {
    const choice = resolveChoice(settings, role),
      s = settings.services.find((v) => v.id === choice.serviceId)!;
    if (!choice.model) throw new Error(`${roleNames[role]} 缺少模型 ID`);
    return {
      role,
      serviceId: s.id,
      name: s.name,
      kind: s.kind,
      endpoint: choice.baseURL!,
      model: choice.model,
      content:
        role === 'vision'
          ? '代表帧与素材信息'
          : role === 'speech'
            ? '所选素材音轨'
            : '用户要求、素材信息和视觉摘要',
    };
  });
  return {
    revision: settings.revision,
    kind,
    destinations,
    requiresCloudConsent: destinations.some((d) => d.kind === 'cloud'),
  };
}

/** Called in the main process against a freshly resolved route, never a renderer-supplied route. */
export function assertRouteAuthorization(
  route: RoutePreview,
  request: { routeRevision?: number; cloudConsent: boolean },
) {
  if (request.routeRevision !== route.revision)
    throw new Error('服务配置已变化，请重新查看任务去向并确认');
  if (route.requiresCloudConsent && request.cloudConsent !== true)
    throw new Error('云端阶段需要明确允许上传');
}
