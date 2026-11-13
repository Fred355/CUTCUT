import { useEffect, useState } from 'react';
export function NativeStorage() {
  const api = window.cutcut!;
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof api.nativeStorage>> | null>(
      null,
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api
      .nativeStorage()
      .then(setStorage)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div>
      {storage && (
        <>
          <p>
            模型目录：<code>{storage.modelsPath}</code>
          </p>
          <p>模型占用：{(storage.modelsBytes / 1024 / 1024).toFixed(1)} MiB（已完成的模型文件）</p>
          <p>
            生成缓存：<code>{storage.cachePath}</code>
          </p>
          <p>缓存占用：{(storage.cacheBytes / 1024 / 1024).toFixed(1)} MiB</p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await api.clearGenerationCache();
                await refresh();
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            清除未加入工程的生成结果与临时缓存
          </button>
          <p>工程中的素材副本和版本历史会保留。模型删除请到对应功能页操作。</p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
