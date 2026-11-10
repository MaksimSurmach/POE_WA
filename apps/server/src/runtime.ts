import type { Pool } from 'pg';
import type { Logger } from 'pino';

type ApiServer = {
  close(): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<unknown>;
};

export class ApplicationRuntime {
  #apiStarted = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      api: ApiServer;
      host: string;
      logger: Logger;
      pool: Pick<Pool, 'end'>;
      port: number;
    },
  ) {}

  async start() {
    const { api, host, port, logger } = this.options;
    this.#apiStarted = true;
    try {
      await api.listen({ host, port });
      logger.info({ mode: 'api' }, 'application runtime started');
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
    const { api, pool, logger } = this.options;
    const errors: unknown[] = [];
    if (this.#apiStarted)
      await api.close().catch((error: unknown) => errors.push(error));
    await pool.end().catch((error: unknown) => errors.push(error));
    if (errors.length > 0)
      throw new AggregateError(errors, 'Application shutdown failed');
    logger.info({ mode: 'api' }, 'application runtime stopped');
  }
}

export async function runCollectorRuntime(
  run: (signal: AbortSignal) => Promise<void>,
  logger: Pick<Logger, 'info'>,
) {
  const stop = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'collector shutdown requested');
    stop.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await run(stop.signal);
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}
