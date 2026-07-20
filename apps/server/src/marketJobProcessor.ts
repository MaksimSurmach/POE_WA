import {
  aggregateMarketListings,
  canonicalizeMarketQuery,
  type CanonicalJsonObject,
  DomainError,
  type Job,
  type MarketSearchProvider,
  type MarketSearchResult,
  type NewAggregatedObservation,
  type NewRawSnapshot,
  type Repositories,
} from '@poe-worksmith/domain';
import { z } from 'zod';

import { ProviderRetryPolicy, type RetryDecider } from './retryPolicy.js';

const payloadSchema = z.strictObject({
  canonicalHash: z.string().min(1),
  leagueGggId: z.string().trim().min(1),
  leagueId: z.string().uuid(),
  leagueName: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  recipeIds: z.array(z.string().min(1)).min(1),
  schemaVersion: z.number().int().min(1),
});

export type PreparedMarketJob = Readonly<{
  job: Job;
  observation: NewAggregatedObservation;
  snapshot: NewRawSnapshot;
}>;

export type MarketJobRunReport = Readonly<{
  claimed: number;
  failed: number;
  recovered: number;
  retried: number;
  succeeded: number;
}>;

export class MarketJobProcessor {
  readonly #clock: () => Date;
  readonly #concurrency: number;
  readonly #leaseTimeoutMs: number;
  readonly #providers: ReadonlyMap<string, MarketSearchProvider>;
  readonly #repositories: Repositories;
  readonly #retryPolicy: RetryDecider;
  readonly #snapshotTtlMs: number;

  constructor(options: {
    clock?: () => Date;
    concurrency: number;
    leaseTimeoutMs: number;
    providers: readonly MarketSearchProvider[];
    repositories: Repositories;
    retryDelayMs: number;
    retryPolicy?: RetryDecider;
    snapshotTtlMs: number;
  }) {
    assertPositiveInteger('concurrency', options.concurrency);
    assertPositiveInteger('leaseTimeoutMs', options.leaseTimeoutMs);
    assertPositiveInteger('retryDelayMs', options.retryDelayMs);
    assertPositiveInteger('snapshotTtlMs', options.snapshotTtlMs);
    const providers = new Map(
      options.providers.map((provider) => [provider.id, provider] as const),
    );
    if (providers.size !== options.providers.length) {
      throw new TypeError('Provider ids must be unique');
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#concurrency = options.concurrency;
    this.#leaseTimeoutMs = options.leaseTimeoutMs;
    this.#providers = providers;
    this.#repositories = options.repositories;
    this.#retryPolicy =
      options.retryPolicy ??
      new ProviderRetryPolicy({ baseDelayMs: options.retryDelayMs });
    this.#snapshotTtlMs = options.snapshotTtlMs;
  }

  async prepare(job: Job): Promise<PreparedMarketJob> {
    if (
      job.kind !== 'recipe_refresh' ||
      !job.marketQueryId ||
      !job.refreshCycleId
    ) {
      throw new DomainError('JOB_PAYLOAD_INVALID');
    }
    const payload = parsePayload(job.payload);
    const marketQuery =
      await this.#repositories.marketQueries.findByCanonicalHash(
        payload.canonicalHash,
      );
    if (!marketQuery || marketQuery.id !== job.marketQueryId) {
      throw new DomainError('MARKET_QUERY_INVALID');
    }
    const cycle = await this.#repositories.cycles.findById(job.refreshCycleId);
    if (!cycle) throw new DomainError('PERSISTENCE_NOT_FOUND');
    if (cycle.leagueId !== payload.leagueId) {
      throw new DomainError('JOB_PAYLOAD_INVALID');
    }
    const provider = this.#providers.get(payload.provider);
    if (!provider || marketQuery.provider !== provider.id) {
      throw new DomainError('MARKET_QUERY_INVALID');
    }
    const result = await provider.search({
      league: payload.leagueGggId,
      query: canonicalizeMarketQuery(marketQuery.query as CanonicalJsonObject),
      schemaVersion: payload.schemaVersion,
    });
    if (
      result.provider !== provider.id ||
      !Number.isFinite(result.fetchedAt.getTime())
    ) {
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    }

    return prepareResult(
      job,
      payload.canonicalHash,
      result,
      payload.leagueId,
      this.#snapshotTtlMs,
    );
  }

