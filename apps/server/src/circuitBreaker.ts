import {
  type AnyDomainError,
  DomainError,
  type ProviderCircuitRepository,
  type ProviderCircuitState,
} from '@poe-worksmith/domain';

const defaultCooldownMs = 30_000;
const defaultFailureThreshold = 3;
const defaultProbeLeaseMs = 15_000;

export interface ProviderCircuitGate {
  beforeRequest(endpoint: string): Promise<ProviderCircuitState>;
  recordFailure(
    endpoint: string,
    error: AnyDomainError,
  ): Promise<ProviderCircuitState>;
  recordSuccess(endpoint: string): Promise<ProviderCircuitState>;
}

export class ProviderCircuitBreaker implements ProviderCircuitGate {
  readonly #clock: () => Date;
  readonly #cooldowns: Readonly<Record<string, number>>;
  readonly #failureThreshold: number;
  readonly #probeLeaseMs: number;
  readonly #provider: string;
  readonly #repository: ProviderCircuitRepository;

  constructor(options: {
    clock?: () => Date;
    cooldownMs?: number;
    cooldowns?: Readonly<Record<string, number>>;
    failureThreshold?: number;
    probeLeaseMs?: number;
    provider: string;
    repository: ProviderCircuitRepository;
  }) {
    const cooldownMs = options.cooldownMs ?? defaultCooldownMs;
    this.#clock = options.clock ?? (() => new Date());
    this.#cooldowns = {
      PROVIDER_RATE_LIMITED: 60_000,
      PROVIDER_UNAVAILABLE: cooldownMs,
      ...options.cooldowns,
    };
    this.#failureThreshold =
      options.failureThreshold ?? defaultFailureThreshold;
    this.#probeLeaseMs = options.probeLeaseMs ?? defaultProbeLeaseMs;
    this.#provider = normalizeIdentifier(options.provider);
    this.#repository = options.repository;
    if (
      !Number.isInteger(cooldownMs) ||
      cooldownMs < 1 ||
      !Number.isInteger(this.#failureThreshold) ||
      this.#failureThreshold < 1 ||
      !Number.isInteger(this.#probeLeaseMs) ||
      this.#probeLeaseMs < 1 ||
      Object.values(this.#cooldowns).some(
        (value) => !Number.isInteger(value) || value < 1,
      )
    ) {
      throw new TypeError('Circuit breaker options are invalid');
    }
  }

  async beforeRequest(endpoint: string) {
    const normalizedEndpoint = normalizeIdentifier(endpoint);
    const permit = await this.#repository.acquire({
      endpoint: normalizedEndpoint,
      now: this.#clock(),
      probeLeaseMs: this.#probeLeaseMs,
      provider: this.#provider,
    });
    if (!permit.allowed) {
      throw new DomainError('PROVIDER_CIRCUIT_OPEN', {
        cause: permit.retryAt
          ? new Error(`Circuit retry at ${permit.retryAt.toISOString()}`)
          : undefined,
      });
    }
    return permit.state;
  }

  recordFailure(endpoint: string, error: AnyDomainError) {
    const normalizedEndpoint = normalizeIdentifier(endpoint);
    if (error.disposition !== 'retryable') {
      return this.recordSuccess(normalizedEndpoint);
    }
    return this.#repository.recordFailure({
      cooldownMs: this.#cooldowns[error.code] ?? defaultCooldownMs,
      endpoint: normalizedEndpoint,
      errorCode: error.code,
      failureThreshold: this.#failureThreshold,
      now: this.#clock(),
      provider: this.#provider,
    });
  }

  recordSuccess(endpoint: string) {
    return this.#repository.recordSuccess({
      endpoint: normalizeIdentifier(endpoint),
      now: this.#clock(),
      provider: this.#provider,
    });
  }
}

function normalizeIdentifier(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/.test(normalized)) {
    throw new TypeError('Circuit identifier is invalid');
  }
  return normalized;
}
