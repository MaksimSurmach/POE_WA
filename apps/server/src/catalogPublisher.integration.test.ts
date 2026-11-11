import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  clusterJewelVariantFilter,
  DomainError,
  mappedTargetFilter,
  RegisteredTradeQueryGenerator,
  type Recipe,
  type RefreshCycle,
} from '@poe-worksmith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateAndPublishCatalog,
  type FreshRecipeEvaluator,
} from './catalogPublisher.js';
import { createCollectorResultPublisher } from './collectorResults.js';
import { createCaptureRepository } from './repositories/captureRepository.js';
import { createMarketEconomyRepository } from './repositories/marketEconomyRepository.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
} from './recipeMarket.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import { planCatalogRefresh } from './refreshPlanner.js';
import {
  createPostgresResourceResolver,
  createPostgresTradeMappingCatalog,
  importTradeMappings,
} from './tradeMappings.js';
import { createPostgresRepositories } from './repositories/postgresRepositories.js';

const pool = createDatabasePool(loadDatabaseConfig());
const repositories = createPostgresRepositories(pool);
const now = new Date('2026-07-20T00:00:00.000Z');
const leagueId = '00000000-0000-4000-8000-000000000001';

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `truncate table jobs, recipe_evaluations, raw_snapshots,
       aggregated_observations, catalog_state, market_queries,
       market_economy_snapshots, market_economy_attempts,
       refresh_cycles, recipes, poe_leagues, game_data_versions restart identity cascade`,
  );
  await pool.query(
    `insert into poe_leagues (id, ggg_id, name, is_current, synced_at)
     values ($1, 'Allflame', 'Allflame', true, now())`,
    [leagueId],
  );
});

function cycle(id: string): RefreshCycle {
  return {
    completedQueries: 0,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    finishedAt: null,
    id,
    leagueId,
    publishedAt: null,
    requestedAt: now,
    startedAt: null,
    status: 'queued',
    totalQueries: 0,
    totalRecipes: 20,
  };
}

function evaluator(failingIds: readonly string[] = []): FreshRecipeEvaluator {
  return async (recipe) => {
    if (failingIds.includes(recipe.id)) throw new DomainError('NO_LISTINGS');
    return {
      confidence: 'high',
      currency: 'chaos',
      estimatedSalePrice: '100',
      expectedCraftCost: '40',
      marginPercent: '60',
      observationId: null,
      profit: '60',
      sourceSnapshotDedupeKey: `snapshot-${recipe.id}`,
    };
  };
}

