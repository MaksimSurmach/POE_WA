import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  CatalogRefreshScheduler,
  CATALOG_CLEANUP_QUEUE,
  CATALOG_REFRESH_QUEUE,
  CATALOG_REFRESH_SCHEDULE_KEY,
  createJobBoss,
  ManualRefreshProducer,
  LEAGUE_RESOLVE_QUEUE,
  LEAGUE_RESOLVE_SCHEDULE_KEY,
  PgBossJobRunner,
  TEST_JOB_QUEUE,
  TEST_SCHEDULE_KEY,
} from './jobs.js';

function fakeBoss() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    getSchedules: vi
      .fn<() => Promise<Array<{ cron: string; timezone: string }>>>()
      .mockResolvedValue([]),
    unschedule: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('manual-cycle-id'),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    work: vi
      .fn<
        (
          name: string,
          options: unknown,
          handler: (jobs: unknown[]) => Promise<unknown>,
        ) => Promise<string>
      >()
      .mockResolvedValue('worker-id'),
  };
}

describe('pg-boss job runner', () => {
  it('reports pg-boss errors to the runtime health signal', () => {
    const onError = vi.fn();
    const boss = createJobBoss(
      { query: vi.fn() } as unknown as Pool,
      'pgboss_test',
      pino({ level: 'silent' }),
      onError,
    );
    const error = new Error('monitor failed');

    boss.emit('error', error);

    expect(onError).toHaveBeenCalledWith(error);
  });

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
  it('unschedules disabled automatic refresh and stops its control timer', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    fake.getSchedules.mockResolvedValue([
      { cron: '0 */4 * * *', timezone: 'UTC' },
    ]);
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
      control: {
        readSchedule: async () => ({
          enabled: false,
          cron: '0 */4 * * *',
          timezone: 'UTC',
        }),
        heartbeat,
      },
    });
    try {
      await scheduler.start();
      expect(fake.unschedule).toHaveBeenCalledWith(
        CATALOG_REFRESH_QUEUE,
        CATALOG_REFRESH_SCHEDULE_KEY,
      );
      expect(heartbeat).toHaveBeenCalledOnce();
      await scheduler.stop(1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scheduler.stop(1000);
      vi.useRealTimers();
    }
  });

  it('keeps unchanged schedules intact and applies a changed cron on the next reconciliation', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    fake.getSchedules.mockResolvedValue([
      { cron: '0 */4 * * *', timezone: 'UTC' },
    ]);
    const readSchedule = vi.fn().mockResolvedValue({
      enabled: true,
      cron: '0 */4 * * *',
      timezone: 'UTC',
    });
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
      control: { readSchedule, heartbeat },
    });
    try {
      await scheduler.start();
      fake.schedule.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fake.schedule).not.toHaveBeenCalled();
      expect(heartbeat).toHaveBeenCalledTimes(2);
      readSchedule.mockResolvedValue({
        enabled: true,
        cron: '0 * * * *',
        timezone: 'UTC',
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(fake.schedule).toHaveBeenCalledWith(
        CATALOG_REFRESH_QUEUE,
        '0 * * * *',
        { source: 'scheduler' },
        expect.objectContaining({
          key: CATALOG_REFRESH_SCHEDULE_KEY,
          tz: 'UTC',
        }),
      );
      expect(heartbeat).toHaveBeenCalledTimes(3);
    } finally {
      await scheduler.stop(1000);
      vi.useRealTimers();
    }
  });

  it('waits for in-flight control reconciliation before stopping pg-boss', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    const heartbeat = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
      control: {
        readSchedule: async () => ({
          enabled: false,
          cron: '0 */4 * * *',
          timezone: 'UTC',
        }),
        heartbeat,
      },
    });
    try {
      await scheduler.start();
      heartbeat.mockReturnValueOnce(pending);
      await vi.advanceTimersByTimeAsync(5000);
      const stopping = scheduler.stop(1000);
      await Promise.resolve();
      expect(fake.stop).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(fake.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await scheduler.stop(1000);
      vi.useRealTimers();
    }
  });

  it('forwards the pg-boss abort signal and refresh scope to the worker', async () => {
    const fake = fakeBoss();
    const runRefresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh,
    });
    await scheduler.start();
    try {
      const handler = fake.work.mock.calls.find(
        ([name]) => name === CATALOG_REFRESH_QUEUE,
      )?.[2];
      if (!handler) throw new Error('Expected a refresh worker');
      const signal = new AbortController().signal;
      const data = {
        source: 'manual',
        scope: 'recipe',
        recipeId: 'selected-recipe',
      };
      await handler([{ id: 'refresh-job', data, signal }]);
      expect(runRefresh).toHaveBeenCalledWith('refresh-job', data, signal);
    } finally {
      await scheduler.stop(1000);
    }
  });

  it('starts an API-only refresh queue producer and enqueues the shared job', async () => {
    const fake = fakeBoss();
    const producer = new ManualRefreshProducer(fake as unknown as PgBoss);

    await producer.start();
    await expect(producer.triggerRefresh()).resolves.toBe('manual-cycle-id');

    expect(fake.createQueue).toHaveBeenCalledWith(
      CATALOG_REFRESH_QUEUE,
      expect.objectContaining({
        policy: 'exclusive',
        expireInSeconds: 2 * 60 * 60,
      }),
    );
    expect(fake.send).toHaveBeenCalledWith(
      CATALOG_REFRESH_QUEUE,
      { source: 'manual' },
      expect.objectContaining({ singletonKey: 'catalog-refresh' }),
    );
    await producer.stop(5000);
  });

  it('cleans up a failed API-only producer start', async () => {
    const fake = fakeBoss();
    fake.createQueue.mockRejectedValueOnce(new Error('queue unavailable'));
    const producer = new ManualRefreshProducer(fake as unknown as PgBoss);

    await expect(producer.start()).rejects.toThrow('queue unavailable');
    expect(fake.stop).toHaveBeenCalledWith({
      close: false,
      graceful: false,
    });
  });

  it('registers exclusive refresh and cleanup schedules with stable keys', async () => {
    const fake = fakeBoss();
    const scheduler = new CatalogRefreshScheduler({
      boss: fake as unknown as PgBoss,
      cleanupCron: '15 2 * * *',
      logger: pino({ level: 'silent' }),
      refreshCron: '0 */4 * * *',
      runCleanup: vi.fn(),
      runRefresh: vi.fn(),
      leagueCron: '0 23 * * *',
      leagueTimezone: 'Europe/Warsaw',
      runLeagueResolve: vi.fn(),
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
    expect(fake.schedule).toHaveBeenCalledWith(
      LEAGUE_RESOLVE_QUEUE,
      '0 23 * * *',
      { source: 'scheduler' },
      expect.objectContaining({
        key: LEAGUE_RESOLVE_SCHEDULE_KEY,
        tz: 'Europe/Warsaw',
      }),
    );
    expect(fake.work).toHaveBeenCalledTimes(3);
    expect(fake.send).toHaveBeenCalledWith(
      LEAGUE_RESOLVE_QUEUE,
      { source: 'startup' },
      expect.objectContaining({ singletonKey: 'league-resolve' }),
    );
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
