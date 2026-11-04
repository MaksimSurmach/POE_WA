import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  hashMarketQuery,
  validateRecipeDocument,
  RegisteredTradeQueryGenerator,
  noVariantFilter,
  mappedTargetFilter,
  outcomeAnalysisInputSchema,
  riskSimulationRequestSchema,
  simulateCraftingRisk,
  outcomeCalculationVersion,
  factoryBatchSchema,
  factoryEventSchema,
  intelligenceSettingsSchema,
} from '@poe-worksmith/domain';
import { clusterJewelVariantFilter } from '@poe-worksmith/domain';
import { createPostgresRepositories } from '../repositories/postgresRepositories.js';
import {
  createCraftAnalysisRepository,
  craftRequestHash,
} from '../repositories/craftAnalysisRepository.js';
import { createFactoryRepository } from '../repositories/factoryRepository.js';
import { createMarketEconomyRepository } from '../repositories/marketEconomyRepository.js';
import { createIntelligenceRepository } from '../repositories/intelligenceRepository.js';
import { createCraftAnalysisService } from '../craftAnalysis.js';
import { createIntelligenceService } from '../intelligence.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
  type RecipeMarketDependencies,
} from '../recipeMarket.js';
import {
  createPostgresTradeMappingCatalog,
  importTradeMappings,
  createPostgresResourceResolver,
} from '../tradeMappings.js';

