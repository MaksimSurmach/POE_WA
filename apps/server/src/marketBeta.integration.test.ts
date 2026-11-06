import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  marketCatalogImportResponseSchema,
  beltOpportunitiesResponseSchema,
  type MarketTarget,
  type MarketTargetInput,
} from '@poe-worksmith/contracts';
import { buildApi } from './api.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { createPostgresRepositories } from './repositories/index.js';
import {
  createMarketResearchRepository,
  insertMarketResearchSnapshot,
} from './repositories/marketResearchRepository.js';
import { createMarketCollectionRepository } from './repositories/marketCollectionRepository.js';
import {
  importMarketCatalog,
  marketCatalogImportSchema,
} from './marketCatalog.js';
import {
  createBatchedMarketCollectionSource,
  MarketCollectionManager,
  compareMarketObservations,
} from './marketCollection.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { GggRateLimitController } from './rateLimitController.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
  normalizeTradeCompatibleListing,
} from './providers/tradeCompatible.js';
import { tradeStatMappings } from './tradeStatMappings.js';
import { analyzeBeltSnapshot } from './beltComparability.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from './marketResearch.js';
import { beltDemoFixture } from './beltDemoFixture.js';

const config = loadDatabaseConfig();
if (
  config.environment !== 'test' ||
  new URL(config.connectionString).pathname !== '/poe_worksmith_test'
)
  throw new Error('Requires isolated poe_worksmith_test');
const pool = createDatabasePool(config);
const research = createMarketResearchRepository(pool);
const store = createMarketCollectionRepository(pool);
const catalog = marketCatalogImportSchema.parse(
  JSON.parse(
    await readFile(
      new URL('../../../catalog/market-beta-3.29.json', import.meta.url),
      'utf8',
    ),
  ),
);
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'truncate market_collection_runs, market_collection_settings, market_research_snapshots, belt_price_updates, market_targets, rate_limit_states, rate_limit_endpoint_policies cascade',
  );
});

/** Synthetic endpoint payloads: target requirements come from the curated catalog; all prices are DEMO. */
function syntheticListing(target: MarketTarget, id: string, amount = 40) {
  const groups = target.tradeSearch?.groups ?? [];
  const raw: Record<string, string[]> = {
    explicit: [],
    implicit: [],
    crafted: [],
    fractured: [],
  };
  const hashes: Record<string, Array<[string, number[]]>> = {
    explicit: [],
    implicit: [],
    crafted: [],
    fractured: [],
  };
  const metadata: Record<string, Array<{ tier: string }>> = {
    explicit: [],
    implicit: [],
    crafted: [],
    fractured: [],
  };
  const stats = groups
    .flatMap((group) => group.filters)
    .flatMap((stat) =>
      stat.id === 'pseudo.pseudo_total_elemental_resistance'
        ? [
            { id: 'explicit.stat_3372524247', min: 30 },
            { id: 'explicit.stat_4220027924', min: 30 },
            { id: 'explicit.stat_1671376347', min: 30 },
          ]
        : [stat],
    );
  for (const stat of stats) {
    const mapping = tradeStatMappings[stat.id];
    if (!mapping) throw new Error(`Missing fixture mapping ${stat.id}`);
    const origin = stat.id.split('.')[0]!;
    const lines = raw[origin]!;
    hashes[origin]!.push([stat.id, [lines.length]]);
    metadata[origin]!.push({ tier: 'P1' });
    lines.push(mapping.text.replace('#', String(stat.min ?? 1)));
  }
  return {
    id,
    listing: {
      indexed: '2026-11-01T00:00:00.000Z',
      price: { amount, currency: target.tradeSearch?.currency ?? 'chaos' },
      account: { name: `synthetic-${id}` },
    },
    item: {
      baseType: target.baseTypes[0],
      league: target.league,
      frameType: 2,
      ilvl: target.minItemLevel ?? 84,
      corrupted: false,
      fractured: false,
      influences: Object.fromEntries(
        (target.influences ?? []).map((name) => [name, true]),
      ),
      explicitMods: raw.explicit,
      implicitMods: raw.implicit,
      craftedMods: raw.crafted,
      fracturedMods: raw.fractured,
      extended: { hashes, mods: metadata },
    },
  };
}

