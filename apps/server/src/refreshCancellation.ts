import { DomainError } from '@poe-worksmith/domain';

export function watchRefreshCancellation(
  cancellationRequested: () => Promise<boolean>,
  onCheckError: () => void,
) {
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void cancellationRequested()
      .then((cancelled) => {
        if (cancelled) controller.abort();
      })
      .catch(onCheckError)
      .finally(() => {
        checking = false;
      });
  }, 1000);
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

export function refreshFailureCode(
  error: unknown,
  cancellationSignal: AbortSignal,
  workerSignal?: AbortSignal,
) {
  if (
    cancellationSignal.aborted ||
    (error instanceof DomainError &&
      error.code === 'MARKET_COLLECTION_CANCELLED')
  )
    return 'MARKET_COLLECTION_CANCELLED';
  if (workerSignal?.aborted) return 'REFRESH_WORKER_INTERRUPTED';
  return error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
}
