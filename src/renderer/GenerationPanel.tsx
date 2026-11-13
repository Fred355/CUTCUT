import { useEffect, useState } from 'react';
import type { Asset } from '../shared/model';
import type { GenerationJob } from '../shared/native';
export function GenerationPanel({
  projectId,
  onImport,
  onClose,
}: {
  projectId: string;
  onImport: (a: Asset) => void;
  onClose: () => void;
}) {
  const api = window.cutcut!;
  const [kind, setKind] = useState<'image' | 'music'>('image'),
    [prompt, setPrompt] = useState(''),
    [size, setSize] = useState<'512x512' | '512x768' | '768x512'>('512x512'),
    [seconds, setSeconds] = useState<10 | 20 | 30>(10),
    [job, setJob] = useState<GenerationJob | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      void api
        .generationStatus()
        .then((j) => {
          if (j?.projectId === projectId) setJob(j);
        })
        .catch((e) => setMessage(String(e)));
    }, 700);
    return () => clearInterval(t);
  }, [projectId]);
  const active = job?.status === 'running';
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="settings-card ai-panel" role="dialog" aria-label="生成素材">
        <div className="section-title">
          <h2>生成素材</h2>
          <button onClick={onClose}>关闭面板</button>
        </div>
        <div className="model-row">
          <button disabled={active} onClick={() => setKind('image')}>
            图片
          </button>
          <button disabled={active} onClick={() => setKind('music')}>
            音乐
          </button>
        </div>
        <p>
          使用本机模型生成。请先在软件设置下载对应模型；图片及音乐模型建议使用英文描述。
        </p>
        <label>
          {kind === 'image' ? '描述画面' : '描述音乐风格'}
          <textarea
            aria-label="生成描述"
            disabled={active}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
          />
        </label>
        <div className="model-row">
          {kind === 'image' ? (
            <label>
              尺寸
              <select value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
                <option>512x512</option>
                <option>512x768</option>
                <option>768x512</option>
              </select>
            </label>
          ) : (
            <label>
              时长
              <select
                value={seconds}
                onChange={(e) => setSeconds(+e.target.value as typeof seconds)}
              >
                <option value={10}>10 秒</option>
                <option value={20}>20 秒</option>
                <option value={30}>30 秒</option>
              </select>
            </label>
          )}
          <button
            disabled={active || busy || !prompt.trim()}
            onClick={() =>
              void work(async () => {
                setMessage('');
                setJob(await api.generate({ projectId, kind, prompt, size, seconds }));
              })
            }
          >
            开始生成
          </button>
          {active && (
            <button
              onClick={() =>
                void work(async () => {
                  await api.cancelGeneration();
                })
              }
            >
              取消生成
            </button>
          )}
        </div>
        {job && (
          <div className="notice">
            <p>
              {job.stage}{' '}
              {active ? `· 已用 ${Math.max(0, Math.floor((now - job.startedAt) / 1000))} 秒` : ''}
            </p>
            {job.message && <p role="alert">{job.message}</p>}
            {job.status === 'done' && (
              <>
                {job.kind === 'image' ? (
                  <img
                    className="generated-image"
                    src={api.generationURL(job.id)}
                    alt="生成图片预览"
                  />
                ) : (
                  <audio controls src={api.generationURL(job.id)} />
                )}
                <button
                  disabled={busy || job.imported}
                  onClick={() =>
                    void work(async () => {
                      const asset = await api.importGeneration(job.id, projectId);
                      onImport(asset);
                      setJob({ ...job, imported: true });
                      setMessage('已加入素材库；可手动添加到时间线');
                    })
                  }
                >
                  {job.imported ? '已加入素材库' : '加入素材库'}
                </button>
              </>
            )}
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </section>
    </div>
  );
}
