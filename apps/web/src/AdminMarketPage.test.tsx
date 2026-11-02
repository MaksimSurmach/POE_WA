import type {
  MarketAdminRun,
  MarketAdminSettings,
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
  settingsChanges,
  validateSettings,
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

const settings: MarketAdminSettings = {
  automaticRefreshEnabled: true,
  scheduledCollectionEnabled: true,
  collectionsPaused: false,
  manualRefreshEnabled: true,
  refreshCron: '0 */4 * * *',
  requestTimeoutMs: 15_000,
  collectionConcurrency: 4,
  snapshotReuseTtlMs: 30 * 60_000,
  freshnessWarningMs: 15 * 60_000,
  maximumQuoteAgeMs: 30 * 60_000,
  rawRetentionHours: 72,
  historyRetentionDays: 14,
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

  it('describes a terminal skipped run without a duration as finished and keeps technical details', () => {
    const html = renderToStaticMarkup(
      <MarketRunHistory
        runs={[
          {
            ...run,
            status: 'skipped',
            startedAt: null,
            finishedAt: '2026-11-02T12:00:01.000Z',
            durationMs: null,
            errorCode: 'MARKET_COLLECTION_PAUSED',
          },
        ]}
        busy={false}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Finished · duration unavailable');
    expect(html).toContain('Skipped because collections are paused.');
    expect(html).toContain('MARKET_COLLECTION_PAUSED');
    expect(html).not.toContain('Not finished');
    expect(html).not.toContain('In progress');
    expect(html).not.toContain('<progress');
    expect(html).not.toContain('<button');
  });

  it.each([
    ['AUTH_REQUIRED', 'Access required'],
    ['UNAVAILABLE', 'Unavailable'],
    ['RATE_LIMITED', 'Rate limited'],
    ['DISABLED', 'Disabled'],
    ['OK', 'Last fetch succeeded'],
  ])(
    'names the observed %s source state without claiming current availability',
    (sourceStatus, label) => {
      const html = renderToStaticMarkup(
        <MarketConnectionStatus
          status={{
            ...status,
            trade: { ...status.trade, status: sourceStatus },
            ninja: { configured: true, status: 'OK', cooldownUntil: null },
            worker: { ...status.worker, healthy: true },
          }}
        />,
      );
      expect(html).toContain(`Trade: ${label}`);
      expect(html).toContain('poe.ninja: Last fetch succeeded');
      expect(html).toContain('Healthy / Unavailable');
      expect(html).not.toContain('Healthy / Healthy');
    },
  );

  it('uses native indeterminate progress until query planning supplies a total', () => {
    const unknown = renderToStaticMarkup(
      <MarketRunHistory
        runs={[
          { ...run, totalQueries: 0, completedQueries: 0, failedQueries: 0 },
        ]}
        busy={false}
        onCancel={() => {}}
      />,
    );
    const planned = renderToStaticMarkup(
      <MarketRunHistory runs={[run]} busy={false} onCancel={() => {}} />,
    );
    expect(unknown).toContain(
      '<progress aria-label="Refresh query progress"></progress>',
    );
    expect(planned).toContain('max="7" value="3"');
    expect(planned).toContain(
      'Provider rate limit reached. Wait for the recorded cooldown before retrying.',
    );
    expect(planned).toContain('PROVIDER_RATE_LIMITED');
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
        code === 409 ? 'Check recent runs' : 'local connection',
      );
      const [, options] = fetcher.mock.calls[0] ?? [];
      expect(JSON.stringify(options)).not.toContain('authorization');
    },
  );

  it('distinguishes settings conflicts from run conflicts while preserving edit recovery guidance', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('', { status: 409 }),
    );
    const client = createAdminMarketClient(fetcher);
    await expect(client.save(4, { requestTimeoutMs: 12_000 })).rejects.toThrow(
      'Compare latest settings, then retry; your edits will be preserved.',
    );
    await expect(client.pause(true, 4)).rejects.toThrow(
      'Settings changed elsewhere.',
    );
    await expect(client.refresh({ scope: 'economy' })).rejects.toThrow(
      'Check recent runs before retrying.',
    );
  });

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

