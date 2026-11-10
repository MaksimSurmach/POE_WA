import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { Client } from 'pg';

import { loadDatabaseConfig, type DatabaseConfig } from './config.js';

export type ApplicationMode = 'all' | 'api' | 'worker' | 'collector';

const collectorScheduleFields = {
  CLEANUP_CRON: z.string().min(1).default('15 2 * * *'),
  COLLECTOR_RETENTION_ENABLED: z.enum(['true', 'false']).default('true'),
  LEAGUE_RESOLVE_CRON: z.string().min(1).default('0 23 * * *'),
  LEAGUE_RESOLVE_TIMEZONE: z.string().min(1).default('Europe/Warsaw'),
};
const collectorScheduleEnvironmentSchema = z
  .object(collectorScheduleFields)
  .superRefine((value, context) => {
    for (const [key, tz] of [
      ['CLEANUP_CRON', 'UTC'],
      ['LEAGUE_RESOLVE_CRON', value.LEAGUE_RESOLVE_TIMEZONE],
    ] as const) {
      try {
        const schedule = CronExpressionParser.parse(value[key], { tz });
        schedule.next();
        schedule.next();
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Invalid cron or timezone',
          path: [key],
        });
      }
    }
  });

const runtimeEnvironmentSchema = z
  .object({
    APP_HOST: z.string().min(1).default('127.0.0.1'),
    APP_MODE: z.enum(['all', 'api', 'worker', 'collector']).default('all'),
    APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PIPELINE: z.enum(['legacy', 'collector']).default('legacy'),
    ...collectorScheduleFields,
    JOB_LEASE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(20 * 60 * 1000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    MARKET_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
    OPERATOR_DIAGNOSTICS_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    MARKET_RETRY_DELAY_MS: z.coerce.number().int().min(1000).default(60_000),
    PG_BOSS_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default('pgboss'),
    POE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    POE_USER_AGENT: z
      .string()
      .trim()
      .min(1)
      .startsWith('OAuth ')
      .default('OAuth poe-worksmith/0.0.0 (contact: local-development)'),
    REFRESH_CRON: z.string().min(1).default('0 * * * *'),
    REFRESH_TIMEZONE: z.string().min(1).default('UTC'),
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).default(500),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    SNAPSHOT_TTL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(30 * 60 * 1000),
  })
  .superRefine((value, context) => {
    try {
      CronExpressionParser.parse(value.REFRESH_CRON, {
        tz: value.REFRESH_TIMEZONE,
      });
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid cron or timezone',
        path: ['REFRESH_CRON'],
      });
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value.REFRESH_TIMEZONE });
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid IANA timezone',
        path: ['REFRESH_TIMEZONE'],
      });
    }
  });

export type RuntimeConfig = {
  cleanupCron: string;
  collectorRetentionEnabled: boolean;
  database: DatabaseConfig;
  host: string;
  jobLeaseTimeoutMs: number;
  jobSchema: string;
  leagueResolveCron: string;
  leagueResolveTimezone: string;
  logLevel: z.infer<typeof runtimeEnvironmentSchema>['LOG_LEVEL'];
  marketConcurrency: number;
  operatorDiagnosticsToken: string | undefined;
  marketRetryDelayMs: number;
  mode: ApplicationMode;
  pipeline: z.infer<typeof runtimeEnvironmentSchema>['PIPELINE'];
  poeUserAgent: string;
  poeRequestTimeoutMs: number;
  port: number;
  refreshCron: string;
  refreshTimezone: string;
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

export function loadCollectorScheduleConfig(
  environment: Record<string, string | undefined> = process.env,
) {
  const result = collectorScheduleEnvironmentSchema.safeParse(environment);
  if (!result.success) throw new RuntimeConfigurationError(result.error.issues);
  return {
    cleanupCron: result.data.CLEANUP_CRON,
    collectorRetentionEnabled:
      result.data.COLLECTOR_RETENTION_ENABLED === 'true',
    leagueResolveCron: result.data.LEAGUE_RESOLVE_CRON,
    leagueResolveTimezone: result.data.LEAGUE_RESOLVE_TIMEZONE,
  };
}

export function loadRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
  forcedMode?: ApplicationMode,
): RuntimeConfig {
  const result = runtimeEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new RuntimeConfigurationError(result.error.issues);
  }

  const mode = forcedMode ?? result.data.APP_MODE;
  const database = loadDatabaseConfig(environment);
  if (mode === 'collector') {
    const path = [
      database.environment === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL',
    ];
    let host: string;
    try {
      host = new Client({
        connectionString: database.connectionString,
        ssl: database.ssl,
      }).host;
    } catch {
      throw new RuntimeConfigurationError([
        {
          code: 'custom',
          path,
          message: 'Invalid PostgreSQL connection options',
        },
      ]);
    }
    if (/^[^.]+-pooler\..+\.neon\.tech\.?$/i.test(host)) {
      throw new RuntimeConfigurationError([
        {
          code: 'custom',
          path,
          message:
            'Collector requires a direct PostgreSQL endpoint for LISTEN and its advisory lock',
        },
      ]);
    }
  }

  return {
    cleanupCron: result.data.CLEANUP_CRON,
    collectorRetentionEnabled:
      result.data.COLLECTOR_RETENTION_ENABLED === 'true',
    database,
    host: result.data.APP_HOST,
    jobLeaseTimeoutMs: result.data.JOB_LEASE_TIMEOUT_MS,
    jobSchema: result.data.PG_BOSS_SCHEMA,
    leagueResolveCron: result.data.LEAGUE_RESOLVE_CRON,
    leagueResolveTimezone: result.data.LEAGUE_RESOLVE_TIMEZONE,
    logLevel: result.data.LOG_LEVEL,
    marketConcurrency: result.data.MARKET_CONCURRENCY,
    operatorDiagnosticsToken: result.data.OPERATOR_DIAGNOSTICS_TOKEN,
    marketRetryDelayMs: result.data.MARKET_RETRY_DELAY_MS,
    mode,
    pipeline: result.data.PIPELINE,
    poeUserAgent: result.data.POE_USER_AGENT,
    poeRequestTimeoutMs: result.data.POE_REQUEST_TIMEOUT_MS,
    port: result.data.APP_PORT,
    refreshCron: result.data.REFRESH_CRON,
    refreshTimezone: result.data.REFRESH_TIMEZONE,
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
