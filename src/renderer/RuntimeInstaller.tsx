import { useEffect, useState } from 'react';
import type { EngineId, RuntimeBuildJob, RuntimePrerequisites } from '../shared/native';
export function RuntimeInstaller({
  engine,
  backend,
  onInstalled,
}: {
  engine: EngineId;
  backend: 'cpu' | 'metal';
  onInstalled: () => void;
}) {
  const api = window.cutcut!;
  const [requirements, setRequirements] = useState<RuntimePrerequisites | null>(null),
    [job, setJob] = useState<RuntimeBuildJob | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    setRequirements(null);
    setMessage('');
  }, [backend, engine]);
  useEffect(() => {
    let closed = false,
      last = '';
    const refresh = () =>
      void api
        .runtimeBuildStatus()
        .then((j) => {
          if (closed) return;
          setJob(j);
          setNow(Date.now());
          if (j?.status === 'done' && last !== j.id) {
            last = j.id;
            onInstalled();
          }
        })
        .catch((e) => {
          if (!closed) setMessage(String(e));
        });
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [engine, backend]);
  const active = job?.status === 'running' || job?.status === 'queued',
    own = job?.engine === engine && job.backend === backend;
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="安装运行支持">
      <p>
        首次使用需要编译运行程序。应用会从固定的官方源码版本构建，可能需要数分钟和额外磁盘空间；模型权重会保留。
      </p>
      <div className="model-row">
        <button
          disabled={busy || active}
          onClick={() =>
            void action(async () => setRequirements(await api.runtimePrerequisites(backend)))
          }
        >
          检查编译工具
        </button>
        <button
          className="primary"
          disabled={busy || active}
          onClick={() =>
            void action(async () => {
              const r = await api.runtimePrerequisites(backend);
              setRequirements(r);
              if (!r.ready) {
                setMessage('请先安装下列缺失工具，再点击编译并安装。');
                return;
              }
              setJob(await api.startRuntimeBuild(engine, backend));
            })
          }
        >
          编译并安装运行程序
        </button>
        {active && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api.cancelRuntimeBuild();
                setJob(await api.runtimeBuildStatus());
              })
            }
          >
            取消安装
          </button>
        )}
      </div>
      {requirements && (
        <div>
          <p>系统：{requirements.platform}</p>
          {requirements.tools.map((t) => (
            <p key={t.name}>
              {t.available ? '✓' : '缺少'} {t.name}：{t.detail}
              {!t.available && t.name === 'CMake' && (
                <button
                  onClick={() =>
                    void action(async () => setMessage(await api.installBuildTool('cmake')))
                  }
                >
                  下载 CMake
                </button>
              )}
              {!t.available && t.name === 'Xcode 命令行工具' && (
                <button
                  onClick={() =>
                    void action(async () => setMessage(await api.installBuildTool('xcode')))
                  }
                >
                  安装系统编译工具
                </button>
              )}
            </p>
          ))}
        </div>
      )}
      {job && (own || active) && (
        <div className="notice" role="status">
          <p>
            {job.engine} / {job.backend}：{job.stage}
            {active ? ` · 已用 ${Math.floor((now - job.startedAt) / 1000)} 秒` : ''}
          </p>
          {job.message && <p>{job.message}</p>}
          <details>
            <summary>查看安装日志</summary>
            <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {job.logs.join('\n')}
            </pre>
          </details>
        </div>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
