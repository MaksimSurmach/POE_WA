import { randomUUID } from 'node:crypto';
import {
  marketAdminRunSchema,
  marketAdminSettingsResponseSchema,
  type MarketAdminRefresh,
  type MarketAdminStatus,
} from '@poe-worksmith/contracts';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApi } from './api.js';
import { beltDemoFixture } from './beltDemoFixture.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  CATALOG_REFRESH_QUEUE,
  createJobBoss,
  ManualRefreshProducer,
} from './jobs.js';
import {
  createMarketAdminStore,
  defaultAdminSettings,
  type AdminQueue,
} from './marketAdmin.js';
import { resetIntegrationDatabase } from './testkit/resetIntegrationDatabase.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';
import { createMarketResearchRepository } from './repositories/marketResearchRepository.js';
import { createMarketCollectionRepository } from './repositories/marketCollectionRepository.js';
import { createPostgresRepositories } from './repositories/index.js';

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
const boss = createJobBoss(pool, 'pgboss_admin_test', logger);
const secondBoss = createJobBoss(pool, 'pgboss_admin_test', logger);
const producer = new ManualRefreshProducer(boss);
const secondProducer = new ManualRefreshProducer(secondBoss);
const defaults = defaultAdminSettings({
  refreshCron: '0 */4 * * *',
  requestTimeoutMs: 15_000,
  concurrency: 4,
  snapshotTtlMs: 30 * 60_000,
});
const storeOptions = { pool, defaults, timezone: 'UTC', concurrencyLimit: 2 };
const store = createMarketAdminStore(storeOptions);
const secondStore = createMarketAdminStore(storeOptions);
const recipeId = 'admin-regression-recipe';
const leagueId = '00000000-0000-4000-8000-000000000131';
const local = { host: 'localhost:3000', origin: 'http://localhost:3000' };
const status: MarketAdminStatus = {
  serverTime: '2026-11-02T12:00:00.000Z',
  access: 'local-only',
  league: null,
  trade: { configured: false, status: 'UNAVAILABLE', reason: null },
  ninja: { configured: false, status: 'UNAVAILABLE', cooldownUntil: null },
  worker: { healthy: false, heartbeatAt: null, settingsVersion: null },
  scheduler: {
    healthy: false,
    enabled: true,
    cron: defaults.refreshCron,
    nextRefreshAt: null,
  },
  activeRun: null,
  lastSuccessful: null,
  lastFailed: null,
  collection: { paused: false, scheduled: true, manualAvailable: true },
  coverage: {
    activeRecipes: 1,
    pricedRecipes: 0,
    freshRecipes: 0,
    warningRecipes: 0,
    latestSnapshotAt: null,
  },
  rateLimits: [],
  warnings: [],
};
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
    marketAdmin: { store, queue: producer, status: async () => status },
    triggerRefresh: async () =>
      (await store.enqueue({ scope: 'all' }, 'legacy-refresh', producer)).id,
  },
);

async function clear() {
  await pool.query(
    'truncate market_admin_runs, market_admin_settings, market_admin_audit, market_worker_health restart identity',
  );
  await pool.query(
    'truncate market_collection_runs, market_collection_settings, market_research_snapshots, belt_price_updates, market_targets cascade',
  );
  await resetIntegrationDatabase(pool);
}
beforeAll(async () => {
  await pool.query('drop schema if exists pgboss_admin_test cascade');
  await producer.start();
  await secondProducer.start();
  await api.ready();
});
beforeEach(async () => {
  await boss.deleteAllJobs(CATALOG_REFRESH_QUEUE);
  await clear();
  await store.init();
  await pool.query(
    `insert into recipes (id,content_hash,title,category,craft_method,game_version,guide_markdown,definition) values ($1,'admin-fixture-hash','Admin regression fixture','jewel','fossil','3.29','# Fixture','{}')`,
    [recipeId],
  );
  await pool.query(
    `insert into poe_leagues (id,ggg_id,name,synced_at) values ($1,'Admin Fixture','Admin Fixture',now())`,
    [leagueId],
  );
});
afterAll(async () => {
  await api.close();
  await Promise.all([producer.stop(1000), secondProducer.stop(1000)]);
  await pool.query('drop schema if exists pgboss_admin_test cascade');
  await clear();
  await pool.end();
});

