import { useEffect, useState } from 'react';
import { modelCatalog, type EngineId, type EngineState, type ModelLock } from '../shared/native';
import type { SettingsView } from '../shared/studio';
import { RuntimeNotice } from './RuntimeNotice';
import { RuntimeInstaller } from './RuntimeInstaller';
export function NativeSettings({
  engine,
  view,
  onView,
}: {
  engine: EngineId;
  view: SettingsView;
  onView: (v: SettingsView) => void;
}) {
  const api = window.cutcut!,
    options = view.settings.native[engine],
    spec = modelCatalog.find((m) => m.id === options.modelId)!;
  const [state, setState] = useState<EngineState | null>(null),
    [info, setInfo] = useState<ModelLock | null>(null),
    [accepted, setAccepted] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api
      .nativeStatus()
      .then((s) => setState(s.engines.find((e) => e.id === engine)!))
      .catch((e) => setMessage(String(e)));
  useEffect(() => {
    setState(null);
    setMessage('');
    setInfo(null);
    setAccepted(false);
    void refresh();
    const t = setInterval(() => void refresh(), 1200);
    return () => clearInterval(t);
  }, [engine, options.modelId, options.backend]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const downloading = state?.model.status === 'downloading' || state?.model.status === 'verifying';
  return (
    <section className="settings-card">
      <h2>
        {engine === 'whisper' ? '内置 Whisper' : engine === 'sd' ? '内置 sd.cpp' : '内置 audio.cpp'}
      </h2>
      <RuntimeNotice
        state={state?.id === engine && state.backend === options.backend ? state : null}
      />
      <p>运行程序和模型权重都就绪后才能使用。下方下载仅安装模型权重。</p>
      <RuntimeInstaller
        engine={engine}
        backend={options.backend}
        onInstalled={() => void refresh()}
      />
      <label>
        计算后端{' '}
        <select
          aria-label={`${engine} 计算后端`}
          value={options.backend}
          disabled={busy}
          onChange={(e) =>
            void action(async () =>
              onView(
                await api.updateSettings({
                  ...view.settings,
                  native: {
                    ...view.settings.native,
                    [engine]: { ...options, backend: e.target.value },
                  },
                }),
              ),
            )
          }
        >
          <option value="metal">Metal（Apple Silicon）</option>
          <option value="cpu">CPU（较慢）</option>
        </select>
      </label>
      <h3>{spec.name}</h3>
      <p>
        权重许可证：{spec.license}。
        {engine === 'audio' ? '保留 Google / Magenta 模型署名与上游使用条款。' : ''}
      </p>
      <p className="model-license">{spec.licenseURL}</p>
      <p>
        运行时许可证：{engine === 'audio' ? 'Apache-2.0' : 'MIT'}
        ；编译安装时保存许可证全文及依赖声明。
      </p>
      <p>
        模型权重：
        {state?.model.installed ? '已校验并安装' : downloading ? '处理中' : '未安装或校验无效'} ·
        已安装大小 {((state?.model.bytes || 0) / 1024 / 1024).toFixed(1)} MiB
      </p>
      <button
        disabled={busy || downloading}
        onClick={() =>
          void action(async () => {
            setInfo(await api.modelInfo(spec.id));
          })
        }
      >
        查看下载信息
      </button>
      {info && (
        <div className="notice">
          <p>
            下载大小 {(info.bytes / 1024 / 1024).toFixed(1)} MiB · 固定版本{' '}
            {info.revision.slice(0, 12)}
          </p>
          <p className="model-license">SHA-256：{info.sha256}</p>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            我已阅读模型许可与上游使用条款，允许下载此模型
          </label>
          <button
            disabled={!accepted || busy || downloading}
            onClick={() => void action(() => api.downloadModel(spec.id))}
          >
            下载模型
          </button>
        </div>
      )}
      <div className="model-row">
        <button
          disabled={busy || downloading}
          onClick={() => void action(() => api.importModel(spec.id))}
        >
          导入已有同款模型
        </button>
        <button
          disabled={busy || downloading || !state?.model.bytes || state.model.inUse}
          onClick={() => void action(() => api.deleteModel(spec.id))}
        >
          删除模型
        </button>
        {downloading && (
          <button onClick={() => void action(() => api.cancelModel(spec.id))}>
            取消下载 / 导入
          </button>
        )}
      </div>
      {downloading && (
        <p>
          {state?.model.status === 'verifying'
            ? '正在校验文件'
            : `已读取 ${((state?.model.received || 0) / 1024 / 1024).toFixed(1)} MiB / ${((state?.model.downloadBytes || 0) / 1024 / 1024).toFixed(1)} MiB`}
        </p>
      )}
      {(message || state?.model.error) && <p role="alert">{message || state?.model.error}</p>}
      <p>
        模型仅在使用时加载；取消任务会清理未完成输出。运行时失败不会自动换模型；可选择 CPU 后重试。
      </p>
    </section>
  );
}
