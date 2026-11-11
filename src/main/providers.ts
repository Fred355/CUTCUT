import { type ModelChoice, providerNames } from '../shared/studio';

export type Fetcher = typeof fetch;
export type ModelResponse = { text: string; inputTokens: number; outputTokens: number };
export type ModelInput = {
  instruction: string;
  text: string;
  images?: { label: string; base64: string }[];
  maxTokens?: number;
};
const origins = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
export async function callModel(
  choice: ModelChoice,
  key: string,
  input: ModelInput,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<ModelResponse> {
  if (!key) throw new Error(`请在软件设置中配置 ${providerNames[choice.provider]} 密钥`);
  if (!choice.model.trim()) throw new Error('请在软件设置中填写模型 ID');
  if (input.images?.length && (choice.provider === 'deepseek' || !choice.vision))
    throw new Error('当前模型未配置视觉能力，请选择支持图片输入的视觉模型');
  const tokenLimit = input.maxTokens || 4096;
  let url = '',
    body: unknown;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (choice.provider === 'anthropic') {
    url = origins.anthropic + '/messages';
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
  } else if (choice.provider === 'gemini') {
    url = `${origins.gemini}/models/${encodeURIComponent(choice.model.replace(/^models\//, ''))}:generateContent`;
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
    url = origins[choice.provider] + '/chat/completions';
    headers.Authorization = `Bearer ${key}`;
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
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
    } catch {
      if (signal.aborted) throw new Error('操作已取消');
      throw new Error(`${providerNames[choice.provider]} 连接失败或超时，请检查网络与模型设置`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
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
        `${providerNames[choice.provider]} 请求失败（HTTP ${response.status}），请检查密钥、模型权限或余额`,
      );
    }
    const data: any = await response.json();
    const text =
      choice.provider === 'anthropic'
        ? data.content
            ?.filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
        : choice.provider === 'gemini'
          ? data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('\n')
          : data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      throw new Error('模型未返回有效文本；请检查模型是否支持当前任务');
    const usage = data.usage || data.usageMetadata || {};
    return {
      text,
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