/** Explicit synthetic evidence only; requires an isolated test DB and an already seeded catalog. */
export async function seedIntelligenceScenario(
  pool: Pool,
  input: {
    recipeId: string;
    league: string;
    now?: Date;
    marketDependencies?: RecipeMarketDependencies;
  },
) {
  if (process.env.APP_ENV !== 'test')
    throw new Error('Synthetic intelligence fixture requires APP_ENV=test');
  const database = await pool.query<{ name: string }>(
    'select current_database() as name',
  );
  if (database.rows[0]?.name !== 'poe_worksmith_test')
    throw new Error(
      'Synthetic intelligence fixture requires poe_worksmith_test',
    );
  const at = input.now ?? new Date(),
    atMs = at.getTime();
  let clock = new Date(atMs - 120_000);
  const repositories = createPostgresRepositories(pool),
    models = createCraftAnalysisRepository(pool),
    factory = createFactoryRepository(pool),
    intelligence = createIntelligenceRepository(pool);
  const recipe =
    (await repositories.recipes.findById(input.recipeId)) ??
    (() => {
      throw new Error('Seed catalog recipe first');
    })();
  if (!recipe) throw new Error('Seed catalog recipe first');
  const league =
    (await repositories.leagues.list()).find((l) => l.gggId === input.league) ??
    (() => {
      throw new Error('Seed league first');
    })();
  if (!league) throw new Error('Seed league first');
  const definition = validateRecipeDocument(recipe.definition);
  if (!input.marketDependencies) {
    // The browser baseline carries an older fixture version. Preserve its rows;
    // activate an explicitly labelled test version for the current recipe.
    const active = await pool.query<{ id: string; patch_version: string }>(
      "select id,patch_version from game_data_versions where game='poe1' and status='active'",
    );
    if (active.rows[0]?.patch_version !== definition.gameDataVersion) {
      await pool.query(
        "update game_data_versions set status='archived' where game='poe1' and status='active'",
      );
      await pool.query(
        "insert into game_data_versions(game,patch_version,source,source_revision,status,manifest_hash,activated_at) values('poe1',$1,'synthetic-intelligence-test-only','labelled-synthetic','active',$2,now())",
        [
          definition.gameDataVersion,
          craftRequestHash({
            synthetic: true,
            patch: definition.gameDataVersion,
          }),
        ],
      );
    }
    const manifest = z
      .object({
        mappingVersion: z.string(),
        mappings: z.array(
          z.object({
            entityKind: z.enum(['base', 'mod', 'modFamily', 'resource']),
            canonicalId: z.string(),
            externalId: z.string(),
            discriminator: z.string().optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            new URL(
              `../../mappings/poe-trade/${definition.gameDataVersion}/recipe-catalog.json`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
    const wanted = new Set([
      definition.base.baseId,
      definition.startingBase.baseId,
      ...Object.values(definition.target)
        .flat()
        .flatMap((mod) =>
          [mod.modId, mod.modFamilyId].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      ...definition.craft.startingMods.map((mod) => mod.modId),
      ...definition.craft.steps.flatMap((step) =>
        step.materials.map((material) => material.itemId),
      ),
    ]);
    const mappings = manifest.mappings.filter((mapping) =>
      wanted.has(mapping.canonicalId),
    );
    await importTradeMappings(pool, {
      gameDataVersion: definition.gameDataVersion,
      mappings,
      sourceRevision: `synthetic-fixture:${manifest.mappingVersion}`,
    });
  }
  const dependencies =
    input.marketDependencies ??
    createRecipeMarketDependencies({
      trade: new RegisteredTradeQueryGenerator(
        createPostgresTradeMappingCatalog(pool),
        [noVariantFilter, clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
      resolveResource: createPostgresResourceResolver(pool),
    });
  const query = (
    await dependencies({ recipe: definition, league: input.league })
  ).find((d) => d.kind === 'target')!.query!;
  const queryHash = await hashMarketQuery({ ...query, league: input.league });
  const existing =
    await repositories.marketQueries.findByCanonicalHash(queryHash);
  const marketQuery =
    existing ??
    (await repositories.marketQueries.save({
      id: randomUUID(),
      recipeId: recipe.id,
      provider: query.provider,
      canonicalHash: queryHash,
      query: query.query,
      active: true,
    }));
  const target = recipeQueryTarget(query.query.handbookTarget);
  const cycleId = randomUUID();
  await repositories.cycles.save({
    id: cycleId,
    leagueId: league.id,
    requestedAt: new Date(atMs - 300_000),
    startedAt: null,
    finishedAt: null,
    publishedAt: null,
    status: 'queued',
    completedQueries: 0,
    completedRecipes: 0,
    errorMessage: null,
    failedQueries: 0,
    failedRecipes: 0,
    totalQueries: 1,
    totalRecipes: 1,
  });
  const snapshotIds: string[] = [];
  async function snapshot(offset: number) {
    const capturedAt = new Date(atMs - offset),
      id = `synthetic-intelligence:${randomUUID()}`;
    snapshotIds.push(id);
    const listings = Array.from({ length: 5 }, (_, i) => ({
      id: `synthetic-listing-${i}`,
      account: `synthetic-independent-seller-${i}`,
      ageSeconds: 30,
      fee: null,
      indexedAt: new Date(capturedAt.getTime() - 30_000).toISOString(),
      price: { amount: '200', currency: 'chaos' },
      item: {
        synthetic: true,
        source: 'Labelled deterministic test scenario; not live market data',
        league: input.league,
        patch: target.patch,
        baseType: target.baseTypes[0],
        rarity: target.tradeSearch?.rarity ?? 'rare',
        itemLevel: target.minItemLevel ?? 84,
        quality: target.qualityMin ?? 0,
        corrupted: target.corrupted ?? false,
        synthesised: target.synthesised ?? false,
        fractured: target.tradeSearch?.fractured ?? false,
        influences: target.influences ?? [],
        seller: `synthetic-independent-seller-${i}`,
        status: 'listed',
        currency: 'chaos',
        modsComplete: true,
        mods:
          target.tradeSearch?.groups.flatMap((g) =>
            g.filters.map((f) => ({
              id: f.id,
              value: f.min ?? f.max ?? 1,
              tier: f.exactTier ?? f.minTier ?? 1,
            })),
          ) ?? [],
      },
    }));
    await repositories.snapshots.save({
      dedupeKey: id,
      marketQueryId: marketQuery.id,
      leagueId: league.id,
      refreshCycleId: cycleId,
      capturedAt,
      expiresAt: new Date(atMs + 1800_000),
      providerStatus: 200,
      payload: {
        synthetic: true,
        coverage: 'complete',
        sortedPageComplete: true,
        sortedSampleComplete: true,
        totalResults: listings.length,
        listings,
      },
    });
    await repositories.evaluations.save({
      recipeId: recipe.id,
      leagueId: league.id,
      refreshCycleId: cycleId,
      currency: 'chaos',
      estimatedSalePrice: '200',
      expectedCraftCost: null,
      profit: null,
      marginPercent: null,
      confidence: 'high',
      status: 'success',
      errorCode: null,
      evaluatedAt: capturedAt,
      lastSuccessfulAt: capturedAt,
      observationId: null,
      sourceSnapshotDedupeKey: id,
      methodCost: {
        synthetic: true,
        recipeContentHash: recipe.contentHash,
        oldestInputAt: capturedAt.toISOString(),
        expiresAt: new Date(atMs + 1800_000).toISOString(),
        source: {
          capturedAt: capturedAt.toISOString(),
          sampleSize: 5,
          coverage: 'complete',
          currencyAvailable: true,
          priceBasis: 'asking',
          sortedSampleComplete: true,
        },
        saleEvidence: { status: 'accepted' },
        materialEvidence: {},
      },
    });
    return id;
  }
  await snapshot(300_000);
  await snapshot(180_000);
  const analysis = createCraftAnalysisService({
    repository: models,
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    maximumQuoteAgeMs: async () => 3600_000,
    clock: () => clock,
    runWorker: false,
  });
  const provenance = {
    kind: 'assumption',
    reference: 'synthetic:intelligence-fixed-cost',
    recordedAt: new Date(atMs - 300_000).toISOString(),
    notes: 'Labelled synthetic deterministic outcome. Not game observations.',
  };
  const latest = await models.latestModel(
    recipe.id,
    recipe.contentHash,
    league.id,
  );
  const model = await analysis.saveModel({
    recipeId: recipe.id,
    recipeHash: recipe.contentHash,
    league: input.league,
    expectedRevision: latest?.revision ?? null,
    idempotencyKey: randomUUID(),
    currency: 'chaos',
    model: {
      version: 1,
      id: 'synthetic-intelligence',
      startStageId: 'roll',
      stages: [
        {
          id: 'roll',
          name: 'Synthetic complete craft',
          costs: [
            {
              kind: 'material',
              resourceId: 'synthetic-input',
              quantity: '1',
              provenance,
            },
          ],
          exclusivity: { mode: 'disjoint', provenance },
          outcomes: [
            {
              id: 'target',
              name: 'Synthetic exact target',
              classification: 'target',
              probability: { value: '1', provenance },
              nextStageId: null,
              targetSuccess: true,
              sellable: true,
              matching: {
                kind: 'exact-target',
                targetSignature: definition.targetSignature,
              },
            },
          ],
        },
      ],
    },
    prices: {
      'synthetic-input': { amount: '10', currency: 'chaos', provenance },
    },
    valuations: {},
  });
  const current = await analysis.readAnalysis(recipe.id, input.league, true);
  const resolved = outcomeAnalysisInputSchema.parse({
    model: model.model,
    currency: model.currency,
    league: input.league,
    now: clock.toISOString(),
    prices: current.prices,
    valuations: current.valuations,
  });
  const request = riskSimulationRequestSchema.parse({
    analysis: resolved,
    objective: { kind: 'attempts', count: 1 },
    seed: 'labelled-synthetic-intelligence',
    trials: 10000,
    budget: '100',
    maxTransitions: 1000,
  });
  const result = await simulateCraftingRisk(request);
  const run = await models.createRun({
    model,
    idempotencyKey: randomUUID(),
    requestHash: craftRequestHash(request),
    calculationVersion: outcomeCalculationVersion,
    request,
  });
  await pool.query(
    "update craft_risk_runs set status='completed',progress=100,result=$2,started_at=$3,finished_at=$3 where id=$1",
    [run.id, result, clock],
  );
  const tx = (price: string) => ({
    quantity: '1',
    unitPrice: price,
    currency: 'chaos' as const,
    chaosPerUnit: '1',
    rateSource: 'synthetic actual transaction',
  });
  const batch = factoryBatchSchema.parse({
    id: randomUUID(),
    recipeId: recipe.id,
    recipeHash: recipe.contentHash,
    targetSignature: definition.targetSignature,
    leagueId: league.id,
    league: input.league,
    accountingCurrency: 'chaos',
    startedAt: new Date(atMs - 7 * 86400_000).toISOString(),
    plannedBudget: tx('100'),
    notes: 'Labelled synthetic confirmed sales, not real transactions',
    forecast: null,
  });
  let record = await factory.create(
    batch,
    randomUUID(),
    craftRequestHash(batch),
    clock.toISOString(),
  );
  async function event(payload: unknown, time: number) {
    const e = factoryEventSchema.parse({
      id: randomUUID(),
      occurredAt: new Date(time).toISOString(),
      source: 'synthetic:intelligence-own-sales',
      notes: 'Labelled synthetic only',
      payload,
    });
    record = await factory.append(
      batch.id,
      record.version,
      e,
      randomUUID(),
      clock.toISOString(),
    );
    return e;
  }
  const cost = await event(
    { type: 'expense', category: 'crafting', transaction: tx('30') },
    atMs - 6 * 86400_000,
  );
  for (let i = 0; i < 3; i++) {
    const itemId = randomUUID();
    await event(
      {
        type: 'produce',
        itemId,
        description: 'Synthetic target',
        modifiers: [],
        outcome: 'target',
        classification: 'target',
        targetSignature: definition.targetSignature,
        allocations: [{ costEventId: cost.id, amount: '10' }],
      },
      atMs - 3 * 86400_000,
    );
    await event(
      { type: 'list', itemId, price: tx('200') },
      atMs - 2 * 86400_000,
    );
    await event(
      { type: 'sale', itemId, transaction: tx('200'), expenses: [] },
      atMs - 86400_000,
    );
  }
  const service = createIntelligenceService({
    repository: intelligence,
    economy: createMarketEconomyRepository(pool),
    factory,
    analysis,
    recipes: repositories.recipes,
    leagues: repositories.leagues,
    marketDependencies: dependencies,
    settings: async () => intelligenceSettingsSchema.parse({}),
    maximumQuoteAgeMs: async () => 3600_000,
    clock: () => clock,
    runWorker: false,
  });
  const first = await service.opportunity(recipe.id, input.league);
  await snapshot(60_000);
  clock = at;
  const confirmed = await service.opportunity(recipe.id, input.league);
  return {
    recipeId: recipe.id,
    league: input.league,
    modelId: model.id,
    riskRunId: run.id,
    batchId: batch.id,
    snapshotIds,
    first,
    confirmed,
    service,
    analysis,
  };
}
