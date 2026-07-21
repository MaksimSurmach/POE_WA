import { PgBoss, type Job } from 'pg-boss';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export const TEST_JOB_QUEUE = 'system.test-cron';
export const TEST_SCHEDULE_KEY = 'singleton';
const TEST_JOB_SINGLETON_KEY = 'scheduled-test-job';

export const CATALOG_REFRESH_QUEUE = 'catalog.full-refresh';
export const CATALOG_REFRESH_SCHEDULE_KEY = 'full-refresh';
export const CATALOG_CLEANUP_QUEUE = 'catalog.retention-cleanup';
export const CATALOG_CLEANUP_SCHEDULE_KEY = 'retention-cleanup';
const CATALOG_REFRESH_SINGLETON_KEY = 'catalog-refresh';
const CATALOG_CLEANUP_SINGLETON_KEY = 'catalog-cleanup';
export const LEAGUE_RESOLVE_QUEUE = 'league.resolve';
export const LEAGUE_RESOLVE_SCHEDULE_KEY = 'league-resolve';
const LEAGUE_RESOLVE_SINGLETON_KEY = 'league-resolve';

type TestJobData = { source: 'scheduler' };
type CatalogRefreshJobData = { source: 'manual' | 'scheduler' };
type CatalogCleanupJobData = { source: 'scheduler' };
type LeagueResolveJobData = { source: 'scheduler' | 'startup' };

export type JobRunner = {
  start(): Promise<void>;
  stop(timeoutMs: number): Promise<void>;
};

export function createJobBoss(
  pool: Pool,
  schema: string,
  logger: Logger,
  onError?: (error: Error) => void,
): PgBoss {
  const boss = new PgBoss({
    db: {
      async executeSql(text, values) {
        const result = await pool.query(text, values);
        return { rows: (Array.isArray(result) ? result.at(-1) : result).rows };
      },
    },
    migrate: true,
    schedule: true,
    schema,
    supervise: true,
  });

  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error');
    onError?.(error);
  });
  boss.on('warning', (warning) => {
    logger.warn({ warning }, 'pg-boss warning');
  });

  return boss;
}

export async function ensureTestSchedule(boss: PgBoss, cron: string) {
  await boss.createQueue(TEST_JOB_QUEUE, {
    deleteAfterSeconds: 3600,
    policy: 'exclusive',
    retryLimit: 0,
  });
  await boss.schedule(
    TEST_JOB_QUEUE,
    cron,
    { source: 'scheduler' } satisfies TestJobData,
    {
      key: TEST_SCHEDULE_KEY,
      singletonKey: TEST_JOB_SINGLETON_KEY,
      singletonSeconds: 60,
      tz: 'UTC',
    },
  );
}

export async function ensureCatalogSchedules(
  boss: PgBoss,
  options: { cleanupCron: string; refreshCron: string },
) {
  await boss.createQueue(CATALOG_REFRESH_QUEUE, {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    expireInSeconds: 60 * 60,
    policy: 'exclusive',
    retryBackoff: true,
    retryDelay: 60,
    retryLimit: 6,
  });
  await boss.createQueue(CATALOG_CLEANUP_QUEUE, {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    expireInSeconds: 30 * 60,
    policy: 'exclusive',
    retryBackoff: true,
    retryDelay: 60,
    retryLimit: 3,
  });
  await boss.schedule(
    CATALOG_REFRESH_QUEUE,
    options.refreshCron,
    { source: 'scheduler' } satisfies CatalogRefreshJobData,
    {
      key: CATALOG_REFRESH_SCHEDULE_KEY,
      singletonKey: CATALOG_REFRESH_SINGLETON_KEY,
      singletonSeconds: 60,
      tz: 'UTC',
    },
  );
  await boss.schedule(
    CATALOG_CLEANUP_QUEUE,
    options.cleanupCron,
    { source: 'scheduler' } satisfies CatalogCleanupJobData,
    {
      key: CATALOG_CLEANUP_SCHEDULE_KEY,
      singletonKey: CATALOG_CLEANUP_SINGLETON_KEY,
      singletonSeconds: 60,
      tz: 'UTC',
    },
  );
}

export async function ensureLeagueSchedule(
  boss: PgBoss,
  options: { cron: string; timezone: string },
) {
  await boss.createQueue(LEAGUE_RESOLVE_QUEUE, {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    expireInSeconds: 30 * 60,
    policy: 'exclusive',
    retryBackoff: true,
    retryDelay: 60,
    retryLimit: 6,
  });
  await boss.schedule(
    LEAGUE_RESOLVE_QUEUE,
    options.cron,
    { source: 'scheduler' } satisfies LeagueResolveJobData,
    {
      key: LEAGUE_RESOLVE_SCHEDULE_KEY,
      singletonKey: LEAGUE_RESOLVE_SINGLETON_KEY,
      singletonSeconds: 60,
      tz: options.timezone,
    },
  );
}

