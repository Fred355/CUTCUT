import type { EngineState } from '../shared/native';

export function RuntimeNotice({ state }: { state: EngineState | null }) {
  if (!state) return <p role="status">正在检查运行程序…</p>;
  return (
    <div className="notice" aria-label="运行程序状态">
      <p>
        运行程序：{state.available ? '已找到' : '缺失或不可用'} · {state.id} / {state.backend}
      </p>
      {!state.available && (
        <>
          <p>{state.runtimeIssue}</p>
          <p>{state.setupHint}</p>
        </>
      )}
      <details>
        <summary>查看运行程序位置</summary>
        <code>{state.runtimePath}</code>
      </details>
    </div>
  );
}
