import { describe, expect, it } from 'vitest';
import {
  createInMemoryRepositories,
  hashMarketQuery,
  mappedTargetFilter,
  noVariantFilter,
  RegisteredTradeQueryGenerator,
  type CanonicalJsonObject,
  type RefreshCycle,
} from '@poe-worksmith/domain';
import { fixtureRecipe } from '@poe-worksmith/domain/fixtures';
import { evaluateAndPublishCatalog } from './catalogPublisher.js';
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
} from './recipeMarket.js';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import {
  summarizeEconomy,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';

const now = new Date('2026-11-03T12:00:00Z');
const minute = 60_000;
const dependencies = createRecipeMarketDependencies({
  trade: new RegisteredTradeQueryGenerator(
    {
      resolveBase: async ({ baseId }) => ({
        ok: true,
        diagnostics: [],
        value: { id: baseId, mappingVersion: 'fixture' },
      }),
      resolveTarget: async () => ({
        ok: true,
        diagnostics: [],
        value: { id: 'explicit.stat_1' },
      }),
    },
    [noVariantFilter],
    [mappedTargetFilter],
  ),
  resolveResource: async (id) => id,
});

async function evaluate(
  options: {
    recipe?: ReturnType<typeof fixtureRecipe>;
    materialStock?: number;
    foreign?: 'matching' | 'rejected';
    materialAgeMinutes?: number;
    materialExpiryMinutes?: number;
    maximumQuoteAgeMs?: number;
    sellers?: number;
    convertedAt?: string;
    convertedVerifiedAt?: string;
    economy?: StoredMarketEconomySnapshot;
    revalidatedAt?: string;
  } = {},
) {
  const repositories = createInMemoryRepositories();
  const recipe = options.recipe ?? fixtureRecipe();
  await synchronizeRecipes(
    repositories.recipes,
    [
      {
        definition: recipe,
        assets: [],
        markdown: '',
        sourcePath: 'fixture.json',
      },
    ],
    async () => Buffer.from(''),
  );
  const league = await repositories.leagues.upsert({
    game: 'poe1',
    realm: 'pc',
    gggId: 'Mercenaries',
    name: 'Mercenaries',
    isCurrent: true,
    startAt: null,
    endAt: null,
    metadata: {},
    syncedAt: now,
  });
  const queries = await dependencies({ recipe, league: league.gggId });
  const cycle: RefreshCycle = {
    id: 'evidence-cycle',
    leagueId: league.id,
    status: 'queued',
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    publishedAt: null,
    errorMessage: null,
    completedQueries: queries.length,
    failedQueries: 0,
    totalQueries: queries.length,
    completedRecipes: 0,
    failedRecipes: 0,
    totalRecipes: 1,
  };
  await repositories.cycles.save(cycle);
  for (const [index, dependency] of queries.entries()) {
    const query = dependency.query!;
    const material = dependency.kind === 'material';
    const target = query.query.handbookTarget
      ? recipeQueryTarget(query.query.handbookTarget)
      : null;
    const capturedAt = new Date(
      now.getTime() -
        (material ? (options.materialAgeMinutes ?? 0) : 0) * minute,
    );
    const item = (seller: string, currency: string): CanonicalJsonObject =>
      target
        ? {
            baseType: target.baseTypes[0]!,
            rarity: target.tradeSearch!.rarity,
            league: target.league,
            patch: target.patch,
            currency,
            itemLevel: 84,
            corrupted: false,
            fractured: false,
            synthesised: false,
            influences: [],
            seller,
            status: 'listed',
            mods: [],
            modsComplete: true,
          }
        : { stock: options.materialStock ?? 100000 };
    const listings = Array.from(
      { length: dependency.kind === 'target' ? (options.sellers ?? 2) : 2 },
      (_, i) => ({
        id: `${index}-${i}`,
        account: `seller-${i}`,
        ageSeconds: 60,
        fee: null,
        indexedAt: now.toISOString(),
        item: item(`seller-${i}`, 'chaos'),
        price: {
          amount: String(
            (material ? 2 : dependency.kind === 'base' ? 10 : 300) + i * 20,
          ),
          currency: 'chaos',
        },
      }),
    );
    if (dependency.kind === 'target' && options.foreign)
      listings.push({
        ...listings[0]!,
        id: 'foreign',
        account: 'foreign-seller',
        price: { amount: '1', currency: 'divine' },
        item: {
          ...item('foreign-seller', 'divine'),
          ...(options.foreign === 'rejected'
            ? { baseType: 'Unrelated base' }
            : {}),
        },
      });
    if (dependency.kind === 'target' && options.convertedAt)
      listings[0]!.item = {
        ...listings[0]!.item,
        exchange: {
          capturedAt: options.convertedAt,
          league: league.gggId,
          snapshotId: options.economy?.id ?? 'old-rate',
          chaosPerDivine: 150,
          ...(options.convertedVerifiedAt
            ? { verifiedAt: options.convertedVerifiedAt }
            : {}),
        },
      };
    const canonicalHash = await hashMarketQuery({
      league: league.gggId,
      ...query,
    });
    await repositories.marketQueries.save({
      id: `query-${index}`,
      active: true,
      canonicalHash,
      provider: query.provider,
      query: query.query,
      recipeId: recipe.id,
    });
    await repositories.snapshots.save({
      capturedAt,
      dedupeKey: `snapshot-${index}`,
      expiresAt: new Date(
        now.getTime() +
          (material ? (options.materialExpiryMinutes ?? 30) : 30) * minute,
      ),
      leagueId: league.id,
      marketQueryId: `query-${index}`,
      providerStatus: 200,
      refreshCycleId: cycle.id,
      payload: {
        listings,
        coverage: 'complete',
        totalResults: listings.length,
        sortedPageComplete: true,
      },
    });
  }
  const report = await evaluateAndPublishCatalog(repositories, {
    cycleId: cycle.id,
    league: league.gggId,
    now,
    marketDependencies: dependencies,
    ...(options.maximumQuoteAgeMs
      ? { maximumQuoteAgeMs: options.maximumQuoteAgeMs }
      : {}),
    ...(options.economy
      ? {
          economy: {
            find: async () => options.economy!,
            latest: async (_, category) =>
              category === 'Currency'
                ? summarizeEconomy(options.economy!)
                : null,
            listAttempts: async () =>
              options.revalidatedAt
                ? [
                    {
                      id: '22222222-2222-4222-8222-222222222222',
                      league: 'Mercenaries',
                      category: 'Currency' as const,
                      startedAt: options.revalidatedAt,
                      completedAt: now.toISOString(),
                      status: 'succeeded' as const,
                      cacheStatus: 'revalidated' as const,
                      errorCode: null,
                      snapshotId: options.economy!.id,
                    },
                  ]
                : [],
          },
        }
      : {}),
  });
  return { evaluation: report.evaluations[0]!, repositories, cycle };
}

describe('catalog input evidence', () => {
  it.each([9, 10])(
    'requires total stock across steps before pricing the craft (stock %i)',
    async (stock) => {
      const source = fixtureRecipe();
      const step = source.craft.steps[0]!;
      const material = step.materials[0]!;
      const evidence = source.craft.expectedExecutions![0]!.evidence;
      const recipe = fixtureRecipe({
        ...source,
        craft: {
          ...source.craft,
          steps: [
            { ...step, id: 'roll', materials: [{ ...material, quantity: 2 }] },
            {
              ...step,
              id: 'finish',
              materials: [{ ...material, quantity: 1 }],
            },
          ],
          expectedExecutions: [
            { stepId: 'roll', count: 3, evidence },
            { stepId: 'finish', count: 4, evidence },
          ],
        },
      });
      const { evaluation } = await evaluate({ recipe, materialStock: stock });
      expect(evaluation).toMatchObject(
        stock === 10
          ? {
              status: 'success',
              expectedCraftCost: '30',
              profit: '270',
              marginPercent: '900',
            }
          : {
              status: 'partial',
              expectedCraftCost: null,
              profit: null,
              marginPercent: null,
            },
      );
    },
  );

  it('withholds a price floor when a matching divine ask cannot be converted', async () => {
    const { evaluation } = await evaluate({ foreign: 'matching' });
    expect(evaluation).toMatchObject({
      status: 'partial',
      estimatedSalePrice: null,
      profit: null,
      marginPercent: null,
    });
    expect(evaluation.expectedCraftCost).not.toBeNull();
  });

  it('does not let an unrelated divine item invalidate matching chaos asks', async () => {
    const { evaluation } = await evaluate({ foreign: 'rejected' });
    expect(evaluation).toMatchObject({
      status: 'success',
      estimatedSalePrice: '300',
    });
    expect(evaluation.profit).not.toBeNull();
  });

  it('bounds the estimate by the material quote actually used', async () => {
    const { evaluation } = await evaluate({
      materialAgeMinutes: 22,
      materialExpiryMinutes: 2,
    });
    expect(evaluation.methodCost).toMatchObject({
      oldestInputAt: new Date(now.getTime() - 22 * minute).toISOString(),
      expiresAt: new Date(now.getTime() + 2 * minute).toISOString(),
    });
  });

  it('rejects a material quote older than the operator maximum age even before its cache TTL', async () => {
    const { evaluation } = await evaluate({
      materialAgeMinutes: 15,
      maximumQuoteAgeMs: 10 * minute,
    });
    expect(evaluation).toMatchObject({
      status: 'partial',
      expectedCraftCost: null,
      profit: null,
    });
  });

  it('does not invent a successful time when a partial estimate falls back', async () => {
    const { evaluation, repositories, cycle } = await evaluate({ sellers: 1 });
    await repositories.evaluations.save({
      ...evaluation,
      methodCost: {
        recipeContentHash: evaluation.methodCost!.recipeContentHash,
      },
    });
    await repositories.cycles.save({ ...cycle, id: 'fallback-cycle' });
    const report = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'fallback-cycle',
      league: 'Mercenaries',
      now: new Date(now.getTime() + minute),
      evaluateRecipe: async () => {
        throw new Error('provider unavailable');
      },
    });
    expect(report.evaluations[0]).toMatchObject({
      status: 'stale',
      lastSuccessfulAt: null,
      profit: null,
      methodCost: { oldestInputAt: now.toISOString() },
    });
    await repositories.cycles.save({ ...cycle, id: 'repeated-fallback' });
    const repeated = await evaluateAndPublishCatalog(repositories, {
      cycleId: 'repeated-fallback',
      league: 'Mercenaries',
      now: new Date(now.getTime() + 2 * minute),
      evaluateRecipe: async () => {
        throw new Error('provider still unavailable');
      },
    });
    expect(repeated.evaluations[0]?.methodCost?.oldestInputAt).toBe(
      now.toISOString(),
    );
  });

  it('withholds converted asks whose embedded FX evidence is already too old', async () => {
    const { evaluation } = await evaluate({
      convertedAt: new Date(now.getTime() - 120 * minute).toISOString(),
    });
    expect(evaluation).toMatchObject({
      status: 'partial',
      estimatedSalePrice: null,
      profit: null,
    });
  });

  it('does not let an unused old exchange observation expire a chaos-only calculation', async () => {
    const snapshot: StoredMarketEconomySnapshot = {
      id: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      league: 'Mercenaries',
      category: 'Currency',
      endpoint: 'https://example.com/fixture',
      payloadHash: 'a'.repeat(64),
      capturedAt: new Date(now.getTime() - 45 * minute).toISOString(),
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange',
      raw: {},
      lines: [],
    };
    const { evaluation } = await evaluate({ economy: snapshot });
    expect(evaluation.methodCost).toMatchObject({
      oldestInputAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * minute).toISOString(),
    });
  });

  it('uses the recorded FX verification time without repricing a converted ask', async () => {
    const verifiedAt = new Date(now.getTime() - minute).toISOString();
    const { evaluation } = await evaluate({
      convertedAt: new Date(now.getTime() - 120 * minute).toISOString(),
      convertedVerifiedAt: verifiedAt,
    });
    expect(evaluation).toMatchObject({
      status: 'success',
      estimatedSalePrice: '300',
      methodCost: {
        oldestInputAt: verifiedAt,
        expiresAt: new Date(now.getTime() + 29 * minute).toISOString(),
      },
    });
  });

  it('accepts a revalidated immutable FX snapshot without changing the stored converted price', async () => {
    const capturedAt = new Date(now.getTime() - 120 * minute).toISOString();
    const verifiedAt = new Date(now.getTime() - minute).toISOString();
    const snapshot: StoredMarketEconomySnapshot = {
      id: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      kind: 'economy-overview',
      source: 'poe.ninja',
      game: 'poe1',
      league: 'Mercenaries',
      category: 'Currency',
      endpoint: 'https://example.com/fixture',
      payloadHash: 'a'.repeat(64),
      capturedAt,
      sourceUpdatedAt: null,
      priceBasis: 'currency-exchange',
      raw: {},
      lines: [
        {
          id: 'divine',
          name: 'Divine Orb',
          detailsId: 'divine-orb',
          baseType: null,
          price: { amount: 150, currency: 'chaos' },
          listingCount: null,
          observationCount: 1,
          tradedVolume: null,
        },
      ],
    };
    const { evaluation } = await evaluate({
      convertedAt: capturedAt,
      economy: snapshot,
      revalidatedAt: verifiedAt,
    });
    expect(evaluation).toMatchObject({
      status: 'success',
      estimatedSalePrice: '300',
      methodCost: {
        oldestInputAt: verifiedAt,
        expiresAt: new Date(now.getTime() + 29 * minute).toISOString(),
      },
    });
  });
});
