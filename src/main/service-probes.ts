import { createCanvas } from '@napi-rs/canvas';
import {
  normalizeEndpoint,
  resolveChoice,
  type ServiceSettings,
  type Service,
} from '../shared/services';
import { callModel, type Fetcher } from './providers';
import { localRequest } from './local-queue';
export async function listModels(
  service: Service,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = (u, i) => fetch(u, i),
) {
  const call = async () => {
    const headers: Record<string, string> = {};
    if (service.auth !== 'none') {
      if (!key) throw new Error('该服务尚未配置密钥');
      if (service.protocol === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (service.protocol === 'gemini') headers['x-goog-api-key'] = key;
      else headers.Authorization = `Bearer ${key}`;
    }
    const response = await fetcher(normalizeEndpoint(service.baseURL, service.kind) + '/models', {
      headers,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(service.timeoutSeconds * 1000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`模型列表不可用（HTTP ${response.status}），可手动填写模型 ID`);
    }
    const data: any = await response.json().catch(() => {
      throw new Error('模型列表响应无效或读取超时，可手动填写模型 ID');
    });
    const rows = service.protocol === 'gemini' ? data.models : data.data;
    if (!Array.isArray(rows)) throw new Error('模型列表格式不支持，可手动填写模型 ID');
    return rows
      .map((v: any) => (service.protocol === 'gemini' ? v.name?.replace(/^models\//, '') : v.id))
      .filter((id: unknown) => typeof id === 'string' && id.length > 0 && id.length < 200)
      .slice(0, 1000) as string[];
  };
  return service.kind === 'local' ? localRequest(signal, call) : call();
}
export async function probeService(
  settings: ServiceSettings,
  id: string,
  model: string,
  capability: 'text' | 'vision',
  key: string,
  signal: AbortSignal,
) {
  const s = settings.services.find((v) => v.id === id);
  if (!s) throw new Error('服务不存在');
  const choice = resolveChoice(
    {
      ...settings,
      bindings: {
        ...settings.bindings,
        vision: { serviceId: id, model },
        planner: { serviceId: id, model },
      },
    },
    capability === 'vision' ? 'vision' : 'planner',
  );
  let images;
  if (capability === 'vision') {
    const canvas = createCanvas(32, 32),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2040ff';
    ctx.fillRect(0, 0, 32, 32);
    images = [
      {
        label: 'CUTCUT bundled test pattern: blue square',
        base64: (await canvas.encode('jpeg')).toString('base64'),
      },
    ];
  }
  const result = await callModel(
    choice,
    key,
    {
      instruction: 'Return a short plain-text response.',
      text: capability === 'vision' ? 'What color is this test image?' : 'Reply with OK.',
      images,
      maxTokens: 256,
    },
    signal,
  );
  return {
    capability,
    revision: settings.revision,
    model,
    serviceId: id,
    message: capability === 'vision' ? '视觉接口已响应（不保证识别质量）' : '文本接口已响应',
    inputTokens: result.usageReported ? result.inputTokens : null,
    outputTokens: result.usageReported ? result.outputTokens : null,
  };
}
