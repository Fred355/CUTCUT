let tail: Promise<unknown> = Promise.resolve();
let pending = 0;
let recovery: (() => Promise<void>) | null = null;
export function localBusy() {
  return pending > 0;
}
export function localBlocked() {
  return !!recovery;
}
export function blockLocalQueue(retry: () => Promise<void>) {
  recovery = retry;
}
export async function retryLocalRelease() {
  if (!recovery) return;
  const fn = recovery;
  await fn();
  if (recovery === fn) recovery = null;
}
/** Running requests settle only after their cleanup; cancelled queued work never starts. */
export function localRequest<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  pending++;
  let started = false;
  const task = tail
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      if (recovery) throw new Error('Ollama 模型释放失败，请在设置中重试释放后继续');
      started = true;
      return fn();
    })
    .finally(() => {
      pending--;
    });
  tail = task.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!started) reject(new Error('操作已取消'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
