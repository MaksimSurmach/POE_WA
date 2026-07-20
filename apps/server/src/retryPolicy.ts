import type { AnyDomainError } from '@poe-worksmith/domain';

type RetryTiming = Readonly<{
  baseDelayMs: number;
  maximumDelayMs: number;
}>;

export type RetryDecision = Readonly<
  { delayMs: 0; retry: false } | { delayMs: number; retry: true }
>;

export interface RetryDecider {
  decide(
    error: AnyDomainError,
    attempt: number,
    maximumAttempts: number,
  ): RetryDecision;
}

export class ProviderRetryPolicy implements RetryDecider {
  readonly #defaultTiming: RetryTiming;
  readonly #random: () => number;
  readonly #timings: Readonly<Record<string, RetryTiming>>;

  constructor(options: {
    baseDelayMs: number;
    maximumDelayMs?: number;
    random?: () => number;
    timings?: Readonly<Record<string, RetryTiming>>;
  }) {
    this.#defaultTiming = {
      baseDelayMs: options.baseDelayMs,
      maximumDelayMs: options.maximumDelayMs ?? 2 * 60 * 1000,
    };
    this.#random = options.random ?? Math.random;
    this.#timings = {
      PROVIDER_CIRCUIT_OPEN: {
        baseDelayMs: 30_000,
        maximumDelayMs: 2 * 60 * 1000,
      },
      PROVIDER_RATE_LIMITED: {
        baseDelayMs: 5000,
        maximumDelayMs: 60_000,
      },
      ...options.timings,
    };
    for (const timing of [
      this.#defaultTiming,
      ...Object.values(this.#timings),
    ]) {
      if (
        !Number.isInteger(timing.baseDelayMs) ||
        timing.baseDelayMs < 1 ||
        !Number.isInteger(timing.maximumDelayMs) ||
        timing.maximumDelayMs < timing.baseDelayMs
      ) {
        throw new TypeError('Retry timing is invalid');
      }
    }
  }

  decide(
    error: AnyDomainError,
    attempt: number,
    maximumAttempts: number,
  ): RetryDecision {
    if (
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      !Number.isInteger(maximumAttempts) ||
      maximumAttempts < 1
    ) {
      throw new TypeError('Retry attempt is invalid');
    }
    if (error.disposition !== 'retryable' || attempt >= maximumAttempts) {
      return { delayMs: 0, retry: false };
    }
    const timing = this.#timings[error.code] ?? this.#defaultTiming;
    const exponential = Math.min(
      timing.maximumDelayMs,
      timing.baseDelayMs * 2 ** Math.min(16, attempt - 1),
    );
    const random = this.#random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new TypeError('Retry random source must return a value in [0, 1]');
    }
    return {
      delayMs: Math.max(1, Math.round(exponential * (0.5 + random / 2))),
      retry: true,
    };
  }
}
