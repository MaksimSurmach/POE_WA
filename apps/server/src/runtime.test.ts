import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { ApplicationRuntime } from './runtime.js';

const logger = pino({ level: 'silent' });

it('waits for HTTP shutdown before closing PostgreSQL once', async () => {
  let finishHttp!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishHttp = resolve;
  });
  const api = {
    listen: vi.fn(async () => undefined),
    close: vi.fn(() => closed),
  };
  const pool = { end: vi.fn(async () => undefined) };
  const runtime = new ApplicationRuntime({
    api,
    host: '127.0.0.1',
    port: 3000,
    pool,
    logger,
  });
  await runtime.start();
  const stopping = runtime.stop();
  expect(runtime.stop()).toBe(stopping);
  expect(pool.end).not.toHaveBeenCalled();
  finishHttp();
  await stopping;
  expect(api.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
  expect(api.close).toHaveBeenCalledOnce();
  expect(pool.end).toHaveBeenCalledOnce();
});

it('cleans up the API and database pool when listening fails', async () => {
  const failure = new Error('port unavailable');
  const api = {
    listen: vi.fn().mockRejectedValue(failure),
    close: vi.fn(async () => undefined),
  };
  const pool = { end: vi.fn(async () => undefined) };
  const runtime = new ApplicationRuntime({
    api,
    host: '127.0.0.1',
    port: 3000,
    pool,
    logger,
  });
  await expect(runtime.start()).rejects.toBe(failure);
  await runtime.stop();
  expect(api.close).toHaveBeenCalledOnce();
  expect(pool.end).toHaveBeenCalledOnce();
});
