import { z } from 'zod';

const postgresUrlSchema = z
  .url('Must be a valid PostgreSQL connection URL')
  .refine(
    (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    'Must use the postgres:// or postgresql:// protocol',
  );

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging']),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(6),
    DATABASE_SSL_MODE: z.enum(['disable', 'require']).default('disable'),
    DATABASE_URL: postgresUrlSchema.optional(),
    TEST_DATABASE_URL: postgresUrlSchema.optional(),
  })
  .superRefine((environment, context) => {
    if (environment.APP_ENV === 'test' && !environment.TEST_DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        message: 'Required when APP_ENV=test',
        path: ['TEST_DATABASE_URL'],
      });
    }

    if (environment.APP_ENV !== 'test' && !environment.DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        message: 'Required unless APP_ENV=test',
        path: ['DATABASE_URL'],
      });
    }

    if (
      environment.APP_ENV === 'staging' &&
      environment.DATABASE_SSL_MODE !== 'require'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Must be require when APP_ENV=staging',
        path: ['DATABASE_SSL_MODE'],
      });
    }
  });

export type DatabaseConfig = {
  connectionString: string;
  connectionTimeoutMillis: number;
  environment: 'development' | 'test' | 'staging';
  idleTimeoutMillis: number;
  maxConnections: number;
  ssl: false | { rejectUnauthorized: true };
};

export class EnvironmentConfigurationError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const details = issues
      .map(
        (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      )
      .join('; ');
    super(`Invalid database configuration: ${details}`);
    this.name = 'EnvironmentConfigurationError';
  }
}

export function loadDatabaseConfig(
  environment: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new EnvironmentConfigurationError(result.error.issues);
  }

  const connectionString =
    result.data.APP_ENV === 'test'
      ? result.data.TEST_DATABASE_URL!
      : result.data.DATABASE_URL!;

  return {
    connectionString,
    connectionTimeoutMillis: result.data.DATABASE_CONNECTION_TIMEOUT_MS,
    environment: result.data.APP_ENV,
    idleTimeoutMillis: result.data.DATABASE_IDLE_TIMEOUT_MS,
    maxConnections: result.data.DATABASE_POOL_MAX,
    ssl:
      result.data.DATABASE_SSL_MODE === 'require'
        ? { rejectUnauthorized: true }
        : false,
  };
}
