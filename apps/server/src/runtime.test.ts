import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { ApplicationRuntime } from './runtime.js';

describe('application runtime', () => {
  it('starts and stops API and worker together in lifecycle order', async () => {
    const order: string[] = [];
    const api = {
      close: vi.fn(async () => {
        order.push('api:stop');
      }),
      listen: vi.fn(async () => {
        order.push('api:start');
        return 'http://127.0.0.1:3000';
      }),
    };
    const jobs = {
      start: vi.fn(async () => {
        order.push('jobs:start');
      }),
      stop: vi.fn(async () => {
        order.push('jobs:stop');
      }),
    };
    const pool = {
      end: vi.fn(async () => {
        order.push('pool:stop');
      }),
    };
    const runtime = new ApplicationRuntime({
      api,
      host: '127.0.0.1',
      jobs,
      logger: pino({ level: 'silent' }),
      mode: 'all',
      pool,
      port: 3000,
      shutdownTimeoutMs: 5000,
    });

    await runtime.start();
    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(order).toEqual([
      'jobs:start',
      'api:start',
      'api:stop',
      'jobs:stop',
      'pool:stop',
    ]);
    expect(api.close).toHaveBeenCalledOnce();
    expect(jobs.stop).toHaveBeenCalledWith(5000);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('runs API and worker independently', async () => {
    const api = {
      close: vi.fn(async () => undefined),
      listen: vi.fn(async () => undefined),
    };
    const jobs = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const pool = { end: vi.fn(async () => undefined) };
    const logger = pino({ level: 'silent' });

    const apiRuntime = new ApplicationRuntime({
      api,
      host: '127.0.0.1',
      logger,
      mode: 'api',
      pool,
      port: 3000,
      shutdownTimeoutMs: 5000,
    });
    await apiRuntime.start();
    await apiRuntime.stop();
    expect(api.listen).toHaveBeenCalledOnce();
    expect(jobs.start).not.toHaveBeenCalled();

    const workerPool = { end: vi.fn(async () => undefined) };
    const workerRuntime = new ApplicationRuntime({
      host: '127.0.0.1',
      jobs,
      logger,
      mode: 'worker',
      pool: workerPool,
      port: 3000,
      shutdownTimeoutMs: 5000,
    });
    await workerRuntime.start();
    await workerRuntime.stop();
    expect(jobs.start).toHaveBeenCalledOnce();
    expect(workerPool.end).toHaveBeenCalledOnce();
  });

  it('waits for graceful job shutdown before closing the pool', async () => {
    let finishJobs: (() => void) | undefined;
    const jobsStopped = new Promise<void>((resolve) => {
      finishJobs = resolve;
    });
    const jobs = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => jobsStopped),
    };
    const pool = { end: vi.fn(async () => undefined) };
    const runtime = new ApplicationRuntime({
      host: '127.0.0.1',
      jobs,
      logger: pino({ level: 'silent' }),
      mode: 'worker',
      pool,
      port: 3000,
      shutdownTimeoutMs: 5000,
    });
    await runtime.start();

    const stopping = runtime.stop();
    await Promise.resolve();
    expect(pool.end).not.toHaveBeenCalled();
    finishJobs?.();
    await stopping;

    expect(pool.end).toHaveBeenCalledOnce();
  });
});
