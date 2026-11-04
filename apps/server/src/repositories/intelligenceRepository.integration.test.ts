import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  RegisteredTradeQueryGenerator,
  noVariantFilter,
  mappedTargetFilter,
  factoryBatchSchema,
  factoryEventSchema,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from './postgresRepositories.js';
import { createFactoryRepository } from './factoryRepository.js';
import { craftRequestHash } from './craftAnalysisRepository.js';
import { createMarketEconomyRepository } from './marketEconomyRepository.js';
import { createIntelligenceRepository } from './intelligenceRepository.js';
import { createRecipeMarketDependencies } from '../recipeMarket.js';
import { seedIntelligenceScenario } from '../testkit/intelligence.js';
import { buildApi } from '../api.js';
const config = loadDatabaseConfig(),
  address = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  address.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    address.hostname,
  )
)
  throw new Error(
    'Intelligence integration requires isolated poe_worksmith_test',
  );
const pool = createDatabasePool(config),
  repositories = createPostgresRepositories(pool);
afterAll(async () => pool.end());
const marketDependencies = createRecipeMarketDependencies({
  trade: new RegisteredTradeQueryGenerator(
    {
      resolveBase: async ({ baseId }) => ({
        ok: true,
        diagnostics: [],
        value: { id: baseId, mappingVersion: 'synthetic' },
      }),
      resolveTarget: async ({ target }) => ({
        ok: true,
        diagnostics: [],
        value: { id: target.modId ?? 'synthetic-stat' },
      }),
    },
    [noVariantFilter],
    [mappedTargetFilter],
  ),
  resolveResource: async (id) => id,
});
const tx = (price: string) => ({
  quantity: '1',
  unitPrice: price,
  currency: 'chaos',
  chaosPerUnit: '1',
  rateSource: 'synthetic planning rate',
});
async function scenario() {
  const id = `intelligence-${randomUUID()}`;
  await repositories.recipes.save({
    id,
    active: true,
    contentHash: `revision-${id}`,
    title: 'Synthetic production opportunity',
    category: 'cluster-jewel',
    craftMethod: 'synthetic',
    gameVersion: 'fixture',
    tags: ['synthetic'],
    guideMarkdown: 'Synthetic only',
    definition: { ...fixtureRecipe({ ...canonicalRecipeFixture, id }) },
  });
  const league = `Intelligence synthetic ${randomUUID()}`;
  await repositories.leagues.upsert({
    gggId: league,
    name: league,
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: null,
    isCurrent: false,
    metadata: { synthetic: true },
    syncedAt: new Date(),
  });
  return seedIntelligenceScenario(pool, {
    recipeId: id,
    league,
    marketDependencies,
  });
}
describe('persisted intelligence with real repositories and labelled synthetic evidence', () => {
  it('replays exact cohorts beyond 100 batches and retains old unsold inventory without unrelated coverage poisoning', async () => {
    const seeded = await scenario(),
      factory = createFactoryRepository(pool);
    const original = await factory.get(
      seeded.batchId,
      seeded.confirmed.signal.evaluatedAt,
    );
    async function add(produce: boolean, index: number) {
      const batch = factoryBatchSchema.parse({
        ...original.batch,
        id: randomUUID(),
        notes: `synthetic coverage ${index}`,
      });
      await factory.create(
        batch,
        randomUUID(),
        craftRequestHash(batch),
        seeded.confirmed.signal.evaluatedAt,
      );
      if (produce)
        await factory.append(
          batch.id,
          0,
          factoryEventSchema.parse({
            id: randomUUID(),
            occurredAt: batch.startedAt,
            source: 'synthetic:old-unsold',
            notes: '',
            payload: {
              type: 'produce',
              itemId: randomUUID(),
              description: 'Old unsold exact output',
              modifiers: [],
              outcome: 'target',
              classification: 'target',
              targetSignature: batch.targetSignature,
              allocations: [],
            },
          }),
          randomUUID(),
          seeded.confirmed.signal.evaluatedAt,
        );
    }
    for (let offset = 0; offset < 101; offset += 10)
      await Promise.all(
        Array.from({ length: Math.min(10, 101 - offset) }, (_, i) =>
          add(false, offset + i),
        ),
      );
    const unrelated = await seeded.service.opportunity(
      seeded.recipeId,
      seeded.league,
    );
    expect(unrelated.liquidity.own.coverageComplete).toBe(true);
    expect(unrelated.signal.state).toBe('CRAFT');
    expect(unrelated.liquidity.own.sampleSize).toBe(3);
    for (let offset = 0; offset < 101; offset += 10)
      await Promise.all(
        Array.from({ length: Math.min(10, 101 - offset) }, (_, i) =>
          add(true, offset + i),
        ),
      );
    const cohort = await seeded.service.opportunity(
      seeded.recipeId,
      seeded.league,
    );
    expect(cohort.liquidity.own.coverageComplete).toBe(true);
    expect(cohort.liquidity.own.unsoldCount).toBe(101);
    expect(cohort.liquidity.own.oldestUnsoldSeconds).toBeGreaterThanOrEqual(
      7 * 86400,
    );
  }, 20000);

  it('rejects late older evaluations and preserves A to B to A history while deduplicating consecutive decisions', async () => {
    const seeded = await scenario(),
      repository = createIntelligenceRepository(pool);
    const recipe = (await repositories.recipes.findById(seeded.recipeId))!;
    const league = (await repositories.leagues.list()).find(
      (l) => l.gggId === seeded.league,
    )!;
    const key = `synthetic-order-${randomUUID()}`;
    const base = {
      key,
      recipeId: recipe.id,
      recipeHash: recipe.contentHash,
      leagueId: league.id,
      targetSignature: seeded.confirmed.targetSignature,
    };
    const t = Date.parse(seeded.confirmed.signal.evaluatedAt);
    const update = (state: string, offset: number) =>
      repository.updateSignal(
        {
          ...base,
          evaluatedAt: new Date(t + offset).toISOString(),
          observedAt: null,
        },
        () => ({
          document: {
            signal: { evaluatedAt: new Date(t + offset).toISOString(), state },
            evidence: { observedAt: null },
          },
          emit: false,
          evidenceHash: state,
        }),
      );
    await update('A', 0);
    await update('B', 2);
    await expect(update('OLDER', 1)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    expect(await repository.state(key)).toMatchObject({
      signal: { state: 'B' },
    });
    await update('A', 3);
    await Promise.all([update('A', 4), update('A', 4)]);
    const history = await repository.history(key);
    expect(history).toHaveLength(3);
    expect(
      history.map(
        (row) => (row.document as { signal: { state: string } }).signal.state,
      ),
    ).toEqual(['A', 'B', 'A']);
  });

  it('uses saved same-league exchange evidence for divine listings and fails closed on stale or foreign FX', async () => {
    const seeded = await scenario();
    const at = seeded.confirmed.signal.evaluatedAt;
    const exchange = {
      id: randomUUID(),
      schemaVersion: 1 as const,
      kind: 'economy-overview' as const,
      source: 'poe.ninja' as const,
      game: 'poe1' as const,
      league: seeded.league,
      category: 'Currency' as const,
      endpoint: 'https://poe.ninja/synthetic-exchange',
      payloadHash: randomUUID().replaceAll('-', '').repeat(2),
      capturedAt: new Date(Date.parse(at) - 120000).toISOString(),
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange' as const,
      raw: { synthetic: true },
      lines: [
        {
          id: 'divine',
          name: 'Divine Orb',
          detailsId: 'divine-orb',
          baseType: null,
          price: { amount: 200, currency: 'chaos' as const },
          listingCount: null,
          observationCount: 10,
          tradedVolume: null,
        },
      ],
    };
    await createMarketEconomyRepository(pool).save(exchange);
    await pool.query(
      `update raw_snapshots set payload=jsonb_set(payload,'{listings}',(select jsonb_agg(jsonb_set(jsonb_set(entry,'{price}', '{"amount":"1","currency":"divine"}'::jsonb),'{item,currency}','"divine"'::jsonb)) from jsonb_array_elements(payload->'listings') entry)) where dedupe_key=any($1::text[])`,
      [seeded.snapshotIds],
    );
    const converted = await seeded.service.opportunity(
      seeded.recipeId,
      seeded.league,
    );
    expect(converted.liquidity.status, JSON.stringify(converted.reasons)).toBe(
      'supported',
    );
    expect(converted.liquidity.asking?.median).toBe('200');
    await pool.query(
      "update market_economy_snapshots set payload=jsonb_set(payload,'{league}','\"Other league\"'::jsonb) where id=$1",
      [exchange.id],
    );
    expect(
      (await seeded.service.opportunity(seeded.recipeId, seeded.league))
        .liquidity.status,
    ).not.toBe('supported');
    await pool.query(
      "update market_economy_snapshots set payload=jsonb_set(jsonb_set(payload,'{league}',to_jsonb($2::text)),'{capturedAt}',to_jsonb($3::text)) where id=$1",
      [
        exchange.id,
        seeded.league,
        new Date(Date.parse(at) - 7200000).toISOString(),
      ],
    );
    expect(
      (await seeded.service.opportunity(seeded.recipeId, seeded.league))
        .liquidity.status,
    ).not.toBe('supported');
  });

  it('seeds the real PostgreSQL trade mapper for the current recipe version', async () => {
    const source = JSON.parse(
      await readFile(
        new URL(
          '../../../../recipes/flask/quicksilver-alchemist-cheetah.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const id = `default-mapper-${randomUUID()}`;
    const definition = fixtureRecipe({ ...source, id });
    await repositories.recipes.save({
      id,
      active: true,
      contentHash: `revision-${id}`,
      title: 'Synthetic default mapper',
      category: 'flask',
      craftMethod: 'synthetic',
      gameVersion: definition.gameDataVersion,
      tags: ['synthetic'],
      guideMarkdown: 'Synthetic only',
      definition: { ...definition },
    });
    const league = `Default mapper ${randomUUID()}`;
    await repositories.leagues.upsert({
      gggId: league,
      name: league,
      game: 'poe1',
      realm: 'pc',
      startAt: null,
      endAt: null,
      isCurrent: false,
      metadata: { synthetic: true },
      syncedAt: new Date(),
    });
    const result = await seedIntelligenceScenario(pool, {
      recipeId: id,
      league,
    });
    expect(result.first.signal.state).toBe('WATCH');
    expect(result.confirmed.signal.state).toBe('CRAFT');
    expect(result.confirmed.liquidity.sellers).toBe(5);
    const mapping = await pool.query<{ source_revision: string }>(
      "select source_revision from provider_mappings where canonical_id='base:quicksilver-flask-20-quality' and status='active'",
    );
    expect(
      mapping.rows.some((row) =>
        row.source_revision.startsWith('synthetic-fixture:'),
      ),
    ).toBe(true);
  });

  it('moves WATCH to CRAFT on distinct observations, preserves source history and saves a feasible whole-objective plan', async () => {
    const seeded = await scenario();
    expect(seeded.first.signal.state, JSON.stringify(seeded.first)).toBe(
      'WATCH',
    );
    expect(
      seeded.confirmed.signal.state,
      JSON.stringify(seeded.confirmed),
    ).toBe('CRAFT');
    expect(seeded.confirmed.liquidity).toMatchObject({
      status: 'supported',
      sellers: 5,
      listings: 5,
      own: { sampleSize: 3 },
    });
    const historyBefore = await seeded.service.history(
      seeded.recipeId,
      seeded.league,
    );
    await Promise.all([
      seeded.service.opportunity(seeded.recipeId, seeded.league),
      seeded.service.opportunity(seeded.recipeId, seeded.league),
    ]);
    const current = await seeded.service.opportunity(
      seeded.recipeId,
      seeded.league,
    );
    expect(current.signal.confirmations).toBe(
      seeded.confirmed.signal.confirmations,
    );
    const history = await seeded.service.history(
      seeded.recipeId,
      seeded.league,
    );
    expect(history.decisions.length).toBeLessThanOrEqual(
      historyBefore.decisions.length + 1,
    );
    const body = {
      league: seeded.league,
      capital: tx('1000'),
      reserve: tx('100'),
      maxRiskProbability: 0.25,
      maxExposurePercent: 50,
      horizonDays: 30,
      recipeIds: [seeded.recipeId],
      idempotencyKey: randomUUID(),
    };
    const [a, b] = await Promise.all([
      seeded.service.allocate(body),
      seeded.service.allocate(body),
    ]);
    expect(a.id).toBe(b.id);
    expect(
      a.plan.scenarios.some((s) => s.status === 'plan'),
      JSON.stringify(a.plan),
    ).toBe(true);
    expect(a.plan.scenarios[1]?.lines[0]?.objective).toEqual({
      kind: 'attempts',
      count: 1,
    });
    expect(await seeded.service.plan(a.id)).toEqual(a);
    await expect(
      seeded.service.allocate({ ...body, capital: tx('2000') }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const stored = await createIntelligenceRepository(pool).findPlan(a.id);
    expect(stored).toHaveProperty('sources');
    expect(stored).toHaveProperty('candidates');
  });
  it('private API fails closed on changed prices and isolates leagues and missing recipe watchlists', async () => {
    const seeded = await scenario();
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => {},
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { intelligence: seeded.service },
    );
    try {
      const url = `/api/admin/intelligence/recipes/${seeded.recipeId}?league=${encodeURIComponent(seeded.league)}`;
      expect(
        (
          await api.inject({
            url,
            remoteAddress: '203.0.113.10',
            headers: { host: 'example.com' },
          })
        ).statusCode,
      ).toBe(401);
      const response = await api.inject({
        url,
        headers: { host: 'localhost' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(
        (
          await api.inject({
            url: `/api/admin/intelligence/recipes/${seeded.recipeId}?league=unknown`,
            headers: { host: 'localhost' },
          })
        ).statusCode,
      ).toBe(400);
      await pool.query(
        'update recipe_evaluations set estimated_sale_price=50 where league_id=(select id from poe_leagues where ggg_id=$1)',
        [seeded.league],
      );
      const changed = await seeded.service.opportunity(
        seeded.recipeId,
        seeded.league,
      );
      expect(changed.availableRiskOptions).toHaveLength(0);
      expect(changed.signal.state).not.toBe('CRAFT');
      const missing = `unknown-${randomUUID()}`;
      const plan = await seeded.service.allocate({
        league: seeded.league,
        capital: tx('1000'),
        reserve: tx('100'),
        maxRiskProbability: 0.25,
        maxExposurePercent: 50,
        horizonDays: 30,
        recipeIds: [seeded.recipeId, missing],
        idempotencyKey: randomUUID(),
      });
      expect(plan.plan.scenarios.every((s) => s.status === 'hold')).toBe(true);
      expect(
        plan.plan.scenarios[0]?.watchlist.some((r) => r.recipeId === missing),
      ).toBe(true);
    } finally {
      await api.close();
    }
  });
});
