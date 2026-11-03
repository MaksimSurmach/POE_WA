import { DomainError } from '@poe-worksmith/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshFailureCode,
  watchRefreshCancellation,
} from './refreshCancellation.js';

describe('refresh cancellation', () => {
  it('retries a failed database check without cancelling, then observes a real cancellation', async () => {
    vi.useFakeTimers();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('temporary database connection loss'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onCheckError = vi.fn();
    const cancellation = watchRefreshCancellation(check, onCheckError);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(onCheckError).toHaveBeenCalledOnce();
      expect(cancellation.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cancellation.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cancellation.signal.aborted).toBe(true);
      expect(check).toHaveBeenCalledTimes(3);
      cancellation.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(check).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cancellation.stop();
      vi.useRealTimers();
    }
  });

  it('distinguishes worker interruption, operator cancellation and provider failures', () => {
    const operator = new AbortController();
    const worker = new AbortController();
    const failure = new DomainError('PROVIDER_UNAVAILABLE');
    expect(refreshFailureCode(failure, operator.signal, worker.signal)).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(refreshFailureCode(new Error('unexpected'), operator.signal)).toBe(
      'INTERNAL_ERROR',
    );
    worker.abort();
    expect(refreshFailureCode(failure, operator.signal, worker.signal)).toBe(
      'REFRESH_WORKER_INTERRUPTED',
    );
    operator.abort();
    expect(refreshFailureCode(failure, operator.signal, worker.signal)).toBe(
      'MARKET_COLLECTION_CANCELLED',
    );
    expect(
      refreshFailureCode(
        new DomainError('MARKET_COLLECTION_CANCELLED'),
        new AbortController().signal,
      ),
    ).toBe('MARKET_COLLECTION_CANCELLED');
  });
});
