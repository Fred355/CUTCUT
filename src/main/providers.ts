import { normalizeEndpoint } from '../shared/services';
import { localRequest, blockLocalQueue } from './local-queue';
import { type ModelChoice, providerNames } from '../shared/studio';

export type Fetcher = typeof fetch;
export type ModelResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usageReported?: boolean;
};
export type ModelInput = {
  instruction: string;
  text: string;
  images?: { label: string; base64: string }[];
  maxTokens?: number;
};
const origins = {
  cerebras: 'https://api.cerebras.ai/v1',
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  siliconflow: 'https://api.siliconflow.cn/v1',
  requesty: 'https://router.requesty.ai/v1',
  huggingface: 'https://router.huggingface.co/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
async function performModel(
  choice: ModelChoice,
  key: string,
  input: ModelInput,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<ModelResponse> {
  if (choice.auth !== 'none' && !key)
    throw new Error(
      `请在软件设置中配置 ${choice.serviceName || providerNames[choice.provider]} 密钥`,
    );
  if (!choice.model.trim()) throw new Error('请在软件设置中填写模型 ID');
  if (input.images?.length && (choice.provider === 'deepseek' || !choice.vision))
    throw new Error('当前模型未配置视觉能力，请选择支持图片输入的视觉模型');
  const tokenLimit = input.maxTokens || 4096;
  let url = '',
    body: unknown;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const protocol =
    choice.protocol ||
    (choice.provider === 'anthropic'
      ? 'anthropic'
      : choice.provider === 'gemini'
        ? 'gemini'
        : 'openai');
  const base = choice.mode ? normalizeEndpoint(choice.baseURL!, choice.mode) : undefined;
  if (protocol === 'anthropic') {
    url = (base || origins.anthropic) + '/messages';
    headers = { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = {
      model: choice.model,
      max_tokens: tokenLimit,
      system: input.instruction,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.text },
            ...(input.images || []).flatMap((image) => [
              { type: 'text', text: image.label },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: image.base64 },
              },
            ]),
          ],
        },
      ],
    };
  } else if (protocol === 'gemini') {
    url = `${base || origins.gemini}/models/${encodeURIComponent(choice.model.replace(/^models\//, ''))}:generateContent`;
    headers['x-goog-api-key'] = key;
    body = {
      systemInstruction: { parts: [{ text: input.instruction }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.text },
            ...(input.images || []).flatMap((image) => [
              { text: image.label },
              { inlineData: { mimeType: 'image/jpeg', data: image.base64 } },
            ]),
          ],
        },
      ],
      generationConfig: { maxOutputTokens: tokenLimit },
    };
  } else {
    url =
      (base ||
        (choice.provider === 'compatible'
          ? compatibleURL(choice.baseURL)
          : choice.provider === 'cloudflare'
            ? cloudflareURL(choice.accountId)
            : choice.provider === 'bailian' && choice.region === 'intl'
              ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
              : origins[choice.provider])) + '/chat/completions';
    if (choice.auth !== 'none') headers.Authorization = `Bearer ${key}`;
    body = {
      model: choice.model,
      ...(choice.provider === 'openai'
        ? { max_completion_tokens: tokenLimit }
        : { max_tokens: tokenLimit }),
      messages: [
        { role: 'system', content: input.instruction },
        {
          role: 'user',
          content: input.images?.length
            ? [
                { type: 'text', text: input.text },
                ...input.images.flatMap((image) => [
                  { type: 'text', text: image.label },
                  {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${image.base64}`, detail: 'low' },
                  },
                ]),
              ]
            : input.text,
        },
      ],
    };
  }
  // Bounded retries, sanitized failures: never surface provider bodies containing inputs/keys.
  for (let attempt = 0; attempt < (choice.mode === 'local' ? 1 : 3); attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            (choice.timeoutSeconds || (choice.mode === 'local' ? 300 : 120)) * 1000,
          ),
        ]),
      });
    } catch {
      if (signal.aborted) throw new Error('操作已取消');
      throw new Error(
        `${choice.serviceName || providerNames[choice.provider]} 连接失败或超时，请检查网络与模型设置`,
      );
    }
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < 2 &&
      choice.mode !== 'local'
    ) {
      const delay = Math.min(
        10000,
        Math.max(1000, Number(response.headers.get('retry-after')) * 1000 || (attempt + 1) * 1500),
      );
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
        };
        const aborted = () => {
          done();
          reject(new Error('操作已取消'));
        };
        const timer = setTimeout(() => {
          done();
          resolve();
        }, delay);
        signal.addEventListener('abort', aborted, { once: true });
      });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `${choice.serviceName || providerNames[choice.provider]} 请求失败（HTTP ${response.status}），请检查密钥、模型权限或余额`,
      );
    }
    const data: any = await response.json().catch(() => {
      throw new Error('模型服务返回无效 JSON 或响应读取超时');
    });
    const text =
      protocol === 'anthropic'
        ? data.content
            ?.filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
        : protocol === 'gemini'
          ? data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('\n')
          : data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      throw new Error('模型未返回有效文本；请检查模型是否支持当前任务');
    const usage = data.usage || data.usageMetadata || {};
    return {
      text,
      usageReported:
        [usage.prompt_tokens, usage.input_tokens, usage.promptTokenCount].some(
          (v) => typeof v === 'number',
        ) &&
        [usage.completion_tokens, usage.output_tokens, usage.candidatesTokenCount].some(
          (v) => typeof v === 'number',
        ),
      inputTokens: usage.prompt_tokens || usage.input_tokens || usage.promptTokenCount || 0,
      outputTokens:
        usage.completion_tokens || usage.output_tokens || usage.candidatesTokenCount || 0,
    };
  }
  throw new Error('模型服务暂时不可用');
}
export function parseModelJSON(text: string) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    throw new Error('模型返回的剪辑方案不是有效 JSON，请重新生成');
  }
}

export function compatibleURL(value?: string) {
  let u: URL;
  try {
    u = new URL(value || '');
  } catch {
    throw new Error('请输入兼容 API 的完整 HTTPS Base URL（通常以 /v1 结尾）');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new Error('兼容 API 必须使用不含凭据、查询参数的 HTTPS 地址');
  return u.href.replace(/\/$/, '');
}

export function cloudflareURL(account?: string) {
  if (!account || !/^[a-fA-F0-9]{32}$/.test(account))
    throw new Error('Cloudflare 需要填写 32 位账户 ID');
  return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
}

export function callModel(
  choice: ModelChoice,
  key: string,
  input: ModelInput,
  signal: AbortSignal,
  fetcher: Fetcher = (u, i) => fetch(u, i),
) {
  const call = async () => {
    let requested = false;
    try {
      return await performModel(choice, key, input, signal, async (u, i) => {
        requested = true;
        return fetcher(u, i);
      });
    } finally {
      if (requested && choice.mode === 'local' && choice.releaseOllama) {
        const release = async () => {
          const base = normalizeEndpoint(choice.baseURL!, 'local').replace(/\/v1$/, '');
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (choice.auth !== 'none') headers.Authorization = `Bearer ${key}`;
          const response = await fetcher(base + '/api/generate', {
            method: 'POST',
            redirect: 'error',
            headers,
            body: JSON.stringify({ model: choice.model, prompt: '', keep_alive: 0, stream: false }),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('模型释放接口失败');
          }
          const data: any = await response.json();
          if (data.done !== true || data.done_reason !== 'unload')
            throw new Error('Ollama 未确认模型已释放');
        };
        try {
          await release();
        } catch {
          blockLocalQueue(release);
          throw new Error(
            `${choice.serviceName || 'Ollama'} 模型释放失败，后续本地任务已暂停，请在 AI 设置重试释放`,
          );
        }
      }
    }
  };
  return choice.mode === 'local' ? localRequest(signal, call) : call();
}
