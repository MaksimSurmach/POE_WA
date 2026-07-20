import { describe, expect, it } from 'vitest';

import {
  loadRuntimeConfig,
  modeIncludesApi,
  modeIncludesWorker,
  RuntimeConfigurationError,
} from './runtimeConfig.js';

const environment = {
  APP_ENV: 'test',
  APP_HOST: '0.0.0.0',
  APP_MODE: 'worker',
  APP_PORT: '4100',
  DATABASE_SSL_MODE: 'disable',
  TEST_DATABASE_URL:
    'postgresql://postgres:postgres@127.0.0.1:54324/poe_worksmith_test',
};

describe('runtime configuration', () => {
  it('loads modes and safe runtime defaults', () => {
    const config = loadRuntimeConfig(environment);

    expect(config).toMatchObject({
      cleanupCron: '15 2 * * *',
      host: '0.0.0.0',
      jobLeaseTimeoutMs: 300_000,
      jobSchema: 'pgboss',
      league: 'Mercenaries',
      logLevel: 'info',
      marketConcurrency: 4,
      marketRetryDelayMs: 60_000,
      mode: 'worker',
      poeUserAgent: 'POE-Worksmith/0.0.0 (contact: local-development)',
      port: 4100,
      refreshCron: '0 */4 * * *',
      retentionBatchSize: 500,
      shutdownTimeoutMs: 30_000,
      snapshotTtlMs: 1_800_000,
    });
  });

  it('allows a dedicated entrypoint to override APP_MODE', () => {
    expect(loadRuntimeConfig(environment, 'api').mode).toBe('api');
  });

  it('rejects unsafe schema identifiers', () => {
    expect(() =>
      loadRuntimeConfig({ ...environment, PG_BOSS_SCHEMA: 'pgboss; drop' }),
    ).toThrow(RuntimeConfigurationError);
  });

  it('selects components for all supported modes', () => {
    expect(modeIncludesApi('api')).toBe(true);
    expect(modeIncludesApi('worker')).toBe(false);
    expect(modeIncludesWorker('worker')).toBe(true);
    expect(modeIncludesWorker('api')).toBe(false);
    expect(modeIncludesApi('all') && modeIncludesWorker('all')).toBe(true);
  });
});
