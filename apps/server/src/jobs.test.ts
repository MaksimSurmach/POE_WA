import type { PgBoss } from 'pg-boss';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { PgBossJobRunner, TEST_JOB_QUEUE, TEST_SCHEDULE_KEY } from './jobs.js';

function fakeBoss() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
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
