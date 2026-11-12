import { useEffect, useState } from 'react';
import { providers, providerNames, type SettingsView } from '../shared/studio';
import {
  cloudService,
  roles,
  roleNames,
  serviceIdentity,
  type Service,
  type ServiceSettings as Config,
} from '../shared/services';
export function ServiceSettings({
  view,
  onView,
}: {
  view: SettingsView;
  onView: (v: SettingsView) => void;
}) {
  const api = window.cutcut!,
    config = view.settings;
  const [draft, setDraft] = useState<Service | null>(null),
    [secret, setSecret] = useState(''),
    [model, setModel] = useState(''),
    [ids, setIds] = useState<string[]>([]),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tests, setTests] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState(config.bindings);
  useEffect(() => setBindings(config.bindings), [config.bindings]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (next: Config) => {
    const v = await api.updateSettings(next);
    onView(v);
    setBindings(v.settings.bindings);
    return v;
  };
  const saveService = async () => {
    if (!draft) throw new Error('请选择服务');
    const services = config.services.some((s) => s.id === draft.id)
      ? config.services.map((s) => (s.id === draft.id ? draft : s))
      : [...config.services, draft];
    return save({ ...config, services });
  };
  const edit = (s: Service) => {
    setDraft({ ...s });
    setSecret('');
    setIds([]);
    setModel(Object.values(config.bindings).find((b) => b.serviceId === s.id)?.model || '');
    setNotice('');
  };
  const local = (name: string, port: number) =>
    edit({
      id: crypto.randomUUID(),
      name,
      kind: 'local',
      provider: 'compatible',
      protocol: 'openai',
      baseURL: `http://127.0.0.1:${port}/v1`,
      auth: 'none',
      timeoutSeconds: 300,
    });
  const testKey = (cap: string) => {
    try {
      return draft ? `${draft.id}|${serviceIdentity(draft)}|${model}|${cap}` : '';
    } catch {
      return '';
    }
  };
  return (
    <>
      <section className="settings-card">
        <h2>AI 服务列表</h2>
        <p>本地服务由你在外部启动；预设只填写地址，不安装或加载模型。每个服务独立保存凭据。</p>
        <div className="model-row">
          <button onClick={() => local('LM Studio', 1234)}>新增 LM Studio</button>
          <button onClick={() => local('Ollama', 11434)}>新增 Ollama</button>
          <button onClick={() => local('llama-server', 8080)}>新增 llama-server</button>
          <select
            aria-label="新增云端服务"
            value=""
            onChange={(e) =>
              edit(cloudService(e.target.value as Service['provider'], crypto.randomUUID()))
            }
          >
            <option value="">新增云端服务…</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerNames[p]}
              </option>
            ))}
          </select>
        </div>
        {config.services.map((s) => (
          <div className="model-row" key={s.id}>
            <button onClick={() => edit(s)}>
              {s.name} · {s.kind === 'local' ? '本机' : '云端'}
            </button>
            <code>{s.baseURL}</code>
            <span>
              {view.keys[s.id] ? '已配置凭据' : s.auth === 'none' ? '无认证' : '未配置凭据'}
            </span>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await save({ ...config, services: config.services.filter((v) => v.id !== s.id) });
                  if (draft?.id === s.id) setDraft(null);
                })
              }
            >
              删除 {s.name}
            </button>
          </div>
        ))}
        {!config.services.length && <p>尚无服务。添加本机预设，或配置云端服务。</p>}
        {draft && (
          <div className="service-form">
            <h3>编辑服务</h3>
            <div className="model-row">
              <label>
                名称{' '}
                <input
                  aria-label="服务名称"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <span>
                {draft.kind === 'local'
                  ? '本机 · OpenAI 兼容'
                  : '云端 · ' + providerNames[draft.provider]}
              </span>
            </div>
            <label>
              Base URL{' '}
              <input
                style={{ width: '100%' }}
                aria-label="服务 Base URL"
                value={draft.baseURL}
                onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
              />
            </label>
            <p>
              {draft.provider === 'cloudflare'
                ? '请将地址中的 ACCOUNT_ID 替换成自己的账户 ID。'
                : draft.provider === 'bailian'
                  ? '国际（新加坡）地址：https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
                  : '填写基础路径（例如 /v1），不要填写 /chat/completions。'}
            </p>
            <div className="model-row">
              <label>
                协议{' '}
                <select
                  aria-label="服务协议"
                  disabled={draft.kind === 'local'}
                  value={draft.protocol}
                  onChange={(e) =>
                    setDraft({ ...draft, protocol: e.target.value as Service['protocol'] })
                  }
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic 原生</option>
                  <option value="gemini">Gemini 原生</option>
                </select>
              </label>
              <label>
                认证{' '}
                <select
                  aria-label="服务认证"
                  value={draft.auth}
                  onChange={(e) => setDraft({ ...draft, auth: e.target.value as Service['auth'] })}
                >
                  {draft.kind === 'local' ? (
                    <>
                      <option value="none">无认证</option>
                      <option value="bearer">Bearer Token</option>
                    </>
                  ) : (
                    <option value="provider">厂商认证</option>
                  )}
                </select>
              </label>
              <label>
                超时（秒）{' '}
                <input
                  aria-label="服务超时秒数"
                  type="number"
                  min={5}
                  max={1800}
                  value={draft.timeoutSeconds}
                  onChange={(e) => setDraft({ ...draft, timeoutSeconds: +e.target.value })}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await saveService();
                    setNotice('服务已保存。修改端点或认证会清除旧凭据。');
                  })
                }
              >
                保存服务
              </button>
            </div>
            {draft.auth !== 'none' && (
              <div className="model-row">
                <input
                  aria-label="服务密钥"
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="先保存服务，再保存密钥"
                />
                <button
                  disabled={busy || !secret || !config.services.some((s) => s.id === draft.id)}
                  onClick={() =>
                    void perform(async () => {
                      await saveService();
                      onView(await api.setKey(draft.id, secret));
                      setSecret('');
                      setNotice('凭据已保存');
                    })
                  }
                >
                  保存服务密钥
                </button>
                <button
                  disabled={busy}
                  onClick={() => void perform(async () => onView(await api.setKey(draft.id, '')))}
                >
                  清除服务密钥
                </button>
              </div>
            )}
            <h3>连接与能力测试</h3>
            <p>
              测试使用固定文字或内置测试图片；文本成功不代表视觉可用，列表也不代表模型能力。测试会发送请求。
            </p>
            <div className="model-row">
              <input
                aria-label="测试模型 ID"
                placeholder="手动输入模型 ID"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await saveService();
                    setIds(await api.serviceModels(draft.id));
                    setNotice('模型列表已读取；能力需单独测试。');
                  })
                }
              >
                读取模型列表
              </button>
              {ids.length > 0 && (
                <select
                  aria-label="读取到的模型"
                  value=""
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">选择模型…</option>
                  {ids.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              )}
              {(['text', 'vision'] as const).map((cap) => (
                <button
                  key={cap}
                  disabled={busy || !model.trim()}
                  onClick={() =>
                    void perform(async () => {
                      await saveService();
                      try {
                        const r = await api.serviceProbe(draft.id, model, cap);
                        setTests((prev) => ({ ...prev, [testKey(cap)]: r.message }));
                        setNotice(r.message);
                      } catch (e) {
                        setTests((prev) => ({ ...prev, [testKey(cap)]: String(e) }));
                        throw e;
                      }
                    })
                  }
                >
                  {cap === 'text' ? '测试文本' : '测试视觉'}
                </button>
              ))}
              {busy && <button onClick={() => void api.cancelProbe()}>取消测试</button>}
            </div>
            <p>
              文本：{tests[testKey('text')] || '未测试'}　视觉：
              {tests[testKey('vision')] || '未测试'}
            </p>
          </div>
        )}
        <p>
          {view.secureStorage
            ? '凭据由系统保护机制加密保存。'
            : '当前环境不能安全持久保存凭据，仅在本次运行中使用。'}
        </p>
        {notice && <p role="alert">{notice}</p>}
      </section>
      <section className="settings-card">
        <h2>任务绑定</h2>
        <p>逐任务选择服务，失败不会自动切换。本机推理请求串行执行，不管理外部服务进程。</p>
        {roles.map((role) => (
          <div className="model-row" key={role}>
            <label>{roleNames[role]}</label>
            <select
              aria-label={`${role} 服务`}
              value={bindings[role].serviceId || ''}
              onChange={(e) =>
                setBindings({
                  ...bindings,
                  [role]: { ...bindings[role], serviceId: e.target.value || null },
                })
              }
            >
              <option value="">
                {role === 'speech' ? '未绑定（本地适配器未接入）' : '未绑定'}
              </option>
              {config.services
                .filter(
                  (s) =>
                    role !== 'speech' ||
                    (s.kind === 'cloud' && ['openai', 'groq'].includes(s.provider)),
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.kind === 'local' ? '本机' : '云端'}
                  </option>
                ))}
            </select>
            <input
              aria-label={`${role} 模型 ID`}
              value={bindings[role].model}
              placeholder={role === 'speech' ? 'whisper-1 或 whisper-large-v3' : '模型 ID'}
              onChange={(e) =>
                setBindings({ ...bindings, [role]: { ...bindings[role], model: e.target.value } })
              }
            />
          </div>
        ))}
        <label>
          识别语言{' '}
          <select
            aria-label="识别语言"
            value={config.language}
            onChange={(e) =>
              void perform(async () => {
                await save({ ...config, language: e.target.value as Config['language'] });
              })
            }
          >
            <option value="auto">自动</option>
            <option value="zh">中文</option>
            <option value="en">英语</option>
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await save({ ...config, bindings });
              setNotice('任务绑定已保存');
            })
          }
        >
          保存任务绑定
        </button>
        <p>本地语音识别、图像生成（sd.cpp）、音乐生成（audio.cpp）：适配器未接入，不能启动。</p>
      </section>
    </>
  );
}
