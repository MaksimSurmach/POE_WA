import { randomUUID } from 'node:crypto';
import { marketAdminSettingsResponseSchema } from '@poe-worksmith/contracts';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApi } from './api.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createMarketAdminStore, defaultAdminSettings } from './marketAdmin.js';
import { marketListingFixture } from './marketListingFixture.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';
import { createMarketCollectionRepository } from './repositories/marketCollectionRepository.js';
import { createMarketResearchRepository } from './repositories/marketResearchRepository.js';

const config = loadDatabaseConfig();
if (
  config.environment !== 'test' ||
  !new URL(config.connectionString).pathname.endsWith('_test')
)
  throw new Error(
    'Market admin integration tests require an isolated test database',
  );
const pool = createDatabasePool(config);
const logger = pino({ level: 'silent' });
const defaults = defaultAdminSettings({
  refreshCron: '0 */4 * * *',
  requestTimeoutMs: 15_000,
  concurrency: 4,
  snapshotTtlMs: 30 * 60_000,
});
const storeOptions = { pool, defaults, timezone: 'UTC', concurrencyLimit: 2 };
const store = createMarketAdminStore(storeOptions);
const local = { host: 'localhost:3000', origin: 'http://localhost:3000' };

const api = buildApi(
  logger,
  async () => {
    await pool.query('select 1');
  },
  async () => ({ active: null, published: null }),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    marketAdmin: { store },
    collectorPool: pool,
  },
);

async function clear() {
  await pool.query(
    'truncate market_admin_settings, market_admin_audit, run_requests restart identity',
  );
  await pool.query(
    'truncate market_collection_runs, market_collection_settings, market_research_snapshots, belt_price_updates, market_targets cascade',
  );
}

beforeEach(async () => {
  await clear();
  await store.init();
});

afterAll(async () => {
  await api.close();
  await clear();
  await pool.end();
});

