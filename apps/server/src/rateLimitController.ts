import type {
  RateLimitRepository,
  RateLimitState,
  RateLimitWindow,
} from '@poe-worksmith/domain';

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

export interface RateLimitGate {
  observeResponse(
    endpoint: string,
    response: RateLimitedResponse,
  ): Promise<RateLimitState>;
  waitForPermit(endpoint: string): Promise<RateLimitState>;
}

export type ParsedRateLimitHeaders = {
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
  readonly #repository: RateLimitRepository;
  readonly #safetyFactor: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    clock?: () => Date;
    conservativeBlockMs?: number;
    conservativeDelayMs?: number;
    fallbackPolicy?: string;
    repository: RateLimitRepository;
    safetyFactor?: number;
    sleep?: (milliseconds: number) => Promise<void>;
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
    this.#safetyFactor = options.safetyFactor ?? defaultSafetyFactor;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isInteger(this.#conservativeBlockMs) ||
      this.#conservativeBlockMs < 1 ||
      !Number.isInteger(this.#conservativeDelayMs) ||
      this.#conservativeDelayMs < 1 ||
      !Number.isFinite(this.#safetyFactor) ||
      this.#safetyFactor < 1
    ) {
      throw new TypeError('Rate-limit controller options are invalid');
    }
  }

  async waitForPermit(endpoint: string): Promise<RateLimitState> {
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    for (;;) {
      const now = this.#clock();
      const permit = await this.#repository.acquire({
        conservativeDelayMs: this.#conservativeDelayMs,
        endpoint: normalizedEndpoint,
        fallbackPolicy: this.#fallbackPolicy,
        now,
      });
      if (permit.acquired) return permit.state;
      await this.#sleep(Math.max(1, permit.retryAt.getTime() - now.getTime()));
    }
  }

  observeResponse(endpoint: string, response: RateLimitedResponse) {
    const normalizedEndpoint = normalizeEndpoint(endpoint);
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
      fallbackPolicy: this.#fallbackPolicy,
      now,
      safetyFactor: this.#safetyFactor,
      status: response.status,
    });
    return this.#repository.observe({
      blockedUntil: new Date(now.getTime() + parsed.blockedForMs),
      endpoint: normalizedEndpoint,
      fallbackPolicy: this.#fallbackPolicy,
      minimumDelayMs: parsed.minimumDelayMs,
      now,
      policy: parsed.policy,
      status: response.status,
      windows: parsed.windows,
    });
  }
}

export function parseRateLimitHeaders(
  headers: HeaderReader,
  options: {
    conservativeBlockMs?: number;
    conservativeDelayMs?: number;
    fallbackPolicy?: string;
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
  const policy = normalizeIdentifier(
    headers.get('x-rate-limit-policy') ?? '',
    fallbackPolicy,
  );
  const rules = parseRules(headers.get('x-rate-limit-rules'));
  const windows = rules.flatMap((rule) => parseRuleWindows(rule, headers));
  const minimumDelayMs =
    windows.length === 0
      ? conservativeDelayMs
      : Math.max(
          conservativeDelayMs,
          ...windows.map((window) =>
            Math.min(
              maximumWaitMs,
              Math.ceil(
                (window.periodSeconds * 1000 * safetyFactor) /
                  window.maximumHits,
              ),
            ),
          ),
        );
  const activeRestrictionMs = Math.max(
    0,
    ...windows.map(({ activeRestrictionSeconds }) =>
      secondsToMilliseconds(activeRestrictionSeconds),
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
          retryAfterMs ?? conservativeBlockMs,
        )
      : Math.max(activeRestrictionMs, proactiveRestrictionMs);

  return { blockedForMs, minimumDelayMs, policy, windows };
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
  const limits = parseTriplets(headers.get(`x-rate-limit-${rule}`));
  const states = parseTriplets(headers.get(`x-rate-limit-${rule}-state`));
  return limits.flatMap(([maximumHits, periodSeconds, restrictionSeconds]) => {
    if (maximumHits < 1 || periodSeconds < 1) return [];
    const state = states.find(
      ([, statePeriod]) => statePeriod === periodSeconds,
    );
    return [
      {
        activeRestrictionSeconds: state?.[2] ?? 0,
        currentHits: state?.[0] ?? 0,
        maximumHits,
        periodSeconds,
        restrictionSeconds,
        rule,
      } satisfies RateLimitWindow,
    ];
  });
}

function parseTriplets(value: string | null): [number, number, number][] {
  if (!value) return [];
  return value.split(',').flatMap((entry) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) return [];
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) {
      return [];
    }
    return [[numbers[0]!, numbers[1]!, numbers[2]!]];
  });
}

function parseRetryAfter(value: string | null, now: Date) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return secondsToMilliseconds(Number(trimmed));
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at)
    ? Math.min(maximumWaitMs, Math.max(0, at - now.getTime()))
    : null;
}

function secondsToMilliseconds(seconds: number) {
  return Math.min(seconds * 1000, maximumWaitMs);
}

function normalizeEndpoint(value: string) {
  const normalized = normalizeIdentifier(value, '');
  if (!normalized) throw new TypeError('Rate-limit endpoint is invalid');
  return normalized;
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,199}$/.test(normalized)
    ? normalized
    : fallback;
}
