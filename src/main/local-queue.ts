let tail: Promise<unknown> = Promise.resolve();
/** Single queue shared by local inference and capability probes. Cancellation never starts a queued request. */
export function localRequest<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const task = tail
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      return fn();
    });
  tail = task.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('操作已取消'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
