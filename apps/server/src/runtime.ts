import type { Pool } from 'pg';
import type { Logger } from 'pino';

import type { JobRunner } from './jobs.js';
import {
  type ApplicationMode,
  modeIncludesApi,
  modeIncludesWorker,
} from './runtimeConfig.js';

type ApiServer = {
  close(): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<unknown>;
};
type DatabasePool = Pick<Pool, 'end'>;

export class ApplicationRuntime {
  readonly #api: ApiServer | undefined;
  readonly #host: string;
  readonly #jobs: JobRunner | undefined;
  readonly #logger: Logger;
  readonly #mode: ApplicationMode;
  readonly #pool: DatabasePool;
  readonly #port: number;
  readonly #shutdownTimeoutMs: number;
  #apiStarted = false;
  #jobsStarted = false;
  #poolClosed = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: {
    api?: ApiServer;
    host: string;
    jobs?: JobRunner;
    logger: Logger;
    mode: ApplicationMode;
    pool: DatabasePool;
    port: number;
    shutdownTimeoutMs: number;
  }) {
    this.#api = options.api;
    this.#host = options.host;
    this.#jobs = options.jobs;
    this.#logger = options.logger;
    this.#mode = options.mode;
    this.#pool = options.pool;
    this.#port = options.port;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
  }

  async start() {
    try {
      if (modeIncludesWorker(this.#mode)) {
        if (!this.#jobs) throw new Error('Worker mode requires a job runner');
        this.#jobsStarted = true;
        await this.#jobs.start();
      }

      if (modeIncludesApi(this.#mode)) {
        if (!this.#api) throw new Error('API mode requires an API server');
        this.#apiStarted = true;
        await this.#api.listen({ host: this.#host, port: this.#port });
      }

      this.#logger.info({ mode: this.#mode }, 'application runtime started');
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  stop() {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop() {
    const errors: unknown[] = [];

    if (this.#apiStarted && this.#api) {
      await this.#api.close().catch((error: unknown) => errors.push(error));
      this.#apiStarted = false;
    }
    if (this.#jobsStarted && this.#jobs) {
      await this.#jobs
        .stop(this.#shutdownTimeoutMs)
        .catch((error: unknown) => errors.push(error));
      this.#jobsStarted = false;
    }
    if (!this.#poolClosed) {
      await this.#pool.end().catch((error: unknown) => errors.push(error));
      this.#poolClosed = true;
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Application shutdown failed');
    }
    this.#logger.info({ mode: this.#mode }, 'application runtime stopped');
  }
}