describe('market settings edits', () => {
  it('returns only changed values, leaving unchanged settings out of PATCH payloads', () => {
    expect(settingsChanges(settings, { ...settings })).toEqual({});
    expect(
      settingsChanges(settings, {
        ...settings,
        requestTimeoutMs: 12_000,
        rawRetentionHours: 96,
      }),
    ).toEqual({ requestTimeoutMs: 12_000, rawRetentionHours: 96 });
  });

  it('rebases local edits over independently updated pause, schedule and retention values', () => {
    const draft = { ...settings, requestTimeoutMs: 12_000 };
    const latest = {
      ...settings,
      collectionsPaused: true,
      refreshCron: '0 */6 * * *',
      rawRetentionHours: 96,
    };
    const rebased = { ...latest, ...settingsChanges(settings, draft) };
    expect(rebased).toMatchObject({
      requestTimeoutMs: 12_000,
      collectionsPaused: true,
      refreshCron: '0 */6 * * *',
      rawRetentionHours: 96,
    });
    expect(settingsChanges(latest, rebased)).toEqual({
      requestTimeoutMs: 12_000,
    });
    expect(settings).toMatchObject({
      requestTimeoutMs: 15_000,
      collectionsPaused: false,
      rawRetentionHours: 72,
    });
  });

  it('keeps an empty numeric edit dirty and invalid instead of throwing while comparing it', () => {
    const draft = { ...settings, requestTimeoutMs: Number.NaN };
    expect(() => settingsChanges(settings, draft)).not.toThrow();
    expect(settingsChanges(settings, draft)).toEqual({
      requestTimeoutMs: Number.NaN,
    });
    expect(validateSettings(draft)).toMatchObject({
      requestTimeoutMs: expect.any(String),
    });
  });

  it('accepts valid defaults and equality at the freshness and history boundaries', () => {
    expect(validateSettings(settings)).toEqual({});
    expect(
      validateSettings({
        ...settings,
        snapshotReuseTtlMs: settings.maximumQuoteAgeMs,
        freshnessWarningMs: settings.maximumQuoteAgeMs,
        rawRetentionHours: settings.historyRetentionDays * 24,
      }),
    ).toEqual({});
  });

  it.each([
    [{ snapshotReuseTtlMs: 31 * 60_000 }, 'snapshotReuseTtlMs'],
    [{ freshnessWarningMs: 31 * 60_000 }, 'freshnessWarningMs'],
    [
      { rawRetentionHours: 15 * 24, historyRetentionDays: 14 },
      'historyRetentionDays',
    ],
    [{ requestTimeoutMs: 999 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: 30_001 }, 'requestTimeoutMs'],
    [{ collectionConcurrency: 5 }, 'collectionConcurrency'],
    [{ rawRetentionHours: 23 }, 'rawRetentionHours'],
    [{ historyRetentionDays: 731 }, 'historyRetentionDays'],
    [{ maximumQuoteAgeMs: 59_999 }, 'maximumQuoteAgeMs'],
    [{ snapshotReuseTtlMs: 999 }, 'snapshotReuseTtlMs'],
    [{ freshnessWarningMs: 59_999 }, 'freshnessWarningMs'],
  ])('identifies the field to correct for %j', (changes, field) => {
    expect(validateSettings({ ...settings, ...changes })[field]).toEqual(
      expect.any(String),
    );
  });

  it.each(['0 */4 * *', '0 0 */4 * * *'])(
    'identifies an incorrect cron field count: %s',
    (refreshCron) => {
      expect(
        validateSettings({ ...settings, refreshCron }).refreshCron,
      ).toEqual(expect.any(String));
    },
  );
});