function demoProfiles(): MarketTargetInput[] {
  const fixture = beltDemoFixture().target.beltCraftMethod!;
  return catalog.profiles.map((profile, index) => ({
    ...profile,
    name: `DEMO — ${profile.name}`,
    league: 'Synthetic beta',
    beltCraftMethod: {
      ...fixture,
      rulesComplete: true,
      assumptions:
        'Synthetic expected-attempts scenario; prices and success chance are not live evidence.',
      success: { mode: 'expected_attempts', expectedAttempts: 4 },
      basePrice: {
        source: 'manual',
        amount: index === 4 ? 100 : 10,
        currency: 'chaos',
        league: 'Synthetic beta',
        patch: profile.patch,
        capturedAt: new Date().toISOString(),
        dataKind: 'demo',
        url: 'https://example.com/demo',
        notes: 'Synthetic base cost',
      },
      materials: [
        {
          ...fixture.materials[0]!,
          price: {
            source: 'manual',
            amount: 2,
            currency: 'chaos',
            league: 'Synthetic beta',
            patch: profile.patch,
            capturedAt: new Date().toISOString(),
            dataKind: 'demo',
            url: 'https://example.com/demo',
            notes: 'Synthetic material cost',
          },
        },
      ],
    },
  }));
}

describe('working market beta with PostgreSQL and HTTP-format fixtures', () => {
  it('reads new scheduled snapshots without mixing query scopes, currencies or cached runs', async () => {
    const fixture = beltDemoFixture();
    const target = await research.saveTarget(
      createMarketTarget({
        ...fixture.target,
        name: 'base:base:stygian-vise',
        slot: 'starting-base',
        minItemLevel: 85,
      }),
    );
    const now = new Date();
    const start = new Date(now.getTime() - 86_400_000);
    const client = await pool.connect();
    const save = async (
      hoursAgo: number,
      {
        queryDigest = 'a'.repeat(64),
        currency = 'chaos',
        cached = false,
        trigger = 'scheduled',
        coverage = 'partial',
        externalId = 'sample',
      }: {
        queryDigest?: string;
        currency?: 'chaos' | 'divine';
        cached?: boolean;
        trigger?: 'manual' | 'scheduled';
        coverage?: 'partial' | 'complete';
        externalId?: string;
      } = {},
    ) => {
      const capturedAt = new Date(
        now.getTime() - hoursAgo * 3_600_000,
      ).toISOString();
      const snapshot = await insertMarketResearchSnapshot(client, {
        ...createImportedMarketSnapshot(
          {
            ...fixture.observation(target.id),
            capturedAt,
            dataKind: 'observed',
            currency,
            listings: [{ externalId, price: 10, item: {} }],
          },
          target,
        ),
        queryDigest,
        provenance: 'collection',
        coverage,
      });
      await client.query(
        `insert into market_collection_runs
          (id, target_id, target_digest, league, patch, status, trigger, started_at, heartbeat_at, completed_at, payload)
          values ($1, $2, $3, $4, $5, 'partial', $6, $7, $7, $7, $8)`,
        [
          randomUUID(),
          target.id,
          target.digest,
          target.league,
          target.patch,
          trigger,
          capturedAt,
          JSON.stringify({
            sourceId: 'trade-compatible',
            snapshotId: snapshot.id,
            cached,
            reportedTotal: 1,
          }),
        ],
      );
      return snapshot.id;
    };
    try {
      const first = await save(4);
      await save(6, { queryDigest: 'b'.repeat(64) });
      await save(5, { currency: 'divine' });
      await save(3, { cached: true });
      await save(2.5, { trigger: 'manual' });
      const read = () =>
        research.readScheduledTradeTrend!(start, now, target.id);
      expect((await read()).series?.points.map(({ id }) => id)).toEqual([
        first,
      ]);
      const second = await save(2);
      const after = await read();
      expect(after.targets).toEqual([
        { id: target.id, name: 'Stygian Vise · iLvl 85 · stygian-vise' },
      ]);
      expect(
        after.series?.points.map(({ id, median }) => [id, median]),
      ).toEqual([
        [first, 10],
        [second, 10],
      ]);
      expect(after.series?.activity).toBeUndefined();
      await save(1.5, { coverage: 'complete' });
      await save(0.5, { coverage: 'complete', externalId: 'replacement' });
      const complete = await read();
      expect(complete.series?.points.at(-1)?.reportedTotal).toBe(1);
      expect(complete.series?.activity).toMatchObject({
        missingCount: 1,
        newCount: 1,
      });
    } finally {
      client.release();
    }
  });

  it('imports five real structured profiles and runs catalog → query → search/fetch → matching → snapshots → ranking → API', async () => {
    let now = new Date(Date.now() - 600_000);
    const profiles = demoProfiles();
    const input = { schemaVersion: 1, profiles };
    const imported = await importMarketCatalog(input, research);
    const targets = imported.targets;
    expect(targets).toHaveLength(5);
    expect((await importMarketCatalog(input, research)).unchanged).toBe(5);
    let round = 0;
    const payloads = new Map<string, ReturnType<typeof syntheticListing>>();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/search/')) {
        const body = JSON.parse(String(init?.body));
        const target = targets.find(
          (target) =>
            target.baseTypes[0] === body.query.type &&
            JSON.stringify(generateMarketTradeQuery(target).request) ===
              JSON.stringify(body),
        );
        if (!target) throw new Error('Unknown query');
        const key = target.catalog!.key;
        const indexes = round === 1 ? [1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5];
        const ids = indexes.map((index) => `${key}-${index}`);
        indexes.forEach((index) =>
          payloads.set(
            `${key}-${index}`,
            syntheticListing(
              target,
              `${key}-${index}`,
              40 +
                index * 5 +
                (round === 1 && index === 1
                  ? 10
                  : round === 1 && index === 2
                    ? -5
                    : 0),
            ),
          ),
        );
        return Response.json({
          id: `q-${key}`,
          total: ids.length,
          result: ids,
        });
      }
      const ids = new URL(String(url)).pathname.split('/').at(-1)!.split(',');
      return Response.json({
        result: ids.map((id) => payloads.get(id) ?? null),
      });
    });
    const transport = new TradeCompatibleTransport(
      loadTradeCompatibleConfig({
        POE_TRADE_USER_AGENT: 'Worksmith fixture integration',
      }),
      { fetcher, clock: () => now },
    );
    const gate = new GggRateLimitController({
      repository: createPostgresRepositories(pool).rateLimits,
      clock: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
    });
    const adapter = createBatchedMarketCollectionSource({
      descriptor: {
        id: 'beta-fixture',
        name: 'Synthetic endpoint fixture',
        access: 'replay',
        dataKind: 'demo',
        reason: 'No live requests',
      },
      transport,
      rateLimits: gate,
    });
    let manager = new MarketCollectionManager({
      adapter,
      store,
      clock: () => now,
    });
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => {},
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { marketResearch: research, marketCollection: { manager, store } },
    );
    try {
      await manager.start();
      for (round = 0; round < 3; round++) {
        for (const target of targets) {
          const initial = await manager.runNow(target.id);
          await vi.waitFor(
            async () =>
              expect((await store.findRun(initial.id))?.status).toBe(
                'succeeded',
              ),
            { timeout: 5000 },
          );
        }
        now = new Date(now.getTime() + 60_000);
      }
      expect(fetcher).toHaveBeenCalledTimes(30);
      const saved = await research.listSnapshots();
      expect(saved).toHaveLength(15);
      expect(
        saved.every(
          (snapshot) =>
            snapshot.dataKind === 'demo' && snapshot.coverage === 'complete',
        ),
      ).toBe(true);
      for (const target of targets) {
        const observations = await store.listObservations(target.id);
        const points = compareMarketObservations(observations);
        expect(points[1]).toMatchObject({
          newCount: 1,
          missingCount: 1,
          increasedCount: 1,
          decreasedCount: 1,
          independentSellers: 6,
        });
        expect(points[2]?.restoredCount).toBe(1);
        const detail = await research.findSnapshot(
          saved.find((snapshot) => snapshot.targetId === target.id)!.id,
        );
        expect(detail?.listings[0]?.rawListing).toHaveProperty('item.extended');
        expect(
          analyzeBeltSnapshot(target, detail!, now.getTime()).confirmedListings,
        ).toBe(6);
      }
      const response = await api.inject({
        method: 'GET',
        url: '/api/market/belt-opportunities?kind=demo',
      });
      expect(response.statusCode, response.body).toBe(200);
      const opportunities = beltOpportunitiesResponseSchema.parse(
        response.json(),
      ).data;
      expect(opportunities).toHaveLength(5);
      expect(opportunities.every((row) => row.status === 'CALCULATED')).toBe(
        true,
      );
      expect(
        opportunities.some(
          (row) =>
            row.economicConclusion === 'NON_POSITIVE' &&
            Number(row.calculation?.spread) < 0,
        ),
      ).toBe(true);
      expect(
        opportunities.every(
          (row) => row.queryUrl && row.calculation?.roiPercent,
        ),
      ).toBe(true);
      const anotherLeague = await api.inject({
        method: 'GET',
        url: '/api/market/belt-opportunities?kind=demo&league=Other',
      });
      expect(
        beltOpportunitiesResponseSchema.parse(anotherLeague.json()).data,
      ).toEqual([]);
      const dry = await api.inject({
        method: 'POST',
        url: '/api/market/catalog/import?dryRun=true',
        payload: input,
      });
      expect(
        marketCatalogImportResponseSchema.parse(dry.json()).data,
      ).toMatchObject({ unchanged: 5, dryRun: true });
      const before = fetcher.mock.calls.length;
      await manager.updateSettings(targets[0]!.id, {
        enabled: true,
        paused: true,
        intervalMinutes: 5,
      });
      await expect(manager.runNow(targets[0]!.id)).rejects.toMatchObject({
        code: 'MARKET_COLLECTION_PAUSED',
      });
      await manager.tick();
      expect(fetcher).toHaveBeenCalledTimes(before);
      await manager.stop();
      manager = new MarketCollectionManager({
        adapter,
        store,
        clock: () => now,
      });
      await manager.start();
      expect(await store.listObservations(targets[0]!.id)).toHaveLength(3);
      expect(await research.listSnapshots()).toHaveLength(15);
    } finally {
      await manager.stop();
      await api.close();
    }
  }, 30_000);

  it('keeps missing/malformed mods partial, broad mismatches rejected, and isolates leagues', () => {
    const profile = catalog.profiles.find(
      (profile) => profile.catalog.key === 'spectre-minion-helmet',
    )!;
    const target = createMarketTarget(profile);
    const raw = syntheticListing(target, 'one');
    const snapshot = (item: unknown) =>
      createImportedMarketSnapshot(
        {
          targetId: target.id,
          sourceUrl: 'https://example.com/fixture',
          capturedAt: new Date().toISOString(),
          currency: 'chaos',
          dataKind: 'demo',
          listings: [normalizeTradeCompatibleListing(item, target)],
        },
        target,
      );
    expect(analyzeBeltSnapshot(target, snapshot(raw)).rows[0]?.status).toBe(
      'MATCH',
    );
    raw.item.explicitMods = ['unsupported changed format'];
    expect(analyzeBeltSnapshot(target, snapshot(raw)).rows[0]?.status).toBe(
      'PARTIAL',
    );
    raw.item.explicitMods = [
      '+1 to Level of all Minion Skill Gems',
      '+100 to maximum Life',
    ];
    expect(analyzeBeltSnapshot(target, snapshot(raw)).rows[0]?.status).toBe(
      'REJECT',
    );
    raw.item.league = 'Other League';
    expect(() => snapshot(raw)).toThrow();
  });
});
