import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRepositories,
  hashMarketQuery,
  RegisteredTradeQueryGenerator,
  noVariantFilter,
  mappedTargetFilter,
} from '@poe-worksmith/domain';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import { synchronizeRecipes } from './recipes/synchronizeRecipes.js';
import { createRecipeMarketDependencies } from './recipeMarket.js';
import { MarketJobProcessor } from './marketJobProcessor.js';
import { FullRefreshOrchestrator } from './refreshOrchestrator.js';
import type { StoredMarketEconomySnapshot } from './marketEconomy.js';
import { summarizeEconomy } from './marketEconomy.js';
import { PoeTradeClient } from './providers/poeTrade.js';
import {
  manualImportMarketCollectionSource,
  type MarketCollectionAdapter,
} from './marketCollection.js';

const now = new Date('2026-11-02T12:00:00.123Z');
const trade = new RegisteredTradeQueryGenerator(
  {
    resolveBase: async ({ baseId }) => ({
      ok: true,
      diagnostics: [],
      value: { id: baseId, mappingVersion: 'fixture' },
    }),
    resolveTarget: async ({ target }) => ({
      ok: true,
      diagnostics: [],
      value: {
        id:
          target.modId === 'different' ? 'explicit.stat_2' : 'explicit.stat_1',
      },
    }),
  },
  [noVariantFilter],
  [mappedTargetFilter],
);

