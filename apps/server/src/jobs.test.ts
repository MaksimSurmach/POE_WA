import type { PgBoss } from 'pg-boss';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  CatalogRefreshScheduler,
  CATALOG_CLEANUP_QUEUE,
  CATALOG_REFRESH_QUEUE,
  CATALOG_REFRESH_SCHEDULE_KEY,
  PgBossJobRunner,
  TEST_JOB_QUEUE,
  TEST_SCHEDULE_KEY,
} from './jobs.js';

function fakeBoss() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('manual-cycle-id'),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue('worker-id'),
  };
}

describe('pg-boss job runner', () => {
  it('registers one keyed cron schedule and one worker', async () => {
    const fake = fakeBoss();
    const runner = new PgBossJobRunner(
      fake as unknown as PgBoss,
      '* * * * *',
      pino({ level: 'silent' }),
    );

    await runner.start();
    await runner.start();

    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.createQueue).toHaveBeenCalledWith(
      TEST_JOB_QUEUE,
      expect.objectContaining({ policy: 'exclusive' }),
    );
    expect(fake.schedule).toHaveBeenCalledWith(
      TEST_JOB_QUEUE,
      '* * * * *',
      { source: 'scheduler' },
      expect.objectContaining({
        key: TEST_SCHEDULE_KEY,
        singletonKey: 'scheduled-test-job',
        singletonSeconds: 60,
      }),
    );
    expect(fake.work).toHaveBeenCalledOnce();
  });

  it('requests graceful worker shutdown before releasing the shared pool', async () => {
    const fake = fakeBoss();
    const runner = new PgBossJobRunner(
      fake as unknown as PgBoss,
      '* * * * *',
      pino({ level: 'silent' }),
    );
    await runner.start();

    await runner.stop(12_000);

    expect(fake.stop).toHaveBeenCalledWith({
      close: false,
      graceful: true,
      timeout: 12_000,
    });
  });

  it('cleans up a partially failed queue start', async () => {
    const fake = fakeBoss();
    fake.start.mockRejectedValueOnce(new Error('startup failed'));
    const runner = new PgBossJobRunner(
      fake as unknown as PgBoss,
      '* * * * *',
      pino({ level: 'silent' }),
    );

    await expect(runner.start()).rejects.toThrow('startup failed');
    expect(fake.stop).toHaveBeenCalledWith({
      close: false,
      graceful: false,
    });
  });
});

describe('catalog refresh scheduler', () => {
  it('registers exclusive refresh and cleanup schedules with stable keys', async () => {
    const fake = fakeBoss();
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
    });

    await scheduler.start();
    await scheduler.start();

    expect(fake.createQueue).toHaveBeenCalledWith(
      CATALOG_REFRESH_QUEUE,
      expect.objectContaining({ policy: 'exclusive' }),
    );
    expect(fake.createQueue).toHaveBeenCalledWith(
      CATALOG_CLEANUP_QUEUE,
      expect.objectContaining({ policy: 'exclusive' }),
    );
    expect(fake.schedule).toHaveBeenCalledWith(
      CATALOG_REFRESH_QUEUE,
      '0 */4 * * *',
      { source: 'scheduler' },
      expect.objectContaining({
        key: CATALOG_REFRESH_SCHEDULE_KEY,
        singletonKey: 'catalog-refresh',
      }),
    );
    expect(fake.work).toHaveBeenCalledTimes(2);
  });

  it('supports a singleton manual refresh trigger', async () => {
    const fake = fakeBoss();
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
    });

    await expect(scheduler.triggerRefresh()).resolves.toBe('manual-cycle-id');
    expect(fake.send).toHaveBeenCalledWith(
      CATALOG_REFRESH_QUEUE,
      { source: 'manual' },
      expect.objectContaining({ singletonKey: 'catalog-refresh' }),
    );
  });
});
