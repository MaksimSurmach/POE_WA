import type {
  RateLimitRepository,
  RateLimitState,
  RateLimitWindow,
} from '@poe-worksmith/domain';
import { DomainError } from '@poe-worksmith/domain';

const defaultConservativeDelayMs = 1000;
const defaultConservativeBlockMs = 60_000;
const defaultFallbackPolicy = 'poe-trade';
const defaultSafetyFactor = 1.1;
const maximumWaitMs = 24 * 60 * 60 * 1000;

type HeaderReader = Pick<Headers, 'get'>;

export type RateLimitedResponse = {
  headers: HeaderReader;
  status: number;
};

export class ProviderRateLimitDeferred extends Error {
  constructor(
    readonly retryAt: Date,
    readonly reason:
      | 'PROVIDER_RATE_LIMITED'
      | 'PROVIDER_UNAVAILABLE' = 'PROVIDER_RATE_LIMITED',
  ) {
    super(reason);
  }
}

export interface RateLimitGate {
  clearAuthenticationDenials?(): Promise<void>;
  observeResponse(
    endpoint: string,
    response: RateLimitedResponse,
    options?: RateLimitOptions,
  ): Promise<RateLimitState>;
  waitForPermit(
    endpoint: string,
    signal?: AbortSignal,
    options?: RateLimitOptions & { deferProviderBlock?: boolean },
  ): Promise<RateLimitState>;
}

type RateLimitOptions = {
  collector?: boolean;
  onWait?: (
    reason: 'pacing' | 'restriction',
    until: Date,
  ) => void | Promise<void>;
};

type RateLimitSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export type ParsedRateLimitHeaders = {
  headersComplete: boolean;
  blockedForMs: number;
  minimumDelayMs: number;
  policy: string;
  windows: RateLimitWindow[];
};

export class GggRateLimitController implements RateLimitGate {
  readonly #clock: () => Date;
  readonly #conservativeBlockMs: number;
  readonly #conservativeDelayMs: number;
  readonly #fallbackPolicy: string;
  readonly #missingHeadersDelayMs: number;
  readonly #onObservation:
    | ((
        endpoint: string,
        observed: ParsedRateLimitHeaders,
        state: RateLimitState,
      ) => void)
    | undefined;
  readonly #repository: RateLimitRepository;
  readonly #safetyFactor: number;
  readonly #sleep: RateLimitSleep;

