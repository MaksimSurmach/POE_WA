import { z } from 'zod';

import { loadDatabaseConfig, type DatabaseConfig } from './config.js';

export type ApplicationMode = 'all' | 'api' | 'worker';

const runtimeEnvironmentSchema = z.object({
  APP_HOST: z.string().min(1).default('127.0.0.1'),
  APP_MODE: z.enum(['all', 'api', 'worker']).default('all'),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  CLEANUP_CRON: z.string().min(1).default('15 2 * * *'),
  JOB_LEASE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(5 * 60 * 1000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MARKET_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  MARKET_RETRY_DELAY_MS: z.coerce.number().int().min(1000).default(60_000),
  PG_BOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('pgboss'),
  POE_LEAGUE: z.string().trim().min(1).default('Mercenaries'),
  POE_USER_AGENT: z
    .string()
    .trim()
    .min(1)
    .default('POE-Worksmith/0.0.0 (contact: local-development)'),
  REFRESH_CRON: z.string().min(1).default('0 */4 * * *'),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).default(500),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  SNAPSHOT_TTL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(30 * 60 * 1000),
});

export type RuntimeConfig = {
  cleanupCron: string;
  database: DatabaseConfig;
  host: string;
  jobLeaseTimeoutMs: number;
  jobSchema: string;
  league: string;
  logLevel: z.infer<typeof runtimeEnvironmentSchema>['LOG_LEVEL'];
  marketConcurrency: number;
  marketRetryDelayMs: number;
  mode: ApplicationMode;
  poeUserAgent: string;
  port: number;
  refreshCron: string;
  retentionBatchSize: number;
  shutdownTimeoutMs: number;
  snapshotTtlMs: number;
};

export class RuntimeConfigurationError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const details = issues
      .map(
        (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      )
      .join('; ');
    super(`Invalid runtime configuration: ${details}`);
    this.name = 'RuntimeConfigurationError';
  }
}

export function loadRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
  forcedMode?: ApplicationMode,
): RuntimeConfig {
  const result = runtimeEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new RuntimeConfigurationError(result.error.issues);
  }

  return {
    cleanupCron: result.data.CLEANUP_CRON,
    database: loadDatabaseConfig(environment),
    host: result.data.APP_HOST,
    jobLeaseTimeoutMs: result.data.JOB_LEASE_TIMEOUT_MS,
    jobSchema: result.data.PG_BOSS_SCHEMA,
    league: result.data.POE_LEAGUE,
    logLevel: result.data.LOG_LEVEL,
    marketConcurrency: result.data.MARKET_CONCURRENCY,
    marketRetryDelayMs: result.data.MARKET_RETRY_DELAY_MS,
    mode: forcedMode ?? result.data.APP_MODE,
    poeUserAgent: result.data.POE_USER_AGENT,
    port: result.data.APP_PORT,
    refreshCron: result.data.REFRESH_CRON,
    retentionBatchSize: result.data.RETENTION_BATCH_SIZE,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
    snapshotTtlMs: result.data.SNAPSHOT_TTL_MS,
  };
}

export function modeIncludesApi(mode: ApplicationMode) {
  return mode === 'all' || mode === 'api';
}

export function modeIncludesWorker(mode: ApplicationMode) {
  return mode === 'all' || mode === 'worker';
}