export class ApplicationJobScheduler implements JobRunner {
  readonly #boss: PgBoss;
  readonly #cleanupCron: string;
  readonly #logger: Logger;
  readonly #refreshCron: string;
  readonly #runCleanup: () => Promise<unknown>;
  readonly #runRefresh: (cycleId: string) => Promise<unknown>;
  readonly #leagueCron: string;
  readonly #leagueTimezone: string;
  readonly #runLeagueResolve: () => Promise<unknown>;
  #started = false;

  constructor(options: {
    boss: PgBoss;
    cleanupCron: string;
    logger: Logger;
    refreshCron: string;
    runCleanup: () => Promise<unknown>;
    runRefresh: (cycleId: string) => Promise<unknown>;
    leagueCron?: string;
    leagueTimezone?: string;
    runLeagueResolve?: () => Promise<unknown>;
  }) {
    this.#boss = options.boss;
    this.#cleanupCron = options.cleanupCron;
    this.#logger = options.logger;
    this.#refreshCron = options.refreshCron;
    this.#runCleanup = options.runCleanup;
    this.#runRefresh = options.runRefresh;
    this.#leagueCron = options.leagueCron ?? '0 23 * * *';
    this.#leagueTimezone = options.leagueTimezone ?? 'Europe/Warsaw';
    this.#runLeagueResolve =
      options.runLeagueResolve ?? (async () => undefined);
  }

  async start() {
    if (this.#started) return;
    try {
      await this.#boss.start();
      await ensureCatalogSchedules(this.#boss, {
        cleanupCron: this.#cleanupCron,
        refreshCron: this.#refreshCron,
      });
      await ensureLeagueSchedule(this.#boss, {
        cron: this.#leagueCron,
        timezone: this.#leagueTimezone,
      });
      await this.#boss.work<CatalogRefreshJobData>(
        CATALOG_REFRESH_QUEUE,
        { localConcurrency: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const report = await this.#runRefresh(job.id);
            this.#logger.info(
              { cycleId: job.id, report, source: job.data.source },
              'catalog refresh completed',
            );
          }
        },
      );
      await this.#boss.work<CatalogCleanupJobData>(
        CATALOG_CLEANUP_QUEUE,
        { localConcurrency: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const report = await this.#runCleanup();
            this.#logger.info(
              { jobId: job.id, report },
              'catalog retention cleanup completed',
            );
          }
        },
      );
      await this.#boss.work<LeagueResolveJobData>(
        LEAGUE_RESOLVE_QUEUE,
        { localConcurrency: 1 },
        async (jobs) => {
          for (const job of jobs)
            this.#logger.info(
              {
                jobId: job.id,
                report: await this.#runLeagueResolve(),
                source: job.data.source,
              },
              'league resolver completed',
            );
        },
      );
      await this.#boss.send(
        LEAGUE_RESOLVE_QUEUE,
        { source: 'startup' } satisfies LeagueResolveJobData,
        { singletonKey: LEAGUE_RESOLVE_SINGLETON_KEY, singletonSeconds: 60 },
      );
      this.#started = true;
    } catch (error) {
      await this.#boss.stop({ close: false, graceful: false });
      throw error;
    }
  }

  async stop(timeoutMs: number) {
    if (!this.#started) return;
    await this.#boss.stop({ close: false, graceful: true, timeout: timeoutMs });
    this.#started = false;
  }

  triggerRefresh() {
    return this.#boss.send(
      CATALOG_REFRESH_QUEUE,
      { source: 'manual' } satisfies CatalogRefreshJobData,
      {
        singletonKey: CATALOG_REFRESH_SINGLETON_KEY,
        singletonSeconds: 60,
      },
    );
  }
}

export { ApplicationJobScheduler as CatalogRefreshScheduler };

export class PgBossJobRunner implements JobRunner {
  readonly #boss: PgBoss;
  readonly #cron: string;
  readonly #logger: Logger;
  #started = false;

  constructor(boss: PgBoss, cron: string, logger: Logger) {
    this.#boss = boss;
    this.#cron = cron;
    this.#logger = logger;
  }

  async start() {
    if (this.#started) return;

    try {
      await this.#boss.start();
      await ensureTestSchedule(this.#boss, this.#cron);
      await this.#boss.work<TestJobData>(
        TEST_JOB_QUEUE,
        { localConcurrency: 1 },
        async (jobs) => this.#handle(jobs),
      );
      this.#started = true;
    } catch (error) {
      await this.#boss.stop({ close: false, graceful: false });
      throw error;
    }
  }

  async stop(timeoutMs: number) {
    if (!this.#started) return;
    await this.#boss.stop({ close: false, graceful: true, timeout: timeoutMs });
    this.#started = false;
  }

  async #handle(jobs: Job<TestJobData>[]) {
    for (const job of jobs) {
      this.#logger.info(
        { jobId: job.id, queue: job.name, source: job.data.source },
        'test cron job processed',
      );
    }
  }
}