  constructor(options: {
    clock?: () => Date;
    conservativeBlockMs?: number;
    conservativeDelayMs?: number;
    fallbackPolicy?: string;
    missingHeadersDelayMs?: number;
    onObservation?: (
      endpoint: string,
      observed: ParsedRateLimitHeaders,
      state: RateLimitState,
    ) => void;
    repository: RateLimitRepository;
    safetyFactor?: number;
    sleep?: RateLimitSleep;
  }) {
    this.#clock = options.clock ?? (() => new Date());
    this.#conservativeBlockMs =
      options.conservativeBlockMs ?? defaultConservativeBlockMs;
    this.#conservativeDelayMs =
      options.conservativeDelayMs ?? defaultConservativeDelayMs;
    this.#fallbackPolicy = normalizeIdentifier(
      options.fallbackPolicy ?? defaultFallbackPolicy,
      defaultFallbackPolicy,
    );
    this.#repository = options.repository;
    this.#missingHeadersDelayMs =
      options.missingHeadersDelayMs ?? this.#conservativeDelayMs;
    this.#onObservation = options.onObservation;
    this.#safetyFactor = options.safetyFactor ?? defaultSafetyFactor;
    this.#sleep = options.sleep ?? sleepWithSignal;
    if (
      !Number.isInteger(this.#conservativeBlockMs) ||
      this.#conservativeBlockMs < 1 ||
      !Number.isInteger(this.#conservativeDelayMs) ||
      this.#conservativeDelayMs < 1 ||
      !Number.isInteger(this.#missingHeadersDelayMs) ||
      this.#missingHeadersDelayMs < this.#conservativeDelayMs ||
      !Number.isFinite(this.#safetyFactor) ||
      this.#safetyFactor < 1
    ) {
      throw new TypeError('Rate-limit controller options are invalid');
    }
  }

  async clearAuthenticationDenials() {
    await this.#repository.clearAuthenticationDenials?.(this.#clock());
  }

  async waitForPermit(
    endpoint: string,
    signal?: AbortSignal,
    options?: RateLimitOptions & { deferProviderBlock?: boolean },
  ): Promise<RateLimitState> {
    const normalizedEndpoint = normalizeEndpoint(endpoint, options?.collector);
    // Before either endpoint has declared its policy, share a conservative cold-start reservation.
    const fallbackPolicy =
      options?.collector && isTradeCaptureEndpoint(normalizedEndpoint)
        ? this.#fallbackPolicy
        : this.#policyFor(normalizedEndpoint, options?.collector);
    const enforceLegacyDenials =
      !options?.collector &&
      ['trade', 'trade-exchange'].includes(normalizedEndpoint);
    for (;;) {
      throwIfAborted(signal);
      const retainedStates = enforceLegacyDenials
        ? await this.#repository.list()
        : [];
      if (
        retainedStates.some(
          (state) =>
            [401, 403].includes(state.lastStatus ?? 0) &&
            (state.endpoints.some((name) =>
              [
                'trade',
                'trade-search',
                'trade-fetch',
                'trade-exchange',
              ].includes(name),
            ) ||
              [
                'poe-trade',
                'trade-search-request-limit',
                'trade-fetch-request-limit',
                'trade-exchange-request-limit',
              ].includes(state.policy)),
        )
      )
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      const now = this.#clock();
      const legacyBlockedUntil =
        retainedStates
          .find((state) => state.policy === 'poe-trade')
          ?.blockedUntil.getTime() ?? 0;
      if (
        normalizedEndpoint === 'trade-exchange' &&
        legacyBlockedUntil > now.getTime()
      ) {
        await this.#sleep(legacyBlockedUntil - now.getTime(), signal);
        continue;
      }
      const permit = await this.#repository.acquire({
        conservativeDelayMs: this.#missingHeadersDelayMs,
        endpoint: normalizedEndpoint,
        ...(options?.collector && isTradeCaptureEndpoint(normalizedEndpoint)
          ? { tradeCapture: true }
          : {}),
        fallbackPolicy,
        now,
      });
      throwIfAborted(signal);
      if (
        enforceLegacyDenials &&
        (permit.state.lastStatus === 401 || permit.state.lastStatus === 403)
      )
        throw new DomainError('MARKET_ACCESS_BLOCKED');
      if (permit.acquired) return permit.state;
      const blockedUntil = permit.blockedUntil ?? permit.state.blockedUntil;
      if (options?.deferProviderBlock && blockedUntil > now)
        throw new ProviderRateLimitDeferred(
          blockedUntil,
          (permit.state.lastStatus ?? 0) >= 500
            ? 'PROVIDER_UNAVAILABLE'
            : 'PROVIDER_RATE_LIMITED',
        );
      await options?.onWait?.(
        blockedUntil > now ? 'restriction' : 'pacing',
        permit.retryAt,
      );
      await this.#sleep(
        Math.min(
          maximumWaitMs,
          Math.max(1, permit.retryAt.getTime() - this.#clock().getTime()),
        ),
        signal,
      );
    }
  }

  async observeResponse(
    endpoint: string,
    response: RateLimitedResponse,
    options?: RateLimitOptions,
  ) {
    const normalizedEndpoint = normalizeEndpoint(endpoint, options?.collector);
    const fallbackPolicy = this.#policyFor(
      normalizedEndpoint,
      options?.collector,
    );
    const now = this.#clock();
    if (
      !Number.isInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      throw new TypeError('Response status is invalid');
    }
    const parsed = parseRateLimitHeaders(response.headers, {
      conservativeBlockMs: this.#conservativeBlockMs,
      conservativeDelayMs: this.#conservativeDelayMs,
      missingHeadersDelayMs: this.#missingHeadersDelayMs,
      fallbackPolicy,
      now,
      safetyFactor: this.#safetyFactor,
      status: response.status,
    });
    const state = await this.#repository.observe({
      // Collector auth blocks belong to collector_state. Keep shared rate windows.
      ...(options?.collector && [401, 403].includes(response.status)
        ? { suppressAuthenticationDenial: true }
        : {}),
      blockedUntil: new Date(
        now.getTime() +
          Math.max(
            parsed.blockedForMs,
            options?.collector && response.status >= 500 ? 30_000 : 0,
          ),
      ),
      endpoint: normalizeIdentifier(endpoint, normalizedEndpoint),
      fallbackPolicy,
      minimumDelayMs: parsed.minimumDelayMs,
      now,
      policy: parsed.policy,
      status: response.status,
      windows: parsed.headersComplete ? parsed.windows : [],
    });
    if (options?.collector) this.#onObservation?.(endpoint, parsed, state);
    return state;
  }

  #policyFor(endpoint: string, collector?: boolean) {
    if (
      endpoint === 'trade-exchange' ||
      endpoint === 'trade-leagues' ||
      endpoint === 'trade-login'
    )
      return `${endpoint}-request-limit`;
    // A capture uses two independent policies unless GGG identifies a shared policy.
    return collector && isTradeCaptureEndpoint(endpoint)
      ? `${endpoint}-request-limit`
      : this.#fallbackPolicy;
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function sleepWithSignal(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function parseRateLimitHeaders(
  headers: HeaderReader,
  options: {
    conservativeBlockMs?: number;
    conservativeDelayMs?: number;
    fallbackPolicy?: string;
    missingHeadersDelayMs?: number;
    now?: Date;
    safetyFactor?: number;
    status: number;
  },
): ParsedRateLimitHeaders {
  const now = options.now ?? new Date();
  const conservativeBlockMs =
    options.conservativeBlockMs ?? defaultConservativeBlockMs;
  const conservativeDelayMs =
    options.conservativeDelayMs ?? defaultConservativeDelayMs;
  const fallbackPolicy = normalizeIdentifier(
    options.fallbackPolicy ?? defaultFallbackPolicy,
    defaultFallbackPolicy,
  );
  const safetyFactor = options.safetyFactor ?? defaultSafetyFactor;
  const reportedPolicy = normalizeIdentifier(
    headers.get('x-rate-limit-policy') ?? '',
    '',
  );
  const policy = reportedPolicy || fallbackPolicy;
  const ruleHeader = headers.get('x-rate-limit-rules');
  const rules = parseRules(ruleHeader);
  const observed = rules.map((rule) => parseRuleWindows(rule, headers));
  const windows = observed.flatMap(({ windows }) => windows);
  const headersComplete =
    reportedPolicy !== '' &&
    rules.length > 0 &&
    ruleHeader
      ?.split(',')
      .every((rule) => Boolean(normalizeIdentifier(rule, ''))) === true &&
    observed.every(({ complete }) => complete);
  const minimumDelayMs = Math.max(
    conservativeDelayMs,
    headersComplete
      ? 0
      : (options.missingHeadersDelayMs ?? conservativeDelayMs),
    ...observed.flatMap(({ limits }) =>
      limits.map(([maximumHits, periodSeconds]) =>
        Math.min(
          maximumWaitMs,
          Math.ceil((periodSeconds * 1000 * safetyFactor) / maximumHits),
        ),
      ),
    ),
    ...windows.map((window) => {
      const { periodSeconds, maximumHits, currentHits } = window;
      // Without timestamps for other clients' traffic, spread the remaining allowance over the window.
      const remaining =
        currentHits > maximumHits / safetyFactor
          ? (periodSeconds * 1000) / Math.max(1, maximumHits - currentHits)
          : 0;
      return Math.min(maximumWaitMs, Math.ceil(remaining));
    }),
  );
  const activeRestrictionMs = Math.max(
    0,
    ...observed.map(({ restrictionSeconds }) =>
      secondsToMilliseconds(restrictionSeconds),
    ),
  );
  const proactiveRestrictionMs = Math.max(
    0,
    ...windows
      .filter(({ currentHits, maximumHits }) => currentHits >= maximumHits)
      .map(({ periodSeconds }) => secondsToMilliseconds(periodSeconds)),
  );
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'), now);
  const blockedForMs =
    options.status === 429
      ? Math.max(
          activeRestrictionMs,
          proactiveRestrictionMs,
          retryAfterMs || conservativeBlockMs,
        )
      : Math.max(
          activeRestrictionMs,
          proactiveRestrictionMs,
          retryAfterMs ?? 0,
        );

  return { blockedForMs, headersComplete, minimumDelayMs, policy, windows };
}

function parseRules(value: string | null) {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((rule) => normalizeIdentifier(rule, ''))
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function parseRuleWindows(rule: string, headers: HeaderReader) {
  const limitHeader = headers.get(`x-rate-limit-${rule}`);
  const stateHeader = headers.get(`x-rate-limit-${rule}-state`);
  const limits = parseTriplets(limitHeader).filter(
    ([maximumHits, periodSeconds]) => maximumHits > 0 && periodSeconds > 0,
  );
  const states = parseTriplets(stateHeader);
  const restrictionSeconds = Math.max(
    0,
    ...states.map(([, , restriction]) => restriction),
  );
  const windows = limits.flatMap(
    ([maximumHits, periodSeconds, restrictionSeconds]) => {
      const stateIndex = states.findIndex(
        ([, period]) => period === periodSeconds,
      );
      if (stateIndex < 0) return [];
      const [state] = states.splice(stateIndex, 1);
      return [
        {
          activeRestrictionSeconds: state![2],
          currentHits: state![0],
          maximumHits,
          periodSeconds,
          restrictionSeconds,
          rule,
        } satisfies RateLimitWindow,
      ];
    },
  );
  return {
    windows,
    limits,
    restrictionSeconds,
    complete:
      windows.length > 0 &&
      windows.length === limitHeader?.split(',').length &&
      windows.length === stateHeader?.split(',').length,
  };
}

function parseTriplets(value: string | null): [number, number, number][] {
  if (!value) return [];
  return value.split(',').flatMap((entry) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part)))
      return [];
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) {
      return [];
    }
    return [[numbers[0]!, numbers[1]!, numbers[2]!]];
  });
}

export function parseRetryAfter(value: string | null, now: Date) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return secondsToMilliseconds(Number(trimmed));
  }
  // Reject numeric-looking values Date.parse accepts as unrelated calendar dates.
  if (!/^(?:[A-Z][a-z]{2}(?:[a-z]+)?[, ]).*(?:GMT|\d{4})$/.test(trimmed))
    return null;
  const at = Date.parse(trimmed);
  return Number.isFinite(at)
    ? Math.min(maximumWaitMs, Math.max(0, at - now.getTime()))
    : null;
}

function secondsToMilliseconds(seconds: number) {
  return Math.min(seconds * 1000, maximumWaitMs);
}

function isTradeCaptureEndpoint(endpoint: string) {
  return endpoint === 'trade-search' || endpoint === 'trade-fetch';
}

function normalizeEndpoint(value: string, collector?: boolean) {
  const normalized = normalizeIdentifier(value, '');
  if (!normalized) throw new TypeError('Rate-limit endpoint is invalid');
  if (!collector && isTradeCaptureEndpoint(normalized)) return 'trade';
  return normalized;
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,199}$/.test(normalized)
    ? normalized
    : fallback;
}