async function enqueue(input: MarketAdminRefresh = { scope: 'all' }) {
  const result = await store.enqueue(input, 'integration-operator', producer);
  if (!result.id) throw new Error('Expected a newly queued fixture run');
  return result.id;
}
async function auditRows() {
  return (
    await pool.query<{ action: string; actor: string; details: unknown }>(
      'select action,actor,details from market_admin_audit order by id',
    )
  ).rows;
}
async function seedCycle(id: string) {
  await pool.query(
    `insert into refresh_cycles (id,league_id,status,started_at,total_recipes,total_queries) values ($1,$2,'running',now(),1,1)`,
    [id, leagueId],
  );
  await pool.query(
    `insert into jobs (dedupe_key,kind,status,refresh_cycle_id,locked_at,locked_by) values ($1,'recipe_refresh','running',$2,now(),'fixture-worker')`,
    [`admin-job-${id}`, id],
  );
}
async function seedPublishableRun() {
  const id = await enqueue();
  await boss.fetch(CATALOG_REFRESH_QUEUE);
  await store.claim(id, { scope: 'all', source: 'manual' });
  await seedCycle(id);
  await pool.query(
    'update refresh_cycles set completed_recipes=1,completed_queries=1 where id=$1',
    [id],
  );
  await pool.query('update poe_leagues set is_current=true where id=$1', [
    leagueId,
  ]);
  const previousId = randomUUID();
  await pool.query(
    `insert into refresh_cycles (id,league_id,status,total_recipes,completed_recipes,published_at,finished_at) values ($1,$2,'published',1,1,now(),now())`,
    [previousId, leagueId],
  );
  await pool.query(
    'insert into catalog_state (id,published_cycle_id,revision,published_at) values (1,$1,7,now())',
    [previousId],
  );
  return { id, previousId, repositories: createPostgresRepositories(pool) };
}

