import {
  DomainError,
  type Repositories,
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

type MarketJobRunner = Pick<MarketJobProcessor, 'runAvailable'>;

export type FullRefreshReport = Readonly<{
  jobs: MarketJobRunReport;
  plan: RefreshPlanReport;
  publication: CatalogPublicationReport;
}>;

export class FullRefreshOrchestrator {
  readonly #clock: () => Date;
  readonly #league: RefreshLeagueContext;
  readonly #marketJobs: MarketJobRunner;
  readonly #repositories: Repositories;
  readonly #marketDependencies: RecipeMarketDependencies | undefined;
  readonly #snapshotTtlMs: number;
  readonly #workerId: string;
  readonly #logger: Logger | undefined;
  readonly #metrics: Metrics | undefined;

  constructor(options: {
    clock?: () => Date;
    league: RefreshLeagueContext;
    marketJobs: MarketJobRunner;
    marketDependencies?: RecipeMarketDependencies;
    repositories: Repositories;
    snapshotTtlMs: number;
    workerId: string;
    logger?: Logger;
    metrics?: Metrics;
  }) {
    this.#clock = options.clock ?? (() => new Date());
    this.#league = Object.freeze({ ...options.league });
    this.#marketJobs = options.marketJobs;
    this.#marketDependencies = options.marketDependencies;
    this.#repositories = options.repositories;
    this.#snapshotTtlMs = options.snapshotTtlMs;
    this.#workerId = options.workerId.trim();
    this.#logger = options.logger;
    this.#metrics = options.metrics;
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
      const now = this.#clock();
      const plan = await planCatalogRefresh(this.#repositories, {
        cycleId,
        league: this.#league,
        now,
        ...(this.#marketDependencies
          ? { marketDependencies: this.#marketDependencies }
          : {}),
        snapshotTtlMs: this.#snapshotTtlMs,
        ...(logger ? { logger } : {}),
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
      });
      let cycle = plan.cycle;
      if (cycle.status === 'queued') {
        cycle = await this.#repositories.cycles.save(
          transitionRefreshCycle(cycle, 'running', now),
        );
      }

      const jobs = await this.#marketJobs.runAvailable(
        `${this.#workerId}:${cycle.id}`,
        now,
      );
      const refreshed = await this.#repositories.cycles.findById(cycle.id);
      if (!refreshed) throw new DomainError('PERSISTENCE_NOT_FOUND');
      cycle = refreshed;
      if (cycle.completedQueries + cycle.failedQueries !== cycle.totalQueries) {
        throw new DomainError('REFRESH_INCOMPLETE');
      }

      const publication = await evaluateAndPublishCatalog(this.#repositories, {
        cycleId: cycle.id,
        league: this.#league.leagueGggId,
        leagueName: this.#league.leagueName,
        now: this.#clock(),
        ...(logger ? { logger } : {}),
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
        ...(this.#marketDependencies
          ? { marketDependencies: this.#marketDependencies }
          : {}),
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
}
