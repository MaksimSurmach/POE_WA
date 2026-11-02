import type {
  MarketAdminRun,
  MarketAdminStatus,
} from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import {
  createAdminMarketClient,
  MarketConnectionStatus,
  MarketRunHistory,
} from './AdminMarketPage.js';

const run: MarketAdminRun = {
  id: '00000000-0000-4000-8000-000000000001',
  scope: 'all',
  recipeId: null,
  source: 'manual',
  status: 'running',
  requestedAt: '2026-11-02T12:00:00.000Z',
  startedAt: '2026-11-02T12:00:01.000Z',
  finishedAt: null,
  cancelRequested: false,
  errorCode: 'PROVIDER_RATE_LIMITED',
  durationMs: null,
  completedQueries: 2,
  failedQueries: 1,
  totalQueries: 7,
  sourceFreshness: null,
};

const status: MarketAdminStatus = {
  serverTime: '2026-11-02T12:00:00.000Z',
  access: 'local-only',
  league: { name: 'Allflame', confirmed: false },
  trade: {
    configured: true,
    status: 'AUTH_REQUIRED',
    reason: 'Source access denied',
  },
  ninja: { configured: false, status: 'UNAVAILABLE', cooldownUntil: null },
  worker: { healthy: false, heartbeatAt: null, settingsVersion: null },
  scheduler: {
    healthy: false,
    enabled: false,
    cron: '0 */4 * * *',
    nextRefreshAt: null,
  },
  activeRun: run,
  lastSuccessful: null,
  lastFailed: null,
  collection: { paused: true, scheduled: false, manualAvailable: false },
  coverage: {
    activeRecipes: 2,
    pricedRecipes: 2,
    freshRecipes: 0,
    warningRecipes: 0,
    latestSnapshotAt: null,
  },
  rateLimits: [],
  warnings: [],
};

describe('market administration', () => {
  it('mounts its own route without changing the handbook', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/admin/market']}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain('Market administration');
    expect(html).toContain('Loading market controls');
    expect(html).not.toContain('Refresh Prices');
    expect(html).not.toContain('token"');
  });

  it('shows unavailable workers, unconfirmed league and active query progress truthfully', () => {
    const html = renderToStaticMarkup(
      <MarketConnectionStatus status={status} />,
    );
    expect(html).toContain('Allflame · Last known / unconfirmed');
    expect(html).toContain('Source access denied');
    expect(html).toContain('Unavailable / Unavailable');
    expect(html).toContain('Automatic refresh disabled');
    expect(html).toContain('0/2 fresh');
    expect(html).toContain('running · 3/7 queries');
  });

  it('exposes cancellation only while active and keeps error details visible', () => {
    const running = renderToStaticMarkup(
      <MarketRunHistory runs={[run]} busy={false} onCancel={() => {}} />,
    );
    const cancelled = renderToStaticMarkup(
      <MarketRunHistory
        runs={[{ ...run, status: 'cancelled', cancelRequested: true }]}
        busy={false}
        onCancel={() => {}}
      />,
    );
    expect(running).toContain('Cancel run');
    expect(running).toContain('PROVIDER_RATE_LIMITED');
    expect(running).toContain('2/7 queries complete · 1 failed');
    expect(cancelled).not.toContain('<button');
    expect(cancelled).toContain('Cancellation requested');
  });

  it('validates status data and fails closed on a malformed response', async () => {
    const valid = createAdminMarketClient(
      vi.fn(async () => Response.json({ correlationId: 'test', data: status })),
    );
    await expect(valid.status()).resolves.toEqual(status);
    const invalid = createAdminMarketClient(
      vi.fn(async () => Response.json({ data: { ...status, worker: {} } })),
    );
    await expect(invalid.status()).rejects.toThrow('invalid response');
  });

  it.each([401, 403, 409])(
    'reports %s without requesting browser credentials',
    async (code) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response('', { status: code }),
      );
      const client = createAdminMarketClient(fetcher);
      await expect(client.status()).rejects.toThrow(
        code === 409 ? 'Reload settings' : 'local connection',
      );
      const [, options] = fetcher.mock.calls[0] ?? [];
      expect(JSON.stringify(options)).not.toContain('authorization');
    },
  );

  it('sends one bounded refresh or cancellation request using JSON and same-origin credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { accepted: true } }),
    );
    const client = createAdminMarketClient(fetcher);
    await client.refresh({ scope: 'recipe', recipeId: 'physical-cluster' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/market/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ scope: 'recipe', recipeId: 'physical-cluster' }),
      }),
    );
    await client.cancel(run.id);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/admin/market/runs/${run.id}/cancel`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});