describe('market admin PostgreSQL, queue and API integration', () => {
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

  it('refuses publication after a cancellation request and retains the existing catalog pointer', async () => {
    const { id, previousId, repositories } = await seedPublishableRun();
    await store.cancel(id, 'operator', producer);
    await expect(
      repositories.cycles.publish(id, new Date()),
    ).rejects.toMatchObject({ code: 'MARKET_COLLECTION_CANCELLED' });
    expect(
      (
        await pool.query(
          'select published_cycle_id,revision from catalog_state where id=1',
        )
      ).rows[0],
    ).toMatchObject({ published_cycle_id: previousId, revision: '7' });
    expect(
      (
        await pool.query(
          'select status,published_at from refresh_cycles where id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual({ status: 'running', published_at: null });
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'running',
      cancelRequested: true,
    });
  });

  it('commits successful publication and the admin result together, then refuses late cancellation', async () => {
    const { id, previousId, repositories } = await seedPublishableRun();
    const publishedAt = new Date();
    expect(await repositories.cycles.publish(id, publishedAt)).toBe(true);
    expect(
      (
        await pool.query(
          'select published_cycle_id,previous_cycle_id,revision from catalog_state where id=1',
        )
      ).rows[0],
    ).toMatchObject({
      published_cycle_id: id,
      previous_cycle_id: previousId,
      revision: '8',
    });
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'succeeded',
      finishedAt: publishedAt.toISOString(),
      cancelRequested: false,
    });
    await expect(
      store.cancel(id, 'late-operator', producer),
    ).rejects.toMatchObject({ code: 'MARKET_COLLECTION_NOT_RUNNING' });
    const response = await api.inject({
      method: 'POST',
      url: `/api/admin/market/runs/${id}/cancel`,
      headers: local,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MARKET_COLLECTION_NOT_RUNNING');
    expect((await store.runs())[0]).toMatchObject({
      status: 'succeeded',
      cancelRequested: false,
    });
    expect(
      (await auditRows()).filter((entry) => entry.action === 'refresh.cancel'),
    ).toHaveLength(0);
  });

  it('waits for a concurrent cancellation row lock and observes its committed flag before publication', async () => {
    const { id, previousId, repositories } = await seedPublishableRun();
    const cancellation = await pool.connect();
    let settledPublication: Promise<unknown> | undefined;
    try {
      await cancellation.query('begin');
      await cancellation.query(
        'update market_admin_runs set cancel_requested=true where id=$1',
        [id],
      );
      const publication = repositories.cycles.publish(id, new Date()).then(
        (published) => ({ published, error: null }),
        (error: unknown) => ({ published: null, error }),
      );
      settledPublication = publication;
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                `select count(*)::int as waiting from pg_stat_activity where datname=current_database() and query like 'select cancel_requested from market_admin_runs where id=%' and wait_event_type='Lock'`,
              )
            ).rows[0]?.waiting,
          { timeout: 2000, interval: 10 },
        )
        .toBe(1);
      expect(
        (
          await pool.query(
            'select published_cycle_id from catalog_state where id=1',
          )
        ).rows[0]?.published_cycle_id,
      ).toBe(previousId);
      await cancellation.query('commit');
      expect(await publication).toMatchObject({
        published: null,
        error: { code: 'MARKET_COLLECTION_CANCELLED' },
      });
      expect(
        (
          await pool.query(
            'select published_cycle_id,revision from catalog_state where id=1',
          )
        ).rows[0],
      ).toMatchObject({ published_cycle_id: previousId, revision: '7' });
    } finally {
      await cancellation.query('rollback').catch(() => undefined);
      cancellation.release();
      await settledPublication;
    }
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
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/admin/market/status',
          headers: local,
        })
      ).json().data,
    ).toEqual(status);
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

  it('rejects unknown/empty patch structure and inactive or nonexistent recipe refreshes', async () => {
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
    await pool.query('update recipes set active=false where id=$1', [recipeId]);
    for (const id of [recipeId, 'unknown'])
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/api/admin/market/refresh',
            headers: local,
            payload: { scope: 'recipe', recipeId: id },
          })
        ).statusCode,
      ).toBe(404);
    expect(await store.runs()).toEqual([]);
  });

  it('preserves configured intelligence thresholds when another setting is patched', async () => {
    const initial = await store.read();
    await store.patch(
      {
        version: initial.version,
        settings: {
          intelligence: {
            ...initial.configured.intelligence,
            minIndependentSellers: 4,
            enterProfitChaos: '75',
          },
        },
      },
      'operator',
    );
    const response = await api.inject({
      method: 'PATCH',
      url: '/api/admin/market/settings',
      headers: local,
      payload: {
        version: initial.version + 1,
        settings: { requestTimeoutMs: 12000 },
      },
    });
    expect(response.statusCode).toBe(200);
    const saved = await store.read();
    expect(saved.configured.intelligence).toMatchObject({
      minIndependentSellers: 4,
      enterProfitChaos: '75',
    });
    expect(saved.configured.requestTimeoutMs).toBe(12000);
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

  it.each([
    { remoteAddress: '203.0.113.8', headers: local },
    {
      remoteAddress: '127.0.0.1',
      headers: { ...local, host: 'rebind.example' },
    },
    {
      remoteAddress: '127.0.0.1',
      headers: { ...local, origin: 'https://evil.example' },
    },
    {
      remoteAddress: '127.0.0.1',
      headers: { ...local, 'x-forwarded-for': '127.0.0.1' },
    },
  ])(
    'protects admin reads/writes and every legacy market write at one boundary: %j',
    async (access) => {
      for (const [method, url] of [
        ['GET', '/api/admin/market/status'],
        ['PATCH', '/api/admin/market/settings'],
        ['POST', '/api/refresh'],
        ['POST', '/api/market/economy/collect'],
        ['POST', '/api/market/targets'],
        ['POST', '/api/market/snapshots/import'],
        ['PATCH', '/api/market/targets/fixture/collection'],
      ] as const) {
        const response = await api.inject({ method, url, ...access });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
      expect((await store.read()).version).toBe(0);
      expect(await store.runs()).toEqual([]);
    },
  );

  it('pauses new work, permits safe resume, and audits both settings changes', async () => {
    const running = await enqueue();
    await boss.fetch(CATALOG_REFRESH_QUEUE);
    await store.claim(running, { scope: 'all', source: 'manual' });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/admin/market/pause',
          headers: local,
          payload: { version: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await store.runs())[0]).toMatchObject({
      id: running,
      status: 'running',
      cancelRequested: false,
    });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/admin/market/refresh',
          headers: local,
          payload: { scope: 'all' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/market/economy/collect',
          headers: local,
          payload: { league: 'Admin Fixture', category: 'Currency' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/admin/market/resume',
          headers: local,
          payload: { version: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await store.read()).effective.collectionsPaused).toBe(false);
    expect((await auditRows()).map((row) => row.action)).toEqual(
      expect.arrayContaining(['collection.pause', 'collection.resume']),
    );
  });

  it.each<MarketAdminRefresh>([
    { scope: 'all' },
    { scope: 'economy' },
    { scope: 'recipe', recipeId },
  ])(
    'queues the requested scope once across independent producers: %j',
    async (scope) => {
      const [first, second] = await Promise.all([
        store.enqueue(scope, 'first-operator', producer),
        secondStore.enqueue(scope, 'second-operator', secondProducer),
      ]);
      expect([first.accepted, second.accepted].sort()).toEqual([false, true]);
      const id = first.id ?? second.id;
      expect(id).toBeTypeOf('string');
      const queueJobs = await boss.findJobs(CATALOG_REFRESH_QUEUE);
      expect(queueJobs).toHaveLength(1);
      expect(queueJobs[0]).toMatchObject({
        id,
        data: { ...scope, source: 'manual' },
        state: 'created',
      });
      expect(await store.runs()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
    },
  );

  it('rolls back the run, real queue insert and audit when queue submission fails', async () => {
    const failingQueue: AdminQueue = {
      async enqueue(data, id, db) {
        await producer.enqueue(data, id, db);
        throw new Error('injected queue failure');
      },
      cancel: (id) => producer.cancel(id),
    };
    await expect(
      store.enqueue({ scope: 'all' }, 'operator', failingQueue),
    ).rejects.toThrow('injected queue failure');
    expect(await store.runs()).toEqual([]);
    expect(await boss.findJobs(CATALOG_REFRESH_QUEUE)).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect(
      (await store.enqueue({ scope: 'all' }, 'operator', producer)).accepted,
    ).toBe(true);
  });

  it('cancels queued jobs and records running cancellation cooperatively without discarding history', async () => {
    const queued = await enqueue();
    expect(
      (
        await api.inject({
          method: 'POST',
          url: `/api/admin/market/runs/${queued}/cancel`,
          headers: local,
          payload: {},
        })
      ).statusCode,
    ).toBe(202);
    expect(await producer.state(queued)).toBe('cancelled');
    expect((await store.runs()).find((run) => run.id === queued)).toMatchObject(
      { status: 'cancelled', cancelRequested: true },
    );
    const running = await enqueue({ scope: 'economy' });
    await boss.fetch(CATALOG_REFRESH_QUEUE);
    expect(
      await store.claim(running, { scope: 'economy', source: 'manual' }),
    ).toBe(true);
    await store.cancel(running, 'operator', secondProducer);
    expect(await secondStore.cancellationRequested(running)).toBe(true);
    expect(await producer.state(running)).toBe('active');
    const response = await api.inject({
      method: 'GET',
      url: '/api/admin/market/runs',
      headers: local,
    });
    expect(marketAdminRunSchema.array().parse(response.json().data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: queued, status: 'cancelled' }),
        expect.objectContaining({
          id: running,
          status: 'running',
          cancelRequested: true,
        }),
      ]),
    );
  });

  it('skips an already queued scheduled refresh when automatic collection is disabled', async () => {
    await store.patch(
      {
        version: 0,
        settings: {
          automaticRefreshEnabled: false,
          scheduledCollectionEnabled: false,
        },
      },
      'operator',
    );
    const id = randomUUID();
    await boss.send(
      CATALOG_REFRESH_QUEUE,
      { source: 'scheduler', scope: 'all' },
      { id, singletonKey: 'catalog-refresh' },
    );
    expect(await store.claim(id, { scope: 'all', source: 'scheduler' })).toBe(
      false,
    );
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'skipped',
      errorCode: 'MARKET_COLLECTION_PAUSED',
    });
    expect(
      (await pool.query('select count(*)::int as count from raw_snapshots'))
        .rows[0]?.count,
    ).toBe(0);
    await expect(
      store.enqueue({ scope: 'economy' }, 'operator', producer),
    ).rejects.toMatchObject({ code: 'REFRESH_ALREADY_RUNNING' });
    await boss.cancel(CATALOG_REFRESH_QUEUE, id);
    expect(
      (await store.enqueue({ scope: 'economy' }, 'operator', producer))
        .accepted,
    ).toBe(true);
  });

  it('reconciles interrupted queue runs and orphan cycles while preserving recipes and raw observations', async () => {
    const id = await enqueue();
    await seedCycle(id);
    const queryId = randomUUID();
    await pool.query(
      `insert into market_queries (id,recipe_id,provider,canonical_hash,query) values ($1,$2,'poe-trade','admin-snapshot-query','{}')`,
      [queryId, recipeId],
    );
    await pool.query(
      `insert into raw_snapshots (dedupe_key,market_query_id,league_id,refresh_cycle_id,captured_at,expires_at,provider_status,payload) values ('admin-preserved-snapshot',$1,$2,$3,now()-interval '1 day',now()-interval '1 hour',200,'{"synthetic":true}')`,
      [queryId, leagueId, id],
    );
    await boss.deleteAllJobs(CATALOG_REFRESH_QUEUE);
    await store.reconcile(producer);
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'failed',
      errorCode: 'REFRESH_WORKER_INTERRUPTED',
    });
    expect(
      (
        await pool.query(
          'select status,error_message from refresh_cycles where id=$1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'failed',
      error_message: 'REFRESH_WORKER_INTERRUPTED',
    });
    expect(
      (
        await pool.query(
          'select status,locked_by from jobs where refresh_cycle_id=$1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({ status: 'failed', locked_by: null });
    expect(
      (
        await pool.query(
          'select payload from raw_snapshots where dedupe_key=$1',
          ['admin-preserved-snapshot'],
        )
      ).rows[0]?.payload,
    ).toEqual({ synthetic: true });
    expect(
      (
        await pool.query(
          'select count(*)::int as count from recipes where id=$1',
          [recipeId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    const orphan = randomUUID();
    await seedCycle(orphan);
    await store.reconcile(producer);
    expect(
      (
        await pool.query('select status from refresh_cycles where id=$1', [
          orphan,
        ])
      ).rows[0]?.status,
    ).toBe('failed');
  });

  it('fails queued runs after one hour, but does not expire an older active run based on enqueue age', async () => {
    const queued = await enqueue();
    await pool.query(
      `update market_admin_runs set requested_at=now()-interval '61 minutes' where id=$1`,
      [queued],
    );
    await store.reconcile(producer);
    expect(await producer.state(queued)).toBe('cancelled');
    expect((await store.runs())[0]).toMatchObject({
      id: queued,
      status: 'failed',
      errorCode: 'REFRESH_QUEUE_EXPIRED',
    });
    const active = await enqueue();
    await boss.fetch(CATALOG_REFRESH_QUEUE);
    await store.claim(active, { scope: 'all', source: 'manual' });
    await pool.query(
      `update market_admin_runs set requested_at=now()-interval '61 minutes' where id=$1`,
      [active],
    );
    await store.reconcile(producer);
    expect((await store.runs()).find((run) => run.id === active)?.status).toBe(
      'running',
    );
  });

  it('fails an interrupted cycle without locking it ahead of an in-flight job commit', async () => {
    const id = await enqueue();
    await seedCycle(id);
    const inFlight = await pool.connect();
    await inFlight.query('begin');
    await inFlight.query("set local statement_timeout='1s'");
    await inFlight.query(
      'select id from jobs where refresh_cycle_id=$1 for update',
      [id],
    );
    const failing = store.failCycle(id, 'REFRESH_WORKER_INTERRUPTED').then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "select count(*)::int as waiting from pg_stat_activity where datname=current_database() and query like 'update jobs set status=%' and wait_event_type='Lock'",
              )
            ).rows[0]?.waiting,
        )
        .toBe(1);
      await inFlight.query(
        'update refresh_cycles set updated_at=now() where id=$1',
        [id],
      );
      await inFlight.query('commit');
      expect(await failing).toBeNull();
      expect(
        (
          await pool.query('select status from refresh_cycles where id=$1', [
            id,
          ])
        ).rows[0]?.status,
      ).toBe('failed');
      expect(
        (
          await pool.query(
            'select status from jobs where refresh_cycle_id=$1',
            [id],
          )
        ).rows[0]?.status,
      ).toBe('failed');
    } finally {
      await inFlight.query('rollback').catch(() => undefined);
      inFlight.release();
      await failing;
    }
  });

  it('does not expire a queued run that a worker claims during reconciliation', async () => {
    const id = await enqueue();
    await pool.query(
      `update market_admin_runs set requested_at=now()-interval '61 minutes' where id=$1`,
      [id],
    );
    let claimed = false;
    await store.reconcile({
      async state(runId) {
        if (!claimed) {
          claimed = true;
          await boss.fetch(CATALOG_REFRESH_QUEUE);
          expect(
            await secondStore.claim(id, { scope: 'all', source: 'manual' }),
          ).toBe(true);
          await seedCycle(id);
        }
        return producer.state(runId);
      },
      cancel: (runId) => producer.cancel(runId),
    });
    expect(await producer.state(id)).toBe('active');
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'running',
      errorCode: null,
    });
    expect(
      (await pool.query('select status from refresh_cycles where id=$1', [id]))
        .rows[0]?.status,
    ).toBe('running');
  });

  it('shares worker heartbeats and makes stale health visible across processes', async () => {
    expect(await store.workerHealth()).toMatchObject({
      healthy: false,
      heartbeatAt: null,
    });
    await store.heartbeat(3);
    expect(await secondStore.workerHealth()).toMatchObject({
      healthy: true,
      settingsVersion: 3,
    });
    await pool.query(
      `update market_worker_health set heartbeat_at=now()-interval '21 seconds'`,
    );
    expect(await secondStore.workerHealth()).toMatchObject({
      healthy: false,
      settingsVersion: 3,
    });
  });

  it('persists economy run progress and cooldowns across independent store instances', async () => {
    const id = await enqueue({ scope: 'economy' });
    await boss.fetch(CATALOG_REFRESH_QUEUE);
    expect(await store.claim(id, { scope: 'economy', source: 'manual' })).toBe(
      true,
    );
    const sourceFreshness = new Date().toISOString();
    const cooldownUntil = new Date(Date.now() + 120_000).toISOString();
    await store.progress(id, {
      total: 4,
      succeeded: 2,
      failed: 1,
      sourceFreshness,
      cooldownUntil,
    });
    const restarted = createMarketAdminStore(storeOptions);
    expect((await restarted.runs())[0]).toMatchObject({
      id,
      scope: 'economy',
      status: 'running',
      totalQueries: 4,
      completedQueries: 2,
      failedQueries: 1,
      sourceFreshness,
      cooldownUntil,
    });
    await restarted.finish(id, 'failed', 'RATE_LIMITED');
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'failed',
      errorCode: 'RATE_LIMITED',
      totalQueries: 4,
      completedQueries: 2,
      failedQueries: 1,
      sourceFreshness,
      cooldownUntil,
    });
  });

  it('reconciles a failed pg-boss attempt rather than retaining an active run forever', async () => {
    const id = await enqueue();
    await boss.fetch(CATALOG_REFRESH_QUEUE);
    await store.claim(id, { scope: 'all', source: 'manual' });
    await seedCycle(id);
    await boss.fail(CATALOG_REFRESH_QUEUE, id, {
      error: 'synthetic worker failure',
    });
    expect(await producer.state(id)).toBe('failed');
    await secondStore.reconcile(secondProducer);
    expect((await store.runs())[0]).toMatchObject({
      id,
      status: 'failed',
      errorCode: 'REFRESH_WORKER_INTERRUPTED',
    });
    expect(
      (await pool.query('select status from refresh_cycles where id=$1', [id]))
        .rows[0]?.status,
    ).toBe('failed');
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
    const fixture = beltDemoFixture(now);
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
