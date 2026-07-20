import pino from 'pino';

import { buildApi } from './api.js';
import { createDatabasePool } from './database.js';
import { createJobBoss, PgBossJobRunner } from './jobs.js';
import { ApplicationRuntime } from './runtime.js';
import {
  type ApplicationMode,
  loadRuntimeConfig,
  modeIncludesApi,
  modeIncludesWorker,
} from './runtimeConfig.js';

export async function runProcess(forcedMode?: ApplicationMode) {
  const config = loadRuntimeConfig(process.env, forcedMode);
  const logger = pino({ level: config.logLevel, name: 'poe-worksmith' });
  const pool = createDatabasePool(config.database);
  const api = modeIncludesApi(config.mode)
    ? buildApi(logger, async () => {
        await pool.query('select 1');
      })
    : undefined;
  const jobs = modeIncludesWorker(config.mode)
    ? new PgBossJobRunner(
        createJobBoss(pool, config.jobSchema, logger),
        config.testCron,
        logger,
      )
    : undefined;
  const runtime = new ApplicationRuntime({
    ...(api ? { api } : {}),
    host: config.host,
    ...(jobs ? { jobs } : {}),
    logger,
    mode: config.mode,
    pool,
    port: config.port,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  try {
    await runtime.start();
  } catch (error) {
    logger.fatal({ err: error }, 'application startup failed');
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutdown requested');
    try {
      await runtime.stop();
    } catch (error) {
      logger.error({ err: error }, 'application shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
