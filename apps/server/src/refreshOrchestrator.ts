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
  readonly #snapshotTtlMs: number;
  readonly #workerId: string;

  constructor(options: {
    clock?: () => Date;
    league: RefreshLeagueContext;
    marketJobs: MarketJobRunner;
    repositories: Repositories;
    snapshotTtlMs: number;
    workerId: string;
  }) {
    this.#clock = options.clock ?? (() => new Date());
    this.#league = Object.freeze({ ...options.league });
    this.#marketJobs = options.marketJobs;
    this.#repositories = options.repositories;
    this.#snapshotTtlMs = options.snapshotTtlMs;
    this.#workerId = options.workerId.trim();
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
    const now = this.#clock();
    const plan = await planCatalogRefresh(this.#repositories, {
      cycleId,
      league: this.#league,
      now,
      snapshotTtlMs: this.#snapshotTtlMs,
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
    });
    return { jobs, plan: plan.report, publication };
  }
}
