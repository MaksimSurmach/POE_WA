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
      host: '0.0.0.0',
      jobSchema: 'pgboss',
      logLevel: 'info',
      mode: 'worker',
      port: 4100,
      shutdownTimeoutMs: 30_000,
      testCron: '* * * * *',
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
