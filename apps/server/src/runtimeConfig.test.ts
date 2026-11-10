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
  APP_MODE: 'api',
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
      leagueResolveCron: '0 23 * * *',
      leagueResolveTimezone: 'Europe/Warsaw',
      logLevel: 'info',
      marketConcurrency: 4,
      marketRetryDelayMs: 60_000,
      mode: 'api',
      pipeline: 'collector',
      poeUserAgent: 'OAuth poe-worksmith/0.0.0 (contact: local-development)',
      poeRequestTimeoutMs: 15_000,
      port: 4100,
      refreshCron: '0 * * * *',
      refreshTimezone: 'UTC',
      retentionBatchSize: 500,
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
    const stale = { ...environment, APP_MODE: 'all' };
    expect(loadRuntimeConfig(stale, 'api').mode).toBe('api');
    expect(loadRuntimeConfig(stale, 'collector').mode).toBe('collector');
  });

  it('defaults to the API and rejects the retired worker modes', () => {
    expect(
      loadRuntimeConfig({ ...environment, APP_MODE: undefined }).mode,
    ).toBe('api');
    for (const mode of ['all', 'worker'] as const) {
      const retired = `Mode '${mode}' was retired`;
      expect(() =>
        loadRuntimeConfig({ ...environment, APP_MODE: mode }),
      ).toThrow(retired);
      expect(() => loadRuntimeConfig(environment, mode)).toThrow(retired);
    }
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

  it.each([
    'ep-test-pooler.eu-central-1.aws.neon.tech/worksmith',
    'ep-test%2dpooler.eu-central-1.aws.neon.tech/worksmith',
    'localhost/worksmith?host=ep-test-pooler.eu-central-1.aws.neon.tech',
  ])('allows a pooled Neon URL only outside collector mode (%s)', (target) => {
    const pooled = {
      ...environment,
      TEST_DATABASE_URL: `postgresql://user:password@${target}`,
    };
    expect(loadRuntimeConfig(pooled, 'api').mode).toBe('api');
    expect(() => loadRuntimeConfig(pooled, 'collector')).toThrow(
      'Collector requires a direct PostgreSQL endpoint',
    );
  });

  it('preserves collector retention unless explicitly disabled', () => {
    expect(
      loadRuntimeConfig(environment, 'collector').collectorRetentionEnabled,
    ).toBe(true);
    expect(
      loadRuntimeConfig(
        {
          ...environment,
          COLLECTOR_RETENTION_ENABLED: 'false',
        },
        'collector',
      ).collectorRetentionEnabled,
    ).toBe(false);
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
