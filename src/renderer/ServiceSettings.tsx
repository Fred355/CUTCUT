import { useEffect, useState } from 'react';
import { providers, providerNames, type SettingsView } from '../shared/studio';
import { cloudService, roleNames, type Service, type Role } from '../shared/services';
function preset(name: string, port: number): Service {
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'local',
    provider: 'compatible',
    protocol: 'openai',
    baseURL: `http://127.0.0.1:${port}/v1`,
    auth: 'none',
    timeoutSeconds: 300,
    runtime: name === 'Ollama' ? 'ollama' : 'generic',
  };
}
export function ServiceSettings({
  view,
  onView,
  section = 'ai',
}: {
  view: SettingsView;
  onView: (v: SettingsView) => void;
  section?: 'ai' | 'speech';
}) {
  const config = view.settings;
  if (section === 'speech') return <FeatureForm role="speech" view={view} onView={onView} />;
  return (
    <>
      <FeatureForm role="planner" view={view} onView={onView} />
      <FeatureForm role="vision" view={view} onView={onView} />
      <section className="settings-card">
        <p>
          视觉候选：Qwen3-VL 4B-Instruct（4-bit）；内存较紧可选 2B。8B 仅建议单独测试。请选择 Ollama
          实际提供的模型标签，文字测试不代表视觉可用。
        </p>
      </section>
      <details className="settings-card">
        <summary>高级分工与内存管理</summary>
        <p>低成本执行可选择你已安装的 Bonsai 27B。它负责文字整理，不会自动用于图片分析。</p>
        <FeatureForm role="worker" view={view} onView={onView} />
        <label>
          <input
            type="checkbox"
            checked={config.releaseOllama}
            onChange={async (e) => {
              try {
                onView(
                  await window.cutcut!.updateSettings({
                    ...config,
                    releaseOllama: e.target.checked,
                  }),
                );
              } catch (err) {
                alert(String(err));
              }
            }}
          />
          任务结束后释放本次使用的 Ollama 模型（不删除文件，不关闭 Ollama）
        </label>
        <p>同一模型被其他应用使用时，释放会使它们在下次请求时重新加载。内置本地任务串行执行。</p>
        <button
          onClick={async () => {
            try {
              await window.cutcut!.retryLocalRelease();
              alert('已完成释放检查');
            } catch (e) {
              alert('释放失败：' + String(e));
            }
          }}
        >
          重试释放 Ollama 模型
        </button>
      </details>
    </>
  );
}
function FeatureForm({
  role,
  view,
  onView,
}: {
  role: Role;
  view: SettingsView;
  onView: (v: SettingsView) => void;
}) {
  const api = window.cutcut!,
    config = view.settings,
    binding = config.bindings[role];
  const current = config.services.find((s) => s.id === binding.serviceId);
  const [draft, setDraft] = useState<Service>(() =>
    current
      ? { ...current }
      : role === 'speech'
        ? cloudService('openai', crypto.randomUUID())
        : preset('Ollama', 11434),
  );
  const [model, setModel] = useState(binding.model),
    [secret, setSecret] = useState(''),
    [ids, setIds] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (current) setDraft({ ...current });
    setModel(binding.model);
  }, [current, binding.model]);
  const save = async (test: boolean) => {
    const result = await api.configureFeature(
      { revision: config.revision, role, service: draft, model, secret: secret || undefined },
      test,
    );
    onView(result.view);
    setSecret('');
    setMessage(result.message);
    return result.view;
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const choices = config.services.filter(
    (s) => s.kind === draft.kind && (role !== 'speech' || ['openai', 'groq'].includes(s.provider)),
  );
  const title = {
    planner: '剪辑规划',
    vision: '画面理解',
    worker: '低成本执行',
    speech: '云端语音识别',
  }[role];
  return (
    <section className="settings-card feature-form" aria-label={title}>
      <h2>{title}</h2>
      <div className="model-row">
        {role !== 'speech' && (
          <label>
            运行位置
            <select
              aria-label={`${role} 运行位置`}
              value={draft.kind}
              disabled={busy}
              onChange={(e) => {
                setDraft(
                  e.target.value === 'local'
                    ? preset('Ollama', 11434)
                    : cloudService('openai', crypto.randomUUID()),
                );
                setModel('');
                setIds([]);
                setSecret('');
                setMessage('');
              }}
            >
              <option value="local">本地</option>
              <option value="cloud">云端</option>
            </select>
          </label>
        )}
        <label>
          平台 / 账户
          <select
            aria-label={`${role} 平台`}
            disabled={busy}
            value={
              choices.some((s) => s.id === draft.id)
                ? draft.id
                : draft.kind === 'local'
                  ? ['Ollama', 'LM Studio', 'llama-server'].includes(draft.name)
                    ? `local:${draft.name}`
                    : 'local:custom'
                  : `new:${draft.provider}`
            }
            onChange={(e) => {
              const existing = config.services.find((s) => s.id === e.target.value);
              const value = e.target.value;
              setDraft(
                existing
                  ? { ...existing }
                  : value === 'local:Ollama'
                    ? preset('Ollama', 11434)
                    : value === 'local:LM Studio'
                      ? preset('LM Studio', 1234)
                      : value === 'local:llama-server'
                        ? preset('llama-server', 8080)
                        : cloudService(value.slice(4) as Service['provider'], crypto.randomUUID()),
              );
              setModel(
                role === 'speech'
                  ? value.endsWith('groq')
                    ? 'whisper-large-v3'
                    : 'whisper-1'
                  : '',
              );
              setIds([]);
              setSecret('');
              setMessage('');
            }}
          >
            {draft.kind === 'local' &&
              !choices.some((s) => s.id === draft.id) &&
              !['Ollama', 'LM Studio', 'llama-server'].includes(draft.name) && (
                <option value="local:custom">{draft.name}</option>
              )}
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（已配置）
              </option>
            ))}
            {draft.kind === 'local'
              ? ['Ollama', 'LM Studio', 'llama-server'].map((n) => (
                  <option key={n} value={`local:${n}`}>
                    {n}
                  </option>
                ))
              : providers
                  .filter((p) => role !== 'speech' || p === 'openai' || p === 'groq')
                  .map((p) => (
                    <option key={p} value={`new:${p}`}>
                      {providerNames[p]} · 新账户
                    </option>
                  ))}
          </select>
        </label>
        {draft.auth !== 'none' && (
          <label>
            API 密钥
            <input
              aria-label={`${role} API 密钥`}
              type="password"
              autoComplete="off"
              disabled={busy}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={view.keys[draft.id] ? '已保存，留空沿用' : '填写此账户的密钥'}
            />
          </label>
        )}
      </div>
      <div className="model-row">
        <label>
          模型
          <input
            aria-label={`${role} 模型`}
            value={model}
            disabled={busy}
            placeholder={
              role === 'speech' ? 'whisper-1 / whisper-large-v3' : '选择或填写实际模型 ID'
            }
            onChange={(e) => {
              setModel(e.target.value);
              setMessage('');
            }}
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const v = await save(false),
                id = v.settings.bindings[role].serviceId!;
              setIds(await api.serviceModels(id));
              setMessage('模型列表已读取；请选择模型再保存并测试。');
            })
          }
        >
          读取模型
        </button>
        {ids.length > 0 && (
          <select
            aria-label={`${role} 可用模型`}
            value=""
            onChange={(e) => {
              setModel(e.target.value);
              setMessage('');
            }}
          >
            <option value="">选择已安装/可用模型</option>
            {ids.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        )}
      </div>
      <details>
        <summary>高级设置</summary>
        <div className="model-row">
          <label>
            账户名称
            <input
              aria-label={`${role} 账户名称`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              aria-label={`${role} Base URL`}
              value={draft.baseURL}
              onChange={(e) => {
                setDraft({ ...draft, baseURL: e.target.value });
                setMessage('');
                setSecret('');
              }}
            />
          </label>
          <label>
            超时（秒）
            <input
              type="number"
              min={5}
              max={1800}
              value={draft.timeoutSeconds}
              onChange={(e) => setDraft({ ...draft, timeoutSeconds: +e.target.value })}
            />
          </label>
          {draft.kind === 'local' && (
            <label>
              本地服务类型
              <select
                aria-label={`${role} 本地服务类型`}
                value={draft.runtime || 'generic'}
                onChange={(e) =>
                  setDraft({ ...draft, runtime: e.target.value as 'ollama' | 'generic' })
                }
              >
                <option value="generic">通用兼容服务</option>
                <option value="ollama">Ollama（支持指定模型释放）</option>
              </select>
            </label>
          )}
          {draft.kind === 'local' && (
            <label>
              认证
              <select
                value={draft.auth}
                onChange={(e) => setDraft({ ...draft, auth: e.target.value as Service['auth'] })}
              >
                <option value="none">无认证</option>
                <option value="bearer">Bearer Token</option>
              </select>
            </label>
          )}
        </div>
        <p>
          地址或认证改变后需要重新填写密钥；共享连接修改端点会为此功能建立独立连接。云端协议按平台自动选择。
        </p>
      </details>
      <div className="model-row">
        <button
          className="primary"
          disabled={busy || !model.trim()}
          onClick={() =>
            void perform(async () => {
              await save(true);
            })
          }
        >
          {busy ? '正在处理…' : '保存并测试'}
        </button>
        {busy && <button onClick={() => void api.cancelProbe()}>取消测试</button>}
      </div>
      <p>
        {role === 'vision'
          ? '测试仅发送内置蓝色图片，不发送工程素材。'
          : role === 'speech'
            ? '此处检查认证和模型列表；带时间码的识别请在工程中测试。'
            : '测试仅发送固定短文本，不发送工程素材。'}
        云端测试可能计费；本地默认地址无需密钥。
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
