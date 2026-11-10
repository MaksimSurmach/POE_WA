import { describe, expect, it } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import { defaultAdminSettings, validateAdminSettings } from './marketAdmin.js';

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
      jobLeaseTimeoutMs: 1_200_000,
      jobSchema: 'pgboss',
      leagueResolveCron: '0 23 * * *',
      leagueResolveTimezone: 'Europe/Warsaw',
      logLevel: 'info',
      marketConcurrency: 4,
      marketRetryDelayMs: 60_000,
      mode: 'worker',
      pipeline: 'legacy',
      poeUserAgent: 'OAuth poe-worksmith/0.0.0 (contact: local-development)',
      poeRequestTimeoutMs: 15_000,
      port: 4100,
      refreshCron: '0 * * * *',
      refreshTimezone: 'UTC',
      retentionBatchSize: 500,
      shutdownTimeoutMs: 30_000,
      snapshotTtlMs: 1_800_000,
    });
  });

  it('keeps a 45-minute catalog refresh usable through the next hourly interval without extending reuse', () => {
    const config = loadRuntimeConfig(environment);
    const settings = defaultAdminSettings({
      refreshCron: config.refreshCron,
      requestTimeoutMs: config.poeRequestTimeoutMs,
      concurrency: config.marketConcurrency,
      snapshotTtlMs: config.snapshotTtlMs,
    });
    expect(settings).toMatchObject({
      refreshCron: '0 * * * *',
      snapshotReuseTtlMs: 30 * 60_000,
      freshnessWarningMs: 60 * 60_000,
      maximumQuoteAgeMs: 2 * 60 * 60_000,
    });
    const schedule = CronExpressionParser.parse(settings.refreshCron, {
      tz: 'UTC',
      currentDate: new Date('2026-11-03T00:00:00Z'),
    });
    const first = schedule.next().getTime();
    const interval = schedule.next().getTime() - first;
    expect(interval).toBe(60 * 60_000);
    expect(45 * 60_000 + interval).toBeLessThan(settings.maximumQuoteAgeMs);
    expect(settings.snapshotReuseTtlMs).toBeLessThan(45 * 60_000);
    expect(validateAdminSettings(settings, 'UTC')).toEqual(settings);
  });

  it('allows a dedicated entrypoint to override APP_MODE', () => {
    expect(loadRuntimeConfig(environment, 'api').mode).toBe('api');
  });

  it('loads collector mode without enabling the API or legacy worker', () => {
    const { mode, pipeline } = loadRuntimeConfig({
      ...environment,
      APP_MODE: 'collector',
      PIPELINE: 'collector',
    });
    expect(mode).toBe('collector');
    expect(pipeline).toBe('collector');
    expect(modeIncludesApi(mode)).toBe(false);
    expect(modeIncludesWorker(mode)).toBe(false);
  });

  it('rejects unsafe schema identifiers', () => {
    expect(() =>
      loadRuntimeConfig({ ...environment, PG_BOSS_SCHEMA: 'pgboss; drop' }),
    ).toThrow(RuntimeConfigurationError);
  });

  it('requires GGG-compliant OAuth user-agent identification', () => {
    expect(() =>
      loadRuntimeConfig({ ...environment, POE_USER_AGENT: 'anonymous-client' }),
    ).toThrow(RuntimeConfigurationError);
  });

  it('rejects invalid refresh cron and timezone values', () => {
    expect(() =>
      loadRuntimeConfig({ ...environment, REFRESH_CRON: 'wrong' }),
    ).toThrow(RuntimeConfigurationError);
    expect(() =>
      loadRuntimeConfig({ ...environment, REFRESH_TIMEZONE: 'Mars/Olympus' }),
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