  commit(prepared: PreparedMarketJob) {
    return this.#repositories.marketResults.commitSuccess({
      completedAt: this.#clock(),
      jobId: prepared.job.id,
      observation: prepared.observation,
      snapshot: prepared.snapshot,
    });
  }

  async runAvailable(
    workerId: string,
    now: Date = this.#clock(),
  ): Promise<MarketJobRunReport> {
    if (workerId.trim().length === 0 || !Number.isFinite(now.getTime())) {
      throw new TypeError('workerId and now must be valid');
    }
    const recovered = await this.#repositories.jobs.recoverStale(
      new Date(now.getTime() - this.#leaseTimeoutMs),
      now,
      now,
    );
    const report = {
      claimed: 0,
      failed: 0,
      recovered,
      retried: 0,
      succeeded: 0,
    };

    await Promise.all(
      Array.from({ length: this.#concurrency }, async () => {
        for (;;) {
          const job = await this.#repositories.jobs.claimNext(workerId, now, [
            'recipe_refresh',
          ]);
          if (!job) return;
          report.claimed += 1;
          const outcome = await this.#processClaimed(job);
          report[outcome] += 1;
        }
      }),
    );
    return report;
  }

  async #processClaimed(job: Job): Promise<'failed' | 'retried' | 'succeeded'> {
    try {
      const prepared = await this.prepare(job);
      await this.commit(prepared);
      return 'succeeded';
    } catch (cause) {
      const error =
        cause instanceof DomainError
          ? cause
          : new DomainError('INTERNAL_ERROR', { cause });
      const failedAt = this.#clock();
      const decision = this.#retryPolicy.decide(
        error,
        job.attempts,
        job.maxAttempts,
      );
      if (decision.retry) {
        const retryAt = new Date(failedAt.getTime() + decision.delayMs);
        await this.#repositories.jobs.fail(
          job.id,
          error.code,
          retryAt,
          failedAt,
        );
        return 'retried';
      }
      await this.#repositories.jobs.failPermanently(
        job.id,
        error.code,
        failedAt,
      );
      return 'failed';
    }
  }
}

function parsePayload(payload: Job['payload']) {
  const result = payloadSchema.safeParse(payload);
  if (!result.success) {
    throw new DomainError('JOB_PAYLOAD_INVALID', { cause: result.error });
  }
  return result.data;
}

function prepareResult(
  job: Job,
  canonicalHash: string,
  result: MarketSearchResult,
  leagueId: string,
  snapshotTtlMs: number,
): PreparedMarketJob {
  const currency = result.listings[0]?.price.currency ?? 'unknown';
  const aggregation = aggregateMarketListings({
    currency,
    listings: result.listings,
    totalListings: result.totalResults,
  });
  const snapshot: NewRawSnapshot = {
    capturedAt: result.fetchedAt,
    dedupeKey: `market:${job.refreshCycleId!}:${canonicalHash}`,
    expiresAt: new Date(result.fetchedAt.getTime() + snapshotTtlMs),
    leagueId,
    marketQueryId: job.marketQueryId!,
    payload: {
      listings: result.listings.map((listing) => ({
        ...listing,
        indexedAt: listing.indexedAt.toISOString(),
      })),
      provider: result.provider,
      totalResults: result.totalResults,
    },
    providerStatus: 200,
    refreshCycleId: job.refreshCycleId!,
  };
  const observation: NewAggregatedObservation = {
    cheapestPrice: aggregation.cheapest?.amount ?? null,
    currency,
    leagueId,
    marketQueryId: job.marketQueryId!,
    medianTopNPrice:
      aggregation.medianTopTen?.amount ??
      aggregation.medianTopFive?.amount ??
      null,
    nthPrice: aggregation.thirdCheapest?.amount ?? null,
    observedAt: result.fetchedAt,
    refreshCycleId: job.refreshCycleId!,
    sampleSize: aggregation.sampleSize,
    summary: {
      ageBuckets: aggregation.ageBuckets,
      estimators: aggregation.estimators,
      totalListings: aggregation.totalListings,
    },
  };
  return { job, observation, snapshot };
}

function assertPositiveInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
