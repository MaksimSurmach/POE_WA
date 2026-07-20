import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildApi } from './api.js';

describe('health API', () => {
  it('reports liveness without external dependencies', async () => {
    const api = buildApi(pino({ level: 'silent' }), vi.fn());

    const response = await api.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await api.close();
  });

  it('reports database readiness and failure', async () => {
    const readyApi = buildApi(pino({ level: 'silent' }), vi.fn());
    const unavailableApi = buildApi(pino({ level: 'silent' }), async () => {
      throw new Error('unavailable');
    });

    const ready = await readyApi.inject({
      method: 'GET',
      url: '/health/ready',
    });
    const unavailable = await unavailableApi.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: 'not_ready' });
    await Promise.all([readyApi.close(), unavailableApi.close()]);
  });
});
