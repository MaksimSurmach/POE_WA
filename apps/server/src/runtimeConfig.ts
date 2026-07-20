import { z } from 'zod';

import { loadDatabaseConfig, type DatabaseConfig } from './config.js';

export type ApplicationMode = 'all' | 'api' | 'worker';

const runtimeEnvironmentSchema = z.object({
  APP_HOST: z.string().min(1).default('127.0.0.1'),
  APP_MODE: z.enum(['all', 'api', 'worker']).default('all'),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PG_BOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('pgboss'),
  SCHEDULER_TEST_CRON: z.string().min(1).default('* * * * *'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
});

export type RuntimeConfig = {
  database: DatabaseConfig;
  host: string;
  jobSchema: string;
  logLevel: z.infer<typeof runtimeEnvironmentSchema>['LOG_LEVEL'];
  mode: ApplicationMode;
  port: number;
  shutdownTimeoutMs: number;
  testCron: string;
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
    database: loadDatabaseConfig(environment),
    host: result.data.APP_HOST,
    jobSchema: result.data.PG_BOSS_SCHEMA,
    logLevel: result.data.LOG_LEVEL,
    mode: forcedMode ?? result.data.APP_MODE,
    port: result.data.APP_PORT,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
    testCron: result.data.SCHEDULER_TEST_CRON,
  };
}

export function modeIncludesApi(mode: ApplicationMode) {
  return mode === 'all' || mode === 'api';
}

export function modeIncludesWorker(mode: ApplicationMode) {
  return mode === 'all' || mode === 'worker';
}