describe('catalog publication with PostgreSQL', () => {
  it('publishes two methods from legacy snapshots and collector captures with equal economics', async () => {
    const catalog = await loadRecipeCatalog(
      fileURLToPath(new URL('../../../recipes', import.meta.url)),
    );
    const chaos = 'physical-large-cluster-chaos';
    const jagged = 'physical-large-cluster-jagged';
    const ids = [chaos, jagged];
    const recipes = catalog.filter(({ definition }) =>
      ids.includes(definition.id),
    );
    expect(recipes.map(({ definition }) => definition.id).sort()).toEqual(ids);
    await synchronizeRecipes(repositories.recipes, recipes, readFile);
    await pool.query(
      `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
       values ('poe1', '3.29.3.3', 'fixture', 'fixture', 'fixture', 'active')`,
    );
    for (const name of ['physical-large-cluster', 'recipe-catalog']) {
      const manifest = JSON.parse(
        await readFile(
          new URL(
            `../mappings/poe-trade/3.29.3.3/${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await importTradeMappings(pool, {
        ...manifest,
        sourceRevision: manifest.mappingVersion,
      });
    }
    const trade = new RegisteredTradeQueryGenerator(
      createPostgresTradeMappingCatalog(pool),
      [clusterJewelVariantFilter],
      [mappedTargetFilter],
    );
    const marketDependencies = createRecipeMarketDependencies({
      resolveResource: createPostgresResourceResolver(pool),
      trade,
    });
    const economy = createMarketEconomyRepository(pool);
    const fxSnapshotId = randomUUID();
    const appliedFxSnapshotId = randomUUID();
    async function saveEconomy(
      category: 'Currency' | 'Fossil' | 'Resonator',
      id: string,
      detailsId: string,
      name: string,
      amount: number,
      at = now,
    ) {
      await economy.save({
        id,
        schemaVersion: 1,
        kind: 'economy-overview',
        source: 'poe.ninja',
        game: 'poe1',
        league: 'Allflame',
        category,
        endpoint: 'https://poe.ninja/fixture',
        payloadHash: 'a'.repeat(64),
        capturedAt: at.toISOString(),
        sourceUpdatedAt: null,
        priceBasis:
          category === 'Currency' ? 'currency-exchange' : 'stash-estimate',
        raw: {},
        lines: [
          {
            id: detailsId,
            detailsId,
            name,
            baseType: null,
            price: { amount, currency: 'chaos' },
            listingCount: null,
            observationCount: 10,
            tradedVolume: null,
          },
        ],
      });
    }
    await saveEconomy(
      'Currency',
      fxSnapshotId,
      'divine-orb',
      'Divine Orb',
      170,
      new Date(now.getTime() - 60_000),
    );
    await saveEconomy(
      'Currency',
      appliedFxSnapshotId,
      'divine-orb',
      'Divine Orb',
      200,
    );
    const captureStore = createCaptureRepository(pool);
    let outputScheduleId = '';
    let outputCaptureId = '';
    const snapshotTtlMs = 30 * 60_000;
    const plan = await planCatalogRefresh(repositories, {
      league: { leagueId, leagueGggId: 'Allflame', leagueName: 'Allflame' },
      marketDependencies,
      now,
      snapshotTtlMs,
    });
    expect(plan.report).toMatchObject({
      totalRecipes: 2,
      totalQueries: 5,
      deduplicatedDependencies: 1,
    });
    const finishedQueries = plan.queries.filter(
      ({ marketQuery }) =>
        marketQuery.query.handbookTarget &&
        recipeQueryTarget(marketQuery.query.handbookTarget).slot ===
          'crafted-item',
    );
    expect(finishedQueries).toHaveLength(1);
    expect(finishedQueries[0]?.recipeIds).toEqual(ids);

    const clusterMods = [
      'Adds 8 Passive Skills',
      'Added Small Passive Skills grant: 12% increased Physical Damage',
      '2 Added Passive Skills are Jewel Sockets',
    ];
    const notableMods = [
      '1 Added Passive Skill is Battle-Hardened',
      '1 Added Passive Skill is Furious Assault',
      '1 Added Passive Skill is Master the Fundamentals',
    ];
    const sharedSnapshot = 'scheduled-trade:shared-physical-cluster-output';
    for (const { marketQuery, recipeIds } of plan.queries) {
      const target = marketQuery.query.handbookTarget
        ? recipeQueryTarget(marketQuery.query.handbookTarget)
        : null;
      const finished = target?.slot === 'crafted-item';
      const rarity = target?.tradeSearch?.rarity ?? 'normal';
      const amount = target
        ? finished
          ? '15000'
          : rarity === 'rare'
            ? '17'
            : '10'
        : JSON.stringify(marketQuery.query.exchange).includes('jagged-fossil')
          ? '2'
          : '3';
      const sortedSampleComplete =
        target?.slot === 'starting-base' && rarity === 'rare';
      const listings = Array.from(
        { length: finished ? 5 : sortedSampleComplete ? 24 : 1 },
        (_, index) => {
          const account = `seller-${index}`;
          const currency =
            target?.slot === 'starting-base' && rarity === 'normal'
              ? 'divine'
              : 'chaos';
          const id = `${marketQuery.id}-${index}`;
          const ask =
            sortedSampleComplete && index >= 20
              ? '1'
              : currency === 'divine'
                ? '0.05'
                : amount;
          return {
            id,
            account,
            ageSeconds: 60,
            fee: null,
            indexedAt: now.toISOString(),
            price: { amount: ask, currency },
            item: target
              ? {
                  baseType: 'Large Cluster Jewel',
                  rarity,
                  itemLevel: 83,
                  league: 'Allflame',
                  patch: '3.29.3.3',
                  currency,
                  seller: account,
                  status: 'listed',
                  corrupted: false,
                  fractured: false,
                  synthesised: false,
                  influences: [],
                  // Raw modifiers, rather than the saved normalized view, prove the match.
                  mods: [],
                  rawListing: {
                    id,
                    listing: {
                      account: { name: account },
                      price: { amount: Number(ask), currency },
                    },
                    item: {
                      baseType: 'Large Cluster Jewel',
                      rarity,
                      ilvl: 83,
                      verified: true,
                      league: 'Allflame',
                      enchantMods: clusterMods,
                      explicitMods: finished ? notableMods : [],
                    },
                  },
                }
              : { stock: 1000 },
          };
        },
      );
      await repositories.snapshots.save({
        capturedAt: now,
        dedupeKey: finished
          ? sharedSnapshot
          : target
            ? `scheduled-trade:${marketQuery.id}`
            : marketQuery.id,
        expiresAt: new Date(now.getTime() + snapshotTtlMs),
        leagueId,
        marketQueryId: marketQuery.id,
        payload: {
          listings: sortedSampleComplete ? listings.slice(0, 20) : listings,
          coverage: sortedSampleComplete ? 'partial' : 'complete',
          sortedSampleComplete,
          totalResults: listings.length,
        },
        providerStatus: 200,
        refreshCycleId: plan.cycle.id,
      });
      if (target) {
        const scheduleId = randomUUID();
        await pool.query(
          `insert into collector_schedule (id, kind, key, league_id, payload, interval_minutes, next_due_at)
           values ($1, 'trade-target', $2, $3, $4, 60, $5)`,
          [scheduleId, marketQuery.canonicalHash, leagueId, { recipeIds }, now],
        );
        const capture = {
          scheduleId,
          capturedAt: now,
          reportedTotal: listings.length,
          fetched: listings.length,
          complete: true,
          sortedSampleIds: sortedSampleComplete
            ? listings.slice(0, 20).map(({ id }) => id)
            : null,
          durationMs: 0,
          fxSnapshotId,
          slices: 1,
          listings: listings.map(({ account, id, indexedAt, item, price }) => ({
            itemId: id,
            seller: account,
            indexedAt: new Date(indexedAt),
            fingerprint: null,
            item: { rawItem: item.rawListing?.item ?? null },
            price,
            priceChaos: price.currency === 'divine' ? '8.5' : price.amount,
          })),
        };
        if (finished) {
          const [first] = capture.listings;
          await captureStore.saveCapture({
            ...capture,
            capturedAt: new Date(now.getTime() - 60_000),
            fetched: 1,
            complete: false,
            listings: [
              {
                ...first!,
                price: { amount: '1', currency: 'chaos' },
                priceChaos: '1',
              },
            ],
          });
        }
        const captureId = await captureStore.saveCapture(capture);
        if (finished) {
          outputScheduleId = scheduleId;
          outputCaptureId = captureId;
        }
      }
    }
    await repositories.cycles.save({
      ...plan.cycle,
      completedQueries: plan.queries.length,
    });

    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: plan.cycle.id,
      league: 'Allflame',
      marketDependencies,
      economy,
      now,
    });
    expect(report).toMatchObject({
      published: true,
      completedRecipes: 2,
      failedRecipes: 0,
    });
    const published = await repositories.catalog.getPublished();
    expect(published?.evaluations).toHaveLength(2);
    for (const [id, base, cost, profit] of [
      [chaos, '17', 11519, 3481],
      [jagged, '10', 525, 14475],
    ] as const) {
      const evaluation = published?.evaluations.find(
        ({ recipeId }) => recipeId === id,
      );
      expect(evaluation).toMatchObject({
        status: 'success',
        sourceSnapshotDedupeKey: sharedSnapshot,
        methodCost: {
          baseCost: { amount: base, currency: 'chaos' },
          saleEvidence: { grade: 'A', comparableSellers: 5 },
        },
      });
      expect(Number(evaluation?.estimatedSalePrice)).toBe(15000);
      expect(Number(evaluation?.expectedCraftCost)).toBe(cost);
      expect(Number(evaluation?.profit)).toBe(profit);
    }

    // The old scheduled publisher uses poe.ninja instead of Trade exchange fallback.
    await saveEconomy(
      'Fossil',
      randomUUID(),
      'jagged-fossil',
      'Jagged Fossil',
      2,
    );
    await saveEconomy(
      'Resonator',
      randomUUID(),
      'primitive-chaotic-resonator',
      'Primitive Chaotic Resonator',
      3,
    );
    const baselineCycle = { ...cycle(randomUUID()), totalRecipes: 2 };
    await repositories.cycles.save(baselineCycle);
    const baseline = await evaluateAndPublishCatalog(repositories, {
      allowMissingOutput: true,
      cycleId: baselineCycle.id,
      league: 'Allflame',
      marketDependencies: createRecipeMarketDependencies({
        trade,
        resolveResource: async () => null,
      }),
      economy,
      now,
    });
    const client = await pool.connect();
    try {
      const publishResults = createCollectorResultPublisher(pool, async () => ({
        maximumQuoteAgeMs: snapshotTtlMs,
        freshnessWarningMs: snapshotTtlMs,
      }));
      const publish = (
        at: Date,
        kind: 'trade-target' | 'economy' = 'trade-target',
      ) =>
        publishResults(
          {
            kind,
            leagueId,
            payload:
              kind === 'trade-target'
                ? { recipeIds: ids }
                : { league: 'Allflame' },
          },
          at,
          client,
        );
      const readResults = () =>
        client.query(
          'select recipe_id, result from recipe_results order by recipe_id',
        );
      await client.query('begin');
      await publish(now);
      const { rows } = await readResults();
      expect(rows).toHaveLength(2);
      for (const { recipe_id: recipeId, result } of rows) {
        const old = baseline.evaluations.find(
          (entry) => entry.recipeId === recipeId,
        )!;
        expect(old.status).toBe('success');
        expect(old.methodCost?.budget).toMatchObject({
          p50: expect.any(String),
          p90: expect.any(String),
        });
        expect(result).toMatchObject({
          status: 'success',
          methodCost: {
            source: {
              captureId: outputCaptureId,
              captureFxSnapshotId: fxSnapshotId,
              coverage: 'complete',
              sampleSize: 5,
            },
            saleEvidence: { grade: 'A' },
            budget: old.methodCost?.budget,
          },
        });
        if (recipeId === jagged) {
          expect(result.methodCost.materialEvidence.base).toMatchObject({
            captureFxSnapshotId: fxSnapshotId,
            marketExchange: {
              snapshotId: appliedFxSnapshotId,
              verifiedAt: now.toISOString(),
              chaosPerDivine: 200,
            },
          });
        }
        expect(Number(result.estimatedSalePrice)).toBe(
          Number(old.estimatedSalePrice),
        );
        expect(Number(result.expectedCraftCost)).toBe(
          Number(old.expectedCraftCost),
        );
        expect(Number(result.profit)).toBe(Number(old.profit));
      }
      const readHistory = async () =>
        (
          await client.query(
            'select recipe_id, ask, comparable_sellers, coverage from recipe_price_observations where source_snapshot_dedupe_key = $1 order by recipe_id',
            [`collector:${outputCaptureId}`],
          )
        ).rows;
      const history = await readHistory();
      expect(history).toMatchObject([
        {
          recipe_id: chaos,
          ask: '15000.00000000',
          comparable_sellers: 5,
          coverage: 'complete',
        },
        {
          recipe_id: jagged,
          ask: '15000.00000000',
          comparable_sellers: 5,
          coverage: 'complete',
        },
      ]);
      await publish(now, 'economy');
      expect(await readHistory()).toEqual(history);
      await client.query('commit');

      // Old active asks still exist after a partial capture, but are not fresh sightings.
      for (const [i, complete] of [false, true].entries()) {
        const at = new Date(now.getTime() + (i + 1) * 60_000);
        const latest = await captureStore.saveCapture({
          scheduleId: outputScheduleId,
          capturedAt: at,
          reportedTotal: complete ? 0 : 5,
          fetched: 0,
          complete,
          durationMs: 0,
          slices: 1,
          listings: [],
        });
        await client.query('begin');
        await publish(at);
        for (const { result } of (await readResults()).rows) {
          expect(result).toMatchObject({
            estimatedSalePrice: null,
            profit: null,
            methodCost: {
              marketStatus: complete ? 'empty' : 'partial',
              source: {
                captureId: latest,
                sampleSize: 0,
                coverage: complete ? 'complete' : 'partial',
                sortedSampleComplete: false,
              },
            },
          });
        }
        await client.query('commit');
      }
      await client.query('begin');
      await publish(
        new Date(now.getTime() + snapshotTtlMs + 120_000),
        'economy',
      );
      for (const { result } of (await readResults()).rows) {
        expect(result).toMatchObject({
          expectedCraftCost: null,
          estimatedSalePrice: null,
          profit: null,
          methodCost: { marketStatus: 'unavailable' },
        });
        expect(result.methodCost.source).toBeUndefined();
      }
      await client.query('commit');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('atomically publishes 95%, keeps stale fallback, and rejects 90%', async () => {
    for (let index = 1; index <= 20; index += 1) {
      const id = `recipe-${String(index).padStart(2, '0')}`;
      const recipe: Recipe = {
        active: true,
        category: 'jewel',
        contentHash: `content-${id}`,
        craftMethod: 'harvest',
        definition: {},
        gameVersion: '3.25',
        guideMarkdown: '# Guide',
        id,
        tags: ['profit'],
        title: `Recipe ${id}`,
      };
      await repositories.recipes.save(recipe);
    }

    const baselineId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await repositories.cycles.save(cycle(baselineId));
    await evaluateAndPublishCatalog(repositories, {
      cycleId: baselineId,
      evaluateRecipe: evaluator(),
      league: 'Mercenaries',
      now,
    });

    const boundaryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await repositories.cycles.save(cycle(boundaryId));
    const boundary = await evaluateAndPublishCatalog(repositories, {
      cycleId: boundaryId,
      evaluateRecipe: evaluator(['recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 1000),
    });
    const publishedAtBoundary = await repositories.catalog.getPublished();
    expect(boundary).toMatchObject({
      completedRecipes: 19,
      failedRecipes: 1,
      published: true,
      staleFallbacks: 1,
    });
    expect(publishedAtBoundary?.cycle.id).toBe(boundaryId);
    expect(publishedAtBoundary?.evaluations).toHaveLength(20);
    expect(
      publishedAtBoundary?.evaluations.every(
        ({ refreshCycleId }) => refreshCycleId === boundaryId,
      ),
    ).toBe(true);
    expect(
      publishedAtBoundary?.evaluations.find(
        ({ recipeId }) => recipeId === 'recipe-20',
      ),
    ).toMatchObject({ status: 'stale' });

    const rejectedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await repositories.cycles.save(cycle(rejectedId));
    const rejected = await evaluateAndPublishCatalog(repositories, {
      cycleId: rejectedId,
      evaluateRecipe: evaluator(['recipe-19', 'recipe-20']),
      league: 'Mercenaries',
      now: new Date(now.getTime() + 2000),
    });
    const stillPublished = await repositories.catalog.getPublished();
    expect(rejected).toMatchObject({
      completedRecipes: 18,
      failedRecipes: 2,
      published: false,
    });
    expect(stillPublished?.cycle.id).toBe(boundaryId);
    expect(
      stillPublished?.evaluations.every(
        ({ refreshCycleId }) => refreshCycleId === boundaryId,
      ),
    ).toBe(true);
  });
});
