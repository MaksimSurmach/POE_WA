import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  createJobBoss,
  ensureTestSchedule,
  TEST_JOB_QUEUE,
  TEST_SCHEDULE_KEY,
} from './jobs.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);
const boss = createJobBoss(pool, 'pgboss_test', pino({ level: 'silent' }));
const dedupeQueue = 'system.integration-dedupe';

afterAll(async () => {
  await boss.stop({ close: false, graceful: true });
  await pool.query('drop schema if exists pgboss_test cascade');
  await pool.end();
});

describe('pg-boss scheduler integration', () => {
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
});
