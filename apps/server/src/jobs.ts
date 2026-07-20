import { PgBoss, type Job } from 'pg-boss';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export const TEST_JOB_QUEUE = 'system.test-cron';
export const TEST_SCHEDULE_KEY = 'singleton';
const TEST_JOB_SINGLETON_KEY = 'scheduled-test-job';

type TestJobData = { source: 'scheduler' };

export type JobRunner = {
  start(): Promise<void>;
  stop(timeoutMs: number): Promise<void>;
};

export function createJobBoss(
  pool: Pool,
  schema: string,
  logger: Logger,
): PgBoss {
  const boss = new PgBoss({
    db: {
      async executeSql(text, values) {
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    },
    migrate: true,
    schedule: true,
    schema,
    supervise: true,
  });

  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error');
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
