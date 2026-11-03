import {
  DomainError,
  type Repositories,
  type RefreshCycle,
  transitionRefreshCycle,
} from '@poe-worksmith/domain';

import {
  evaluateAndPublishCatalog,
  type CatalogPublicationReport,
} from './catalogPublisher.js';
import type {
  MarketJobProcessor,
  MarketJobRunReport,
} from './marketJobProcessor.js';
import {
  planCatalogRefresh,
  type RefreshPlanReport,
} from './refreshPlanner.js';
import type { RefreshLeagueContext } from './refreshLeagueContext.js';
import type { RecipeMarketDependencies } from './recipeMarket.js';
import type { Logger } from 'pino';
import { operationLogger } from './observability/operationContext.js';
import type { Metrics } from './observability/metrics.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CATALOG_REFRESH_TIMEOUT_SECONDS } from './refreshLimits.js';

type MarketJobRunner = Pick<MarketJobProcessor, 'runAvailable'>;

export type FullRefreshReport = Readonly<{
  jobs: MarketJobRunReport;
  plan: RefreshPlanReport;
  publication: CatalogPublicationReport;
}>;

export class FullRefreshOrchestrator {
  readonly #collectMaterialPrices: (() => Promise<void>) | undefined;
  readonly #clock: () => Date;
  readonly #league: RefreshLeagueContext;
  readonly #marketJobs: MarketJobRunner;
  readonly #repositories: Repositories;
  readonly #marketDependencies: RecipeMarketDependencies | undefined;
  readonly #economy:
    | (Pick<MarketEconomyRepository, 'find' | 'latest'> &
        Partial<Pick<MarketEconomyRepository, 'listAttempts'>>)
    | undefined;
  readonly #snapshotTtlMs: number;
  readonly #workerId: string;
  readonly #logger: Logger | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #recipeId: string | undefined;
  readonly #maximumQuoteAgeMs: number;

  constructor(options: {
    collectMaterialPrices?: () => Promise<void>;
    clock?: () => Date;
    league: RefreshLeagueContext;
    marketJobs: MarketJobRunner;
    marketDependencies?: RecipeMarketDependencies;
    economy?: Pick<MarketEconomyRepository, 'find' | 'latest'> &
      Partial<Pick<MarketEconomyRepository, 'listAttempts'>>;
    repositories: Repositories;
    snapshotTtlMs: number;
    workerId: string;
    logger?: Logger;
    metrics?: Metrics;
    signal?: AbortSignal;
    recipeId?: string;
    maximumQuoteAgeMs?: number;
  }) {
    this.#collectMaterialPrices = options.collectMaterialPrices;
    this.#clock = options.clock ?? (() => new Date());
    this.#league = Object.freeze({ ...options.league });
    this.#marketJobs = options.marketJobs;
    this.#marketDependencies = options.marketDependencies;
    this.#economy = options.economy;
    this.#repositories = options.repositories;
    this.#snapshotTtlMs = options.snapshotTtlMs;
    this.#workerId = options.workerId.trim();
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#signal = options.signal;
    this.#recipeId = options.recipeId;
    this.#maximumQuoteAgeMs = options.maximumQuoteAgeMs ?? 30 * 60_000;
    if (
      Object.values(this.#league).some((value) => value.trim().length === 0) ||
      this.#workerId.length === 0 ||
      !Number.isInteger(this.#snapshotTtlMs) ||
      this.#snapshotTtlMs < 1
    ) {
      throw new TypeError('Refresh orchestrator options are invalid');
    }
  }

  async run(cycleId: string): Promise<FullRefreshReport> {
    const started = performance.now();
    const logger =
      this.#logger &&
      operationLogger(this.#logger, {
        cycleId,
        leagueId: this.#league.leagueId,
        leagueGggId: this.#league.leagueGggId,
      });
    logger?.info('refresh.started');
    try {
      this.#signal?.throwIfAborted();
      const now = this.#clock();
      const plan = await planCatalogRefresh(this.#repositories, {
        cycleId,
        league: this.#league,
        now,
        ...(this.#marketDependencies
          ? { marketDependencies: this.#marketDependencies }
          : {}),
        snapshotTtlMs: this.#snapshotTtlMs,
        ...(this.#recipeId ? { recipeId: this.#recipeId } : {}),
        ...(logger ? { logger } : {}),
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
      });
      let cycle = plan.cycle;
      if (cycle.status === 'queued') {
        cycle = await this.#repositories.cycles.save(
          transitionRefreshCycle(cycle, 'running', now),
        );
      }

      await this.#collectPrices(cycle);
      this.#signal?.throwIfAborted();
      const jobs = {
        claimed: 0,
        failed: 0,
        recovered: 0,
        retried: 0,
        succeeded: 0,
      };
      for (;;) {
        const batch = await this.#marketJobs.runAvailable(
          `${this.#workerId}:${cycle.id}`,
          this.#clock(),
          this.#signal,
        );
        jobs.claimed += batch.claimed;
        jobs.failed += batch.failed;
        jobs.recovered += batch.recovered;
        jobs.retried += batch.retried;
        jobs.succeeded += batch.succeeded;
        this.#signal?.throwIfAborted();
        const refreshed = await this.#repositories.cycles.findById(cycle.id);
        if (!refreshed) throw new DomainError('PERSISTENCE_NOT_FOUND');
        cycle = refreshed;
        if (cycle.completedQueries + cycle.failedQueries === cycle.totalQueries)
          break;
        if (
          cycle.status !== 'running' ||
          performance.now() - started >=
            (CATALOG_REFRESH_TIMEOUT_SECONDS - 15 * 60) * 1000 ||
          (jobs.retried === 0 && jobs.recovered === 0)
        )
          throw new DomainError('REFRESH_INCOMPLETE');
        // shortcut: reserve 15m between batches; share a deadline if in-flight work needs the same limit.
        await delay(1000, undefined, { signal: this.#signal });
      }

      await this.#collectPrices(cycle);
      this.#signal?.throwIfAborted();
      const publication = await evaluateAndPublishCatalog(this.#repositories, {
        cycleId: cycle.id,
        league: this.#league.leagueGggId,
        leagueName: this.#league.leagueName,
        now: this.#clock(),
        maximumQuoteAgeMs: this.#maximumQuoteAgeMs,
        ...(this.#recipeId ? { recipeId: this.#recipeId } : {}),
        ...(this.#signal ? { signal: this.#signal } : {}),
        ...(logger ? { logger } : {}),
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
        ...(this.#marketDependencies
          ? { marketDependencies: this.#marketDependencies }
          : {}),
        ...(this.#economy ? { economy: this.#economy } : {}),
      });
      logger?.info('refresh.completed');
      this.#metrics?.refreshDuration.observe(
        { outcome: 'success' },
        (performance.now() - started) / 1000,
      );
      return { jobs, plan: plan.report, publication };
    } catch (error) {
      logger?.error(
        {
          errorCode:
            error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        },
        'refresh.failed',
      );
      this.#metrics?.refreshDuration.observe(
        { outcome: 'failed' },
        (performance.now() - started) / 1000,
      );
      throw error;
    }
  }
  async #collectPrices(cycle: RefreshCycle) {
    if (cycle.status !== 'running') return;
    try {
      await this.#collectMaterialPrices?.();
    } catch (cause) {
      const error =
        cause instanceof DomainError
          ? cause
          : new DomainError('PERSISTENCE_UNAVAILABLE', { cause });
      await this.#repositories.cycles.save({
        ...transitionRefreshCycle(cycle, 'failed', this.#clock()),
        errorMessage: error.code,
      });
      throw error;
    }
  }
}