async function auditRows() {
  return (
    await pool.query<{ action: string; actor: string; details: unknown }>(
      'select action,actor,details from market_admin_audit order by id',
    )
  ).rows;
}
describe('market admin settings and collector API', () => {
  it('caps a long environment TTL at 30-minute initial reuse so unrelated settings and pause/resume remain usable', async () => {
    await pool.query('truncate market_admin_settings');
    const seeded = defaultAdminSettings({
      refreshCron: defaults.refreshCron,
      requestTimeoutMs: 15_000,
      concurrency: 4,
      snapshotTtlMs: 60 * 60_000,
    });
    const seededStore = createMarketAdminStore({
      ...storeOptions,
      defaults: seeded,
    });
    await seededStore.init();
    expect((await seededStore.read()).configured).toMatchObject({
      snapshotReuseTtlMs: 30 * 60_000,
      maximumQuoteAgeMs: 2 * 60 * 60_000,
    });
    await seededStore.patch(
      { version: 0, settings: { requestTimeoutMs: 12_000 } },
      'operator',
    );
    await seededStore.patch(
      { version: 1, settings: { collectionsPaused: true } },
      'operator',
    );
    const resumed = await seededStore.patch(
      { version: 2, settings: { collectionsPaused: false } },
      'operator',
    );
    expect(resumed).toMatchObject({
      version: 3,
      effective: { requestTimeoutMs: 12_000, collectionsPaused: false },
    });
  });

  it('does not replace persisted operator settings when fresh-install defaults change', async () => {
    await store.patch(
      {
        version: 0,
        settings: {
          refreshCron: '0 */4 * * *',
          maximumQuoteAgeMs: 30 * 60_000,
          freshnessWarningMs: 15 * 60_000,
        },
      },
      'operator',
    );
    const before = await store.read();
    const restarted = createMarketAdminStore({
      ...storeOptions,
      defaults: {
        ...defaults,
        refreshCron: '0 * * * *',
        maximumQuoteAgeMs: 2 * 60 * 60_000,
        freshnessWarningMs: 60 * 60_000,
      },
    });
    await restarted.init();
    expect(await restarted.read()).toEqual(before);
  });

  it('rejects inconsistent initial settings before writing them', async () => {
    await pool.query('truncate market_admin_settings');
    const invalid = createMarketAdminStore({
      ...storeOptions,
      defaults: {
        ...defaults,
        snapshotReuseTtlMs: 60 * 60_000,
        maximumQuoteAgeMs: 30 * 60_000,
        freshnessWarningMs: 15 * 60_000,
      },
    });
    await expect(invalid.init()).rejects.toMatchObject({
      code: 'MARKET_QUERY_INVALID',
    });
    expect(
      (await pool.query('select * from market_admin_settings')).rows,
    ).toEqual([]);
  });

  it('exposes configured defaults, deployment caps, TTL mismatch and no browser secrets', async () => {
    const response = await api.inject({
      method: 'GET',
      url: '/api/admin/market/settings',
      headers: local,
    });
    expect(response.statusCode).toBe(200);
    const value = marketAdminSettingsResponseSchema.parse(response.json().data);
    expect(value).toMatchObject({
      version: 0,
      configured: {
        refreshCron: '0 */4 * * *',
        snapshotReuseTtlMs: 1_800_000,
        collectionConcurrency: 4,
      },
      effective: { collectionConcurrency: 2 },
      restartRequired: false,
    });
    expect(value.warnings.join(' ')).toContain(
      'interval exceeds maximum quote age',
    );
    expect(JSON.stringify(value)).not.toMatch(
      /authorization|sessionId|accessToken/,
    );
  });

  it('commits exactly one concurrent versioned PATCH and its audit record', async () => {
    const responses = await Promise.all(
      [10_000, 20_000].map((requestTimeoutMs) =>
        api.inject({
          method: 'PATCH',
          url: '/api/admin/market/settings',
          headers: { ...local, 'x-request-id': `operator-${requestTimeoutMs}` },
          payload: { version: 0, settings: { requestTimeoutMs } },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const current = await store.read();
    expect(current.version).toBe(1);
    expect([10_000, 20_000]).toContain(current.effective.requestTimeoutMs);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'settings.update',
      actor: responses.find((response) => response.statusCode === 200)?.headers[
        'x-request-id'
      ],
    });
    expect(audits[0]?.details).toMatchObject({
      previous: { requestTimeoutMs: 15_000 },
      settings: { requestTimeoutMs: current.effective.requestTimeoutMs },
      version: 1,
    });
  });

  it.each([
    { requestTimeoutMs: 999 },
    { requestTimeoutMs: 30_001 },
    { collectionConcurrency: 5 },
    { rawRetentionHours: 23 },
    { historyRetentionDays: 731 },
    { rawRetentionHours: 90 * 24, historyRetentionDays: 14 },
    { snapshotReuseTtlMs: 3_600_001, maximumQuoteAgeMs: 3_600_000 },
    { maximumQuoteAgeMs: 60_000 },
    { freshnessWarningMs: 3_600_001, maximumQuoteAgeMs: 3_600_000 },
    { refreshCron: '* * * * *' },
    { refreshCron: '0 * * * * *' },
    { refreshCron: 'not a cron' },
    { operatorToken: 'must-not-persist' },
  ])(
    'rejects unsafe settings without changing persisted state: %j',
    async (settings) => {
      const response = await api.inject({
        method: 'PATCH',
        url: '/api/admin/market/settings',
        headers: local,
        payload: { version: 0, settings },
      });
      expect(response.statusCode).toBe(400);
      expect((await store.read()).version).toBe(0);
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('rejects unknown/empty patch structure', async () => {
    for (const payload of [
      { version: 0, settings: {} },
      { version: 0, settings: { requestTimeoutMs: 10_000 }, unknown: true },
    ])
      expect(
        (
          await api.inject({
            method: 'PATCH',
            url: '/api/admin/market/settings',
            headers: local,
            payload,
          })
        ).statusCode,
      ).toBe(400);
  });

  it('reads earlier stored settings and rejects patches for retired controls', async () => {
    const initial = await store.read();
    await pool.query(
      'update market_admin_settings set settings=settings || $1::jsonb where id=1',
      [JSON.stringify({ intelligence: { minIndependentSellers: 4 } })],
    );
    expect((await store.read()).configured).toEqual(initial.configured);
    const response = await api.inject({
      method: 'PATCH',
      url: '/api/admin/market/settings',
      headers: local,
      payload: {
        version: initial.version,
        settings: { requestTimeoutMs: 12000 },
      },
    });
    expect(response.statusCode).toBe(200);
    const saved = await store.read();
    expect(saved.configured).not.toHaveProperty('intelligence');
    expect(saved.configured.requestTimeoutMs).toBe(12000);
    const retired = await api.inject({
      method: 'PATCH',
      url: '/api/admin/market/settings',
      headers: local,
      payload: { version: saved.version, settings: { intelligence: {} } },
    });
    expect(retired.statusCode).toBe(400);
    const empty = await api.inject({
      method: 'PATCH',
      url: '/api/admin/market/settings',
      headers: local,
      payload: { version: saved.version, settings: {} },
    });
    expect(empty.statusCode).toBe(400);
    expect((await store.read()).version).toBe(saved.version);
  });

  it('keeps persisted settings when a new store starts with different environment defaults', async () => {
    await store.patch(
      {
        version: 0,
        settings: { requestTimeoutMs: 12_000, rawRetentionHours: 96 },
      },
      'operator',
    );
    const restarted = createMarketAdminStore({
      ...storeOptions,
      defaults: { ...defaults, requestTimeoutMs: 5000, rawRetentionHours: 24 },
    });
    await restarted.init();
    expect(await restarted.read()).toMatchObject({
      version: 1,
      configured: { requestTimeoutMs: 12_000, rawRetentionHours: 96 },
      effective: { requestTimeoutMs: 12_000, rawRetentionHours: 96 },
    });
  });

  it('allows private proxy settings without a token while preserving validation and optimistic locking', async () => {
    const remote = {
      remoteAddress: '172.30.183.3',
      headers: { host: 'worksmith.example', 'x-forwarded-for': '100.64.0.2' },
    };
    expect(
      (
        await api.inject({
          ...remote,
          method: 'GET',
          url: '/api/admin/market/settings',
        })
      ).statusCode,
    ).toBe(200);
    const update = await api.inject({
      ...remote,
      method: 'PATCH',
      url: '/api/admin/market/settings',
      payload: { version: 0, settings: { refreshCron: '0 * * * *' } },
    });
    expect(update.statusCode).toBe(200);
    expect((await store.read()).version).toBe(1);
    expect(
      (
        await api.inject({
          ...remote,
          method: 'PATCH',
          url: '/api/admin/market/settings',
          payload: { version: 0, settings: { refreshCron: 'invalid' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api.inject({
          ...remote,
          method: 'PATCH',
          url: '/api/admin/market/settings',
          payload: { version: 0, settings: { refreshCron: '0 * * * *' } },
        })
      ).statusCode,
    ).toBe(409);
    expect((await store.read()).version).toBe(1);
  });

  it('preserves settings while retiring the old refresh routes', async () => {
    const settings = await api.inject({
      url: '/api/admin/market/settings',
      headers: local,
    });
    expect(settings.statusCode).toBe(200);
    for (const url of ['/api/refresh', '/api/admin/market/refresh']) {
      const response = await api.inject({
        method: 'POST',
        url,
        headers: local,
      });
      expect(response.statusCode).toBe(404);
    }
    const { rows } = await pool.query('select id from run_requests');
    expect(rows).toHaveLength(0);
  });

  it('pauses Run now and restores it after an audited resume', async () => {
    const pause = await api.inject({
      method: 'POST',
      url: '/api/admin/market/pause',
      headers: local,
      payload: { version: 0 },
    });
    expect(pause.statusCode).toBe(200);
    const blocked = await api.inject({
      method: 'POST',
      url: '/api/run',
      headers: local,
    });
    expect(blocked.statusCode).toBe(409);
    const resume = await api.inject({
      method: 'POST',
      url: '/api/admin/market/resume',
      headers: local,
      payload: { version: 1 },
    });
    expect(resume.statusCode).toBe(200);
    const accepted = await api.inject({
      method: 'POST',
      url: '/api/run',
      headers: local,
    });
    expect(accepted.statusCode).toBe(202);
    expect((await store.read()).effective.collectionsPaused).toBe(false);
    expect((await auditRows()).map(({ action }) => action)).toEqual([
      'collection.pause',
      'collection.resume',
    ]);
  });

  it('applies raw and summary retention independently while preserving valid historical summaries and unarchived runs', async () => {
    const settings = (
      await store.patch(
        {
          version: 0,
          settings: { rawRetentionHours: 24, historyRetentionDays: 14 },
        },
        'operator',
      )
    ).effective;
    const now = new Date();
    const fixture = marketListingFixture(now);
    const research = createMarketResearchRepository(pool);
    const collections = createMarketCollectionRepository(pool);
    const target = await research.saveTarget(
      createMarketTarget(fixture.target),
    );
    const snapshots = [];
    for (const hours of [1, 48, 20 * 24]) {
      const capturedAt = new Date(now.getTime() - hours * 3_600_000);
      const snapshot = createImportedMarketSnapshot(
        {
          ...fixture.observation(target.id),
          capturedAt: capturedAt.toISOString(),
        },
        target,
        capturedAt,
      );
      snapshots.push(await research.saveSnapshot(snapshot));
    }
    const [fresh, rawExpired, historyExpired] = snapshots;
    if (!fresh || !rawExpired || !historyExpired)
      throw new Error('Missing retention fixture');
    const unarchivedId = randomUUID();
    await pool.query(
      `insert into market_collection_runs (id,target_id,target_digest,league,patch,status,trigger,started_at,heartbeat_at,completed_at,payload)
      select $1::uuid,target_id,target_digest,league,patch,'failed',trigger,started_at,heartbeat_at,completed_at,
        jsonb_set(jsonb_set(jsonb_set(payload,'{id}',to_jsonb(($1::uuid)::text)),'{snapshotId}','null'::jsonb),'{status}','"failed"'::jsonb)
      from market_collection_runs where id=$2`,
      [unarchivedId, historyExpired.id],
    );
    const first = await store.cleanupObservations(settings);
    expect(first).toEqual({ rawSnapshots: 2, summaries: 1 });
    expect(await research.findSnapshot(fresh.id)).toMatchObject({
      count: 5,
      listings: expect.any(Array),
    });
    expect((await research.findSnapshot(fresh.id))?.listings).toHaveLength(5);
    expect(await research.findSnapshot(rawExpired.id)).toMatchObject({
      rawAvailable: false,
      count: 5,
      median: 50,
      listings: [],
    });
    expect(await collections.findRun(rawExpired.id)).toMatchObject({
      rawAvailable: false,
      listingCount: 5,
      listings: [],
    });
    expect(await research.findSnapshot(historyExpired.id)).toBeNull();
    expect(await collections.findRun(historyExpired.id)).toBeNull();
    expect(await collections.findRun(unarchivedId)).toMatchObject({
      snapshotId: null,
      status: 'failed',
      listings: expect.any(Array),
    });
    expect((await collections.findRun(unarchivedId))?.listings).toHaveLength(5);
    expect(await store.cleanupObservations(settings)).toEqual({
      rawSnapshots: 0,
      summaries: 0,
    });
    expect((await research.listTargets()).map((entry) => entry.id)).toContain(
      target.id,
    );
    expect(
      (await auditRows()).filter((row) => row.action === 'retention.cleanup'),
    ).toHaveLength(2);
  });
});
