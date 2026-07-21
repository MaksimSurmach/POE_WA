import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  CATALOG_REFRESH_QUEUE,
  CATALOG_REFRESH_SCHEDULE_KEY,
  createJobBoss,
  ensureCatalogSchedules,
  ensureTestSchedule,
  TEST_JOB_QUEUE,
  TEST_SCHEDULE_KEY,
} from './jobs.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);
const boss = createJobBoss(pool, 'pgboss_test', pino({ level: 'silent' }));
const secondBoss = createJobBoss(
  pool,
  'pgboss_test',
  pino({ level: 'silent' }),
);
const dedupeQueue = 'system.integration-dedupe';

afterAll(async () => {
  await Promise.all([
    boss.stop({ close: false, graceful: true }),
    secondBoss.stop({ close: false, graceful: true }),
  ]);
  await pool.query('drop schema if exists pgboss_test cascade');
  await pool.end();
});

describe('pg-boss scheduler integration', () => {
  it('normalizes multi-statement monitor query results from pg', async () => {
    await boss.start();

    await expect(
      boss.getDb().executeSql('select 1 as ignored; select 2 as value'),
    ).resolves.toEqual({ rows: [{ value: 2 }] });
  });

  it('upserts a singleton schedule and deduplicates its jobs', async () => {
    await boss.start();
    await ensureTestSchedule(boss, '* * * * *');
    await ensureTestSchedule(boss, '* * * * *');

    const schedules = await boss.getSchedules(
      TEST_JOB_QUEUE,
      TEST_SCHEDULE_KEY,
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      cron: '* * * * *',
      key: TEST_SCHEDULE_KEY,
      name: TEST_JOB_QUEUE,
      options: {
        singletonKey: 'scheduled-test-job',
        singletonSeconds: 60,
      },
    });

    await boss.createQueue(dedupeQueue, { policy: 'exclusive' });
    const first = await boss.send(
      dedupeQueue,
      { source: 'integration-test' },
      { singletonKey: 'integration-test', singletonSeconds: 60 },
    );
    const duplicate = await boss.send(
      dedupeQueue,
      { source: 'integration-test' },
      { singletonKey: 'integration-test', singletonSeconds: 60 },
    );
    expect(first).toBeTypeOf('string');
    expect(duplicate).toBeNull();
  });

  it('keeps one full-refresh schedule and cycle across scheduler instances', async () => {
    await Promise.all([boss.start(), secondBoss.start()]);
    const schedules = {
      cleanupCron: '15 2 * * *',
      refreshCron: '0 */4 * * *',
    };
    await Promise.all([
      ensureCatalogSchedules(boss, schedules),
      ensureCatalogSchedules(secondBoss, schedules),
    ]);

    expect(
      await boss.getSchedules(
        CATALOG_REFRESH_QUEUE,
        CATALOG_REFRESH_SCHEDULE_KEY,
      ),
    ).toHaveLength(1);
    const first = await boss.send(
      CATALOG_REFRESH_QUEUE,
      { source: 'manual' },
      { singletonKey: 'catalog-refresh', singletonSeconds: 60 },
    );
    const duplicate = await secondBoss.send(
      CATALOG_REFRESH_QUEUE,
      { source: 'manual' },
      { singletonKey: 'catalog-refresh', singletonSeconds: 60 },
    );
    expect(first).toBeTypeOf('string');
    expect(duplicate).toBeNull();
  });

  it('processes a queued job after the worker starts', async () => {
    await boss.start();
    await ensureTestSchedule(boss, '* * * * *');
    const processed = new Promise<void>((resolve) => {
      void boss.work(TEST_JOB_QUEUE, async (jobs) => {
        expect(jobs).toHaveLength(1);
        resolve();
      });
    });

    await boss.send(TEST_JOB_QUEUE, { source: 'scheduler' });

    await expect(processed).resolves.toBeUndefined();
  });
});