describe('authored recipe to provider to published economics', () => {
  it.each([
    'complete',
    'partial',
    'capped',
    'sample',
    'base-sample',
    'sample-incomplete',
    'thin-stock',
    'ninja-bulk',
    'ninja-unconvertible',
    'ninja-revalidated',
    'ninja-cache-hit',
  ] as const)(
    'shares queries and retains raw observations while withholding prices for %s coverage',
    async (coverage) => {
      const repositories = createInMemoryRepositories();
      const league = await repositories.leagues.upsert({
        game: 'poe1',
        realm: 'pc',
        gggId: 'Fixture League',
        name: 'Fixture League',
        isCurrent: true,
        startAt: null,
        endAt: null,
        syncedAt: now,
        metadata: {},
      });
      const first = fixtureRecipe({
        ...canonicalRecipeFixture,
        craft: {
          ...canonicalRecipeFixture.craft,
          steps: canonicalRecipeFixture.craft.steps.map((s) => ({
            ...s,
            materials: s.materials.map((m) => ({ ...m, quantity: 1 })),
          })),
        },
      });
      const second = fixtureRecipe({
        ...first,
        id: 'second-method',
        craft: {
          ...first.craft,
          id: 'second',
          expectedExecutions: first.craft.expectedExecutions?.map((e) => ({
            ...e,
            count: 12,
          })),
        },
      });
      const different = fixtureRecipe({
        ...first,
        id: 'different-target',
        target: {
          ...first.target,
          prefixes: [{ kind: 'explicit', modId: 'different' }],
        },
      });
      await synchronizeRecipes(
        repositories.recipes,
        [first, second, different].map((definition) => ({
          definition,
          assets: [],
          markdown: '',
          sourcePath: `fixture/${definition.id}.json`,
        })),
        async () => Buffer.from(''),
      );
      const collect = vi.fn<MarketCollectionAdapter['collect']>(
        async ({ target }) => {
          const base = target.tradeSearch?.rarity === 'normal';
          const initialOffers = base
            ? ([[10, 'base-seller']] as const)
            : ([
                [100, 'seller-a'],
                [80, 'seller-a'],
                [99, 'seller-b'],
                [1, 'unknown-seller'],
              ] as const);
          const sampled =
            coverage === 'sample' ||
            coverage === 'sample-incomplete' ||
            (coverage === 'base-sample' && base);
          const offers = sampled
            ? [
                ...initialOffers,
                ...Array.from(
                  {
                    length:
                      (coverage === 'sample-incomplete' ? 19 : 20) -
                      initialOffers.length,
                  },
                  (_, index) => [1000 + index, 'unknown-seller'] as const,
                ),
              ]
            : initialOffers;
          return {
            ...(sampled
              ? {
                  sortedSampleComplete: true,
                  searchEvidence: {
                    queryId: 'sample',
                    ids: Array.from(
                      { length: 100 },
                      (_, index) => `offer-${index}`,
                    ),
                    reportedTotal: 340,
                    request: { scope: 'strict', sort: { price: 'asc' } },
                  },
                }
              : {}),
            batchCount: 1,
            cached: false,
            capturedAt: now.toISOString(),
            coverage:
              sampled || coverage === 'capped' || coverage === 'partial'
                ? 'partial'
                : 'complete',
            inexact: false,
            ...(coverage === 'capped'
              ? {
                  searchEvidence: {
                    queryId: 'fixture',
                    ids: [],
                    reportedTotal: 340,
                    raw: {},
                    request: { sort: { price: 'asc' } },
                  },
                }
              : {}),
            currency: 'chaos',
            fetchedCount: offers.length,
            reportedTotal:
              sampled || coverage === 'capped' ? 340 : offers.length,
            returnedCount: sampled ? 100 : offers.length,
            listings: offers.map(([price, seller], index) => ({
              listedAt: '2026-11-02T12:00:00Z',
              externalId: `offer-${index}`,
              price,
              currency: 'chaos',
              item: {
                baseType: target.baseTypes[0]!,
                rarity: base ? 'normal' : 'rare',
                league: target.league,
                patch: target.patch,
                currency: 'chaos',
                itemLevel: 84,
                corrupted: false,
                synthesised: false,
                ...(seller === 'unknown-seller' ? {} : { fractured: false }),
                influences: [],
                seller,
                status: 'listed',
                mods: [{ id: 'explicit.stat_1', value: 1 }],
                modsComplete: false,
              },
            })),
          };
        },
      );
      const provider = new PoeTradeClient({
        userAgent: 'fixture-test',
        clock: () => now,
        collectionSource: {
          descriptor: {
            ...manualImportMarketCollectionSource.descriptor,
            access: 'authorized',
          },
          collect,
        },
        fetch: async () =>
          new Response(
            JSON.stringify({
              id: 'exchange',
              total: 1,
              result: {
                row: {
                  id: 'row',
                  listing: {
                    account: { name: 'material-seller' },
                    indexed: now.toISOString(),
                    offers: [
                      {
                        exchange: { amount: 2, currency: 'chaos' },
                        item: {
                          amount: 1,
                          currency: 'primal-crystallised-lifeforce',
                          stock: [
                            'thin-stock',
                            'ninja-bulk',
                            'ninja-revalidated',
                            'ninja-cache-hit',
                          ].includes(coverage)
                            ? 1
                            : 20000,
                        },
                      },
                    ],
                  },
                },
              },
            }),
          ),
      });
      const jobs = new MarketJobProcessor({
        repositories,
        providers: [provider],
        concurrency: 1,
        leaseTimeoutMs: 10000,
        retryDelayMs: 1000,
        snapshotTtlMs: 300000,
      });
      const bulk: StoredMarketEconomySnapshot = {
        id: '66666666-6666-4666-8666-666666666666',
        schemaVersion: 1,
        kind: 'economy-overview',
        source: 'poe.ninja',
        game: 'poe1',
        league: league.gggId,
        category: 'Currency',
        endpoint:
          'https://poe.ninja/poe1/api/economy/exchange/current/overview?league=Fixture&type=Currency',
        payloadHash: 'a'.repeat(64),
        capturedAt: ['ninja-revalidated', 'ninja-cache-hit'].includes(coverage)
          ? new Date(now.getTime() - 31 * 60000).toISOString()
          : now.toISOString(),
        sourceUpdatedAt: null,
        priceBasis: 'currency-exchange',
        raw: { fixture: true },
        lines: [
          {
            id: 'lifeforce',
            detailsId: 'primal-crystallised-lifeforce',
            name: 'Primal Crystallised Lifeforce',
            baseType: null,
            price: {
              amount: 5,
              currency:
                coverage === 'ninja-unconvertible' ? 'exalted' : 'chaos',
            },
            listingCount: null,
            observationCount: 10,
            tradedVolume: null,
          },
        ],
      };
      const report = await new FullRefreshOrchestrator({
        ...([
          'ninja-bulk',
          'ninja-unconvertible',
          'ninja-revalidated',
          'ninja-cache-hit',
        ].includes(coverage)
          ? {
              economy: {
                latest: async (_league, category) =>
                  category === 'Currency' ? summarizeEconomy(bulk) : null,
                find: async () => bulk,
                listAttempts: async () => [
                  {
                    id: '77777777-7777-4777-8777-777777777777',
                    league: league.gggId,
                    category: 'Currency' as const,
                    startedAt: now.toISOString(),
                    completedAt: now.toISOString(),
                    status: 'succeeded' as const,
                    cacheStatus:
                      coverage === 'ninja-cache-hit'
                        ? ('hit' as const)
                        : ('revalidated' as const),
                    errorCode: null,
                    snapshotId: bulk.id,
                  },
                ],
              },
            }
          : {}),
        repositories,
        marketJobs: jobs,
        marketDependencies: createRecipeMarketDependencies({
          trade,
          resolveResource: async (id) => id,
        }),
        league: {
          leagueId: league.id,
          leagueGggId: league.gggId,
          leagueName: league.name,
        },
        clock: () => now,
        snapshotTtlMs: 300000,
        workerId: 'fixture-worker',
      }).run('fixture-cycle');
      expect(report.plan.totalQueries).toBe(4);
      expect(
        collect,
        JSON.stringify({
          diagnostics: await repositories.operationalDiagnostics.read({
            recentCycles: 1,
            recentFailures: 10,
          }),
          jobs: report.jobs,
          evaluations: report.publication.evaluations.map((e) => ({
            id: e.recipeId,
            error: e.errorCode,
          })),
        }),
      ).toHaveBeenCalledTimes(3);
      const byId = new Map(
        report.publication.evaluations.map((e) => [e.recipeId, e]),
      );
      expect(byId.get(first.id)).toMatchObject({
        estimatedSalePrice: ![
          'partial',
          'sample-incomplete',
          'sample',
          'capped',
        ].includes(coverage)
          ? '80'
          : null,
        expectedCraftCost: ['ninja-bulk', 'ninja-revalidated'].includes(
          coverage,
        )
          ? '40'
          : [
                'complete',
                'capped',
                'sample',
                'base-sample',
                'ninja-unconvertible',
              ].includes(coverage)
            ? '22'
            : null,
        profit: ['ninja-bulk', 'ninja-revalidated'].includes(coverage)
          ? '40'
          : ['complete', 'base-sample', 'ninja-unconvertible'].includes(
                coverage,
              )
            ? '58'
            : null,
      });
      expect(byId.get(second.id)).toMatchObject({
        estimatedSalePrice: ![
          'partial',
          'sample-incomplete',
          'sample',
          'capped',
        ].includes(coverage)
          ? '80'
          : null,
        expectedCraftCost: ['ninja-bulk', 'ninja-revalidated'].includes(
          coverage,
        )
          ? '70'
          : [
                'complete',
                'capped',
                'sample',
                'base-sample',
                'ninja-unconvertible',
              ].includes(coverage)
            ? '34'
            : null,
        profit: ['ninja-bulk', 'ninja-revalidated'].includes(coverage)
          ? '10'
          : ['complete', 'base-sample', 'ninja-unconvertible'].includes(
                coverage,
              )
            ? '46'
            : null,
      });
      expect(byId.get(different.id)).toMatchObject({
        estimatedSalePrice: null,
        profit: null,
        status: 'partial',
      });
      const targetQuery = (
        await createRecipeMarketDependencies({
          trade,
          resolveResource: async (id) => id,
        })({ recipe: first, league: league.gggId })
      ).find((d) => d.kind === 'target')!.query!;
      const firstQuery = await repositories.marketQueries.findByCanonicalHash(
        await hashMarketQuery({ league: league.gggId, ...targetQuery }),
      );
      expect(firstQuery).toBeDefined();
      const snapshot = await repositories.snapshots.findLatest(
        firstQuery!.id,
        league.id,
      );
      expect(snapshot?.payload.listings).toHaveLength(
        coverage === 'sample' ? 20 : coverage === 'sample-incomplete' ? 19 : 4,
      );
      expect(snapshot?.payload.sortedSampleComplete).toBe(false);
      if (coverage === 'sample')
        expect(byId.get(first.id)).toMatchObject({
          confidence: 'low',
          methodCost: {
            source: { sortedSampleComplete: false, coverage: 'partial' },
          },
        });
      expect(snapshot?.payload.sortedPageComplete).toBe(false);
      if (coverage === 'base-sample')
        expect(byId.get(first.id)).toMatchObject({
          confidence: 'low',
          methodCost: {
            materialEvidence: {
              base: { sortedSampleComplete: true, totalResults: 340 },
            },
          },
        });
      const observations = await repositories.observations.listRecent(
        firstQuery!.id,
        league.id,
        new Date(0),
      );
      expect(observations[0]).toMatchObject({
        cheapestPrice: [
          'partial',
          'sample-incomplete',
          'sample',
          'capped',
        ].includes(coverage)
          ? null
          : '80',
        sampleSize: [
          'partial',
          'sample-incomplete',
          'sample',
          'capped',
        ].includes(coverage)
          ? 0
          : 2,
      });
    },
  );
});

it('rejects a cancelled managed collection even when it retained priced listings', async () => {
  const dependencies = await createRecipeMarketDependencies({
    trade,
    resolveResource: async (id) => id,
  })({ recipe: canonicalRecipeFixture, league: 'Fixture League' });
  const query = dependencies.find((d) => d.kind === 'target')!.query!;
  const provider = new PoeTradeClient({
    userAgent: 'fixture-test',
    collectionSource: {
      descriptor: {
        ...manualImportMarketCollectionSource.descriptor,
        access: 'authorized',
      },
      collect: async () => ({
        cancelled: true,
        coverage: 'partial',
        capturedAt: now.toISOString(),
        batchCount: 1,
        cached: false,
        currency: 'chaos',
        fetchedCount: 1,
        reportedTotal: 1,
        returnedCount: 1,
        listings: [],
      }),
    },
  });
  await expect(
    provider.search({ ...query, league: 'Fixture League' }),
  ).rejects.toMatchObject({ code: 'MARKET_COLLECTION_CANCELLED' });
});
