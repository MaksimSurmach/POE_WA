import { fileURLToPath } from 'node:url';

import {
  catalogResponseSchema,
  recipeResponseSchema,
} from '@poe-worksmith/contracts';
import {
  createInMemoryRepositories,
  transitionRefreshCycle,
  hashMarketQuery,
  validateRecipeDocument,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import {
  synchronizeRecipeCatalog,
  synchronizeRecipes,
} from './recipes/synchronizeRecipes.js';
import { loadRecipeCatalog } from './recipes/loader.js';
import { generateRecipeMarketQuery } from './recipeMarket.js';
import { createResourceReaders } from './resourceViews.js';
import { loadItemPresentationCatalog } from './itemPresentation.js';

const correlationId = '44444444-4444-4444-8444-444444444444';
const recipesPath = fileURLToPath(new URL('../../../recipes', import.meta.url));
const presentationPath = fileURLToPath(
  new URL(
    '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
    import.meta.url,
  ),
);

describe('repository-backed resource views', () => {
  it('serves only active recipes synchronized from the Git catalog', async () => {
    const repositories = createInMemoryRepositories();
    const report = await synchronizeRecipeCatalog(
      recipesPath,
      repositories.recipes,
    );
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
    );

    expect(report).toMatchObject({
      created: expect.arrayContaining([
        'physical-large-cluster-alteration',
        'physical-large-cluster-jagged',
      ]),
    });
    const catalog = catalogResponseSchema.parse(
      await readers.readCatalog(correlationId),
    );
    expect(catalog.state).toBe('loading');
    expect(catalog.data?.entries).toHaveLength(26);
    expect(
      catalog.data?.entries.find(
        ({ recipe }) => recipe.id === 'physical-large-cluster-jagged',
      ),
    ).toMatchObject({
      evaluation: { status: 'loading' },
      recipe: {
        id: 'physical-large-cluster-jagged',
        minimumCapital: null,
        title: 'Physical Cluster Jewel · 3 Notables',
      },
    });

    const rawDetail = await readers.readRecipe(
      correlationId,
      'physical-large-cluster-jagged',
    );
    const detail = recipeResponseSchema.parse(rawDetail);
    expect(detail.data).toMatchObject({
      materials: [
        {
          costPerAttempt: null,
          name: 'Jagged Fossil',
          quantityPerAttempt: 1,
          unitPrice: null,
        },
        {
          costPerAttempt: null,
          name: 'Primitive Chaotic Resonator',
          quantityPerAttempt: 1,
          unitPrice: null,
        },
      ],
      recipe: { id: 'physical-large-cluster-jagged' },
      presentation: {
        base: { name: 'Large Cluster Jewel' },
        materials: [
          { name: 'Jagged Fossil', quantity: 1 },
          { name: 'Primitive Chaotic Resonator', quantity: 1 },
        ],
        target: {
          modifiers: [
            { label: 'Battle-Hardened' },
            { label: 'Master the Fundamentals' },
            { label: 'Furious Assault' },
          ],
        },
        version: 1,
      },
    });
    expect(JSON.stringify(detail.data)).not.toMatch(
      /explicit\.stat_|externalId|provider|query/i,
    );
    expect(JSON.stringify(rawDetail.data)).toBe(
      JSON.stringify(
        (
          await readers.readRecipe(
            correlationId,
            'physical-large-cluster-jagged',
          )
        ).data,
      ),
    );
  });

  it('omits a catalog item preview when its base has no presentation metadata', async () => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const readers = createResourceReaders(repositories, {
      get: () => null,
      version: () => '1',
    });

    const catalog = catalogResponseSchema.parse(
      await readers.readCatalog(correlationId),
    );
    expect(catalog.data?.entries[0]).not.toHaveProperty('itemPreview');
  });

  it('links the recipe base to a league-specific PoE Trade search', async () => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Mercenaries',
      isCurrent: true,
      metadata: {},
      name: 'Mercenaries',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const trade: TradeQueryGenerator = {
      generate: async ({ league, setup }) => {
        expect(league).toBe('Mercenaries');
        expect(setup.target).toEqual({
          allOf: [],
          anyOf: [],
          minimumMatched: null,
        });
        expect(setup.base.itemLevel).toBe(83);
        expect(setup.base.variant).toMatchObject({
          kind: 'cluster-jewel',
          passiveCount: 8,
          smallPassiveStatId: 'physical-damage',
        });
        return {
          diagnostics: [],
          ok: true,
          value: {
            diagnostics: { gameDataVersion: '3.26.0', mappingVersion: 'test' },
            hash: 'base-query',
            query: {
              query: {
                type: 'Large Cluster Jewel',
                filters: { misc_filters: { filters: { ilvl: { min: 83 } } } },
              },
            },
          },
        };
      },
    };
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      trade,
    );
    const detail = recipeResponseSchema.parse(
      await readers.readRecipe(correlationId, 'physical-large-cluster-jagged'),
    );
    const url = new URL(detail.data!.baseTradeUrl!);
    expect(url.pathname).toContain('/trade/search/Mercenaries');
    expect(JSON.parse(url.searchParams.get('q') ?? 'null')).toMatchObject({
      query: {
        type: 'Large Cluster Jewel',
        filters: { misc_filters: { filters: { ilvl: { min: 83, max: 83 } } } },
      },
      sort: { price: 'asc' },
    });
    const unavailable = await createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      {
        generate: async () => {
          throw new Error('mapping store unavailable');
        },
      },
    ).readRecipe(correlationId, 'physical-large-cluster-jagged');
    expect(
      recipeResponseSchema.parse(unavailable).data?.baseTradeUrl,
    ).toBeNull();
  });

  it.each([false, true])(
    'exposes current economics and withholds expired prices (expired=%s)',
    async (expired) => {
      const repositories = createInMemoryRepositories();
      const currentCatalog = await loadRecipeCatalog(recipesPath);
      const previousCatalog = currentCatalog.map((source) => ({
        ...source,
        definition: {
          ...source.definition,
          craft: {
            ...source.definition.craft,
            uncertainties: source.definition.craft.uncertainties.filter(
              (note) =>
                !note.startsWith(
                  'Starting-base acquisition must use exactly item level',
                ),
            ),
          },
        },
      }));
      await synchronizeRecipes(
        repositories.recipes,
        previousCatalog,
        async () => Buffer.from('fixture'),
      );
      const oldRecipes = await repositories.recipes.listAll();
      const league = await repositories.leagues.upsert({
        endAt: null,
        game: 'poe1',
        gggId: 'Mercenaries',
        isCurrent: true,
        metadata: {},
        name: 'Mercenaries',
        realm: 'pc',
        startAt: null,
        syncedAt: new Date('2026-11-02T00:00:00.000Z'),
      });
      const cycle = await repositories.cycles.save({
        completedQueries: 0,
        completedRecipes: 0,
        errorMessage: null,
        failedQueries: 0,
        failedRecipes: 0,
        finishedAt: null,
        id: '11111111-1111-4111-8111-111111111111',
        leagueId: league.id,
        publishedAt: null,
        requestedAt: new Date('2026-11-02T00:00:00.000Z'),
        startedAt: null,
        status: 'queued',
        totalQueries: 0,
        totalRecipes: 1,
      });
      const running = await repositories.cycles.save(
        transitionRefreshCycle(cycle, 'running', new Date()),
      );
      await repositories.evaluations.save({
        confidence: 'low',
        currency: 'chaos',
        errorCode: null,
        estimatedSalePrice: '10',
        evaluatedAt: new Date('2026-11-02T00:00:00.000Z'),
        expectedCraftCost: '3.75',
        lastSuccessfulAt: new Date('2026-11-02T00:00:00.000Z'),
        leagueId: league.id,
        marginPercent: '62.5',
        observationId: null,
        profit: '6.25',
        recipeId: 'physical-large-cluster-jagged',
        refreshCycleId: running.id,
        sourceSnapshotDedupeKey: 'fixture',
        status: 'success',
        methodCost: {
          expiresAt: expired ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
          recipeContentHash: (
            await repositories.recipes.findById('physical-large-cluster-jagged')
          )?.contentHash,
          source: { sampleSize: 2 },
          expectedCost: { amount: '3.75', currency: 'chaos' },
          materialsPerAttempt: { amount: '1.5', currency: 'chaos' },
          steps: [
            {
              id: 'roll-with-fossil',
              materials: [
                {
                  costPerAttempt: { amount: '1', currency: 'chaos' },
                  itemId: 'jagged-fossil',
                  unitPrice: { amount: '1', currency: 'chaos' },
                },
              ],
            },
          ],
        },
      });
      await repositories.cycles.save({ ...running, completedRecipes: 1 });
      await repositories.cycles.publish(running.id, new Date());
      const readers = createResourceReaders(
        repositories,
        await loadItemPresentationCatalog(presentationPath),
      );

      const detail = recipeResponseSchema.parse(
        await readers.readRecipe(
          correlationId,
          'physical-large-cluster-jagged',
        ),
      );
      expect(detail.data?.evaluation).toMatchObject({
        status: expired ? 'stale' : 'success',
        profit: expired ? null : { amount: 6.25, currency: 'chaos' },
      });
      expect(detail.data?.method).toMatchObject({
        expectedCost: expired ? null : { amount: 3.75, currency: 'chaos' },
        materialsPerAttempt: { amount: 1.5, currency: 'chaos' },
        steps: [
          {
            materials: [
              {
                costPerAttempt: { amount: 1, currency: 'chaos' },
                itemId: 'jagged-fossil',
                unitPrice: { amount: 1, currency: 'chaos' },
              },
              {
                costPerAttempt: null,
                itemId: 'primitive-chaotic-resonator',
                unitPrice: null,
              },
            ],
          },
        ],
      });
      const history = await repositories.evaluations.listByCycle(running.id);
      const upgraded = await synchronizeRecipeCatalog(
        recipesPath,
        repositories.recipes,
      );
      expect(upgraded.updated).toHaveLength(26);
      for (const previous of oldRecipes) {
        expect(
          (await repositories.recipes.findById(previous.id))?.contentHash,
        ).not.toBe(previous.contentHash);
      }
      const updatedDetail = await readers.readRecipe(
        correlationId,
        'physical-large-cluster-jagged',
      );
      expect(updatedDetail.data?.evaluation).toMatchObject({
        expectedCraftCost: null,
        profit: null,
        marginPercent: null,
      });
      expect(updatedDetail.data?.method?.expectedCost).toBeNull();
      const updatedCatalog = await readers.readCatalog(correlationId);
      expect(
        updatedCatalog.data?.entries.find(
          (entry) => entry.recipe.id === 'physical-large-cluster-jagged',
        )?.evaluation,
      ).toMatchObject({ expectedCraftCost: null, profit: null });
      expect(await repositories.evaluations.listByCycle(running.id)).toEqual(
        history,
      );
    },
  );

  it.each([true, false])(
    'applies a lowered maximum quote age to catalog and recipe views without deleting prices (input timestamp=%s)',
    async (hasInputTimestamp) => {
      const repositories = createInMemoryRepositories();
      await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
      const recipeId = 'physical-large-cluster-jagged';
      const recipe = await repositories.recipes.findById(recipeId);
      if (!recipe) throw new Error('Missing canonical recipe fixture');
      const now = new Date();
      const league = await repositories.leagues.upsert({
        endAt: null,
        game: 'poe1',
        gggId: 'Synthetic Policy League',
        isCurrent: true,
        metadata: {},
        name: 'Synthetic Policy League',
        realm: 'pc',
        startAt: null,
        syncedAt: now,
      });
      const queued = await repositories.cycles.save({
        completedQueries: 0,
        completedRecipes: 0,
        errorMessage: null,
        failedQueries: 0,
        failedRecipes: 0,
        finishedAt: null,
        id: '11111111-1111-4111-8111-111111111111',
        leagueId: league.id,
        publishedAt: null,
        requestedAt: now,
        startedAt: null,
        status: 'queued',
        totalQueries: 0,
        totalRecipes: 1,
      });
      const running = await repositories.cycles.save(
        transitionRefreshCycle(queued, 'running', now),
      );
      const saved = await repositories.evaluations.save({
        confidence: 'low',
        currency: 'chaos',
        errorCode: null,
        estimatedSalePrice: '10',
        evaluatedAt: now,
        expectedCraftCost: '3.75',
        lastSuccessfulAt: now,
        leagueId: league.id,
        marginPercent: '62.5',
        observationId: null,
        profit: '6.25',
        recipeId,
        refreshCycleId: running.id,
        sourceSnapshotDedupeKey: 'synthetic-policy-snapshot',
        status: 'success',
        methodCost: {
          recipeContentHash: recipe.contentHash,
          expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
          ...(hasInputTimestamp
            ? {
                oldestInputAt: new Date(
                  now.getTime() - 10 * 60_000,
                ).toISOString(),
              }
            : {}),
          source: { sampleSize: 2 },
          expectedCost: { amount: '3.75', currency: 'chaos' },
        },
      });
      await repositories.cycles.save({ ...running, completedRecipes: 1 });
      await repositories.cycles.publish(running.id, now);
      const published = await repositories.catalog.getPublished();
      let maximumQuoteAgeMs = 30 * 60_000;
      const readers = createResourceReaders(
        repositories,
        await loadItemPresentationCatalog(presentationPath),
        undefined,
        async () => maximumQuoteAgeMs,
      );
      const initialCatalog = await readers.readCatalog(correlationId);
      expect(
        initialCatalog.data?.entries.find(
          (entry) => entry.recipe.id === recipeId,
        )?.evaluation,
      ).toMatchObject({
        status: 'success',
        profit: { amount: 6.25, currency: 'chaos' },
      });
      expect(
        (await readers.readRecipe(correlationId, recipeId)).data?.evaluation
          .status,
      ).toBe('success');

      maximumQuoteAgeMs = 5 * 60_000;
      const catalog = catalogResponseSchema.parse(
        await readers.readCatalog(correlationId),
      );
      const detail = recipeResponseSchema.parse(
        await readers.readRecipe(correlationId, recipeId),
      );
      expect(
        catalog.data?.entries.find((entry) => entry.recipe.id === recipeId)
          ?.evaluation,
      ).toMatchObject({
        status: 'stale',
        expectedCraftCost: null,
        estimatedSalePrice: null,
        profit: null,
        marginPercent: null,
      });
      expect(detail.data?.evaluation).toMatchObject({
        status: 'stale',
        expectedCraftCost: null,
        estimatedSalePrice: null,
        profit: null,
        marginPercent: null,
      });
      expect(detail.data?.method?.expectedCost).toBeNull();
      expect(await repositories.evaluations.listByCycle(running.id)).toEqual([
        saved,
      ]);
      expect(await repositories.catalog.getPublished()).toEqual(published);
      expect(await repositories.recipes.findById(recipeId)).toEqual(recipe);

      maximumQuoteAgeMs = 30 * 60_000;
      expect(
        (await readers.readRecipe(correlationId, recipeId)).data?.evaluation
          .status,
      ).toBe('success');
    },
  );

  it('does not present a published catalog after its league rolls over', async () => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const oldLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Old',
      isCurrent: true,
      metadata: {},
      name: 'Old',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date(),
    });
    const queued = await repositories.cycles.save({
      completedQueries: 0,
      completedRecipes: 0,
      errorMessage: null,
      failedQueries: 0,
      failedRecipes: 0,
      finishedAt: null,
      id: '11111111-1111-4111-8111-111111111111',
      leagueId: oldLeague.id,
      publishedAt: null,
      requestedAt: new Date(),
      startedAt: null,
      status: 'queued',
      totalQueries: 0,
      totalRecipes: 1,
    });
    const running = await repositories.cycles.save({
      ...transitionRefreshCycle(queued, 'running', new Date()),
      completedRecipes: 1,
    });
    await repositories.cycles.publish(running.id, new Date());
    const nextLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Next',
      isCurrent: false,
      metadata: {},
      name: 'Next',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date(),
    });
    await repositories.leagues.setCurrent(nextLeague.id, new Date());

    expect(
      await createResourceReaders(
        repositories,
        await loadItemPresentationCatalog(presentationPath),
      ).readCatalog(correlationId),
    ).toMatchObject({
      publishedAt: null,
      state: 'loading',
    });
  });
});

it.each([false, true])(
  'omits expired raw output snapshot even without a published evaluation (expired=%s)',
  async (expired) => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const league = await repositories.leagues.upsert({
      game: 'poe1',
      realm: 'pc',
      gggId: 'Standard',
      name: 'Standard',
      isCurrent: true,
      startAt: null,
      endAt: null,
      syncedAt: new Date(),
      metadata: {},
    });
    const recipe = (await repositories.recipes.findById(
      'physical-large-cluster-jagged',
    ))!;
    const trade: TradeQueryGenerator = {
      generate: async () => ({
        ok: true,
        diagnostics: [],
        value: {
          hash: 'fixture',
          diagnostics: {
            gameDataVersion: '3.29.3.3',
            mappingVersion: 'fixture',
          },
          query: { query: { type: 'Large Cluster Jewel' } },
        },
      }),
    };
    const query = await generateRecipeMarketQuery(
      trade,
      validateRecipeDocument(recipe.definition),
      league.gggId,
    );
    const id = '33333333-3333-4333-8333-333333333333';
    const cycleId = '55555555-5555-4555-8555-555555555555';
    await repositories.marketQueries.save({
      id,
      recipeId: recipe.id,
      active: true,
      canonicalHash: await hashMarketQuery({ league: league.gggId, ...query }),
      provider: query.provider,
      query: query.query,
    });
    await repositories.snapshots.save({
      marketQueryId: id,
      leagueId: league.id,
      refreshCycleId: cycleId,
      dedupeKey: 'fixture-stale',
      capturedAt: new Date(expired ? '2019-01-01' : Date.now()),
      expiresAt: new Date(expired ? '2020-01-01' : '2099-01-01'),
      providerStatus: 200,
      payload: { listings: [], totalResults: 0, coverage: 'partial' },
    });
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      trade,
    );
    const response = await readers.readRecipe(correlationId, recipe.id);
    expect(response.data?.snapshot === null).toBe(expired);
    if (!expired)
      expect(response.data?.snapshot).toMatchObject({
        coverage: 'partial',
        listings: [],
      });
  },
);

describe('legacy single-seller profit on the read boundary', () => {
  async function publishLegacy(input: {
    status: 'success' | 'stale';
    methodCost: Record<string, unknown>;
  }) {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const recipeId = 'physical-large-cluster-jagged';
    const recipe = (await repositories.recipes.findById(recipeId))!;
    const now = new Date();
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Synthetic Seller League',
      isCurrent: true,
      metadata: {},
      name: 'Synthetic Seller League',
      realm: 'pc',
      startAt: null,
      syncedAt: now,
    });
    const queued = await repositories.cycles.save({
      completedQueries: 0,
      completedRecipes: 0,
      errorMessage: null,
      failedQueries: 0,
      failedRecipes: 0,
      finishedAt: null,
      id: '66666666-6666-4666-8666-666666666666',
      leagueId: league.id,
      publishedAt: null,
      requestedAt: now,
      startedAt: null,
      status: 'queued',
      totalQueries: 0,
      totalRecipes: 1,
    });
    const running = await repositories.cycles.save(
      transitionRefreshCycle(queued, 'running', now),
    );
    const saved = await repositories.evaluations.save({
      confidence: 'low',
      currency: 'chaos',
      errorCode: input.status === 'stale' ? 'SNAPSHOT_MISSING' : null,
      estimatedSalePrice: '19795',
      evaluatedAt: now,
      expectedCraftCost: '869.28',
      lastSuccessfulAt: now,
      leagueId: league.id,
      marginPercent: '2177.17',
      observationId: null,
      profit: '18925.72',
      recipeId,
      refreshCycleId: running.id,
      sourceSnapshotDedupeKey: 'legacy-single-seller',
      status: input.status,
      methodCost: {
        recipeContentHash: recipe.contentHash,
        expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
        oldestInputAt: new Date(now.getTime() - 60_000).toISOString(),
        expectedCost: { amount: '869.28', currency: 'chaos' },
        ...input.methodCost,
      },
    });
    await repositories.cycles.save({ ...running, completedRecipes: 1 });
    await repositories.cycles.publish(running.id, now);
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      undefined,
      async () => 30 * 60_000,
    );
    const catalog = catalogResponseSchema.parse(
      await readers.readCatalog(correlationId),
    );
    const detail = recipeResponseSchema.parse(
      await readers.readRecipe(correlationId, recipeId),
    );
    return {
      catalog: catalog.data?.entries.find((e) => e.recipe.id === recipeId)
        ?.evaluation,
      detail: detail.data?.evaluation,
      stored: await repositories.evaluations.listByCycle(running.id),
      saved,
    };
  }

  const askAndCost = {
    estimatedSalePrice: { amount: 19795, currency: 'chaos' },
    expectedCraftCost: { amount: 869.28, currency: 'chaos' },
  };

  it('keeps the valuation source visible without a raw snapshot and validates stored evidence', async () => {
    const capturedAt = '2026-11-04T10:00:00.000Z';
    const { catalog, detail } = await publishLegacy({
      status: 'success',
      methodCost: {
        source: { capturedAt, sampleSize: 3, coverage: 'partial' },
      },
    });
    expect(catalog?.source).toEqual({
      capturedAt,
      comparableSellers: 3,
      coverage: 'partial',
    });
    expect(detail?.source).toEqual(catalog?.source);
    const invalid = await publishLegacy({
      status: 'success',
      methodCost: { source: { capturedAt: 'invalid', sampleSize: 3 } },
    });
    expect(invalid.catalog?.source).toBeUndefined();
  });

  it.each([
    ['unknown seller evidence', {}],
    ['fractional seller count', { source: { sampleSize: 2.5 } }],
    [
      'unavailable currency',
      { source: { sampleSize: 3, currencyAvailable: false } },
    ],
    [
      'unaccepted evidence',
      {
        saleEvidence: { comparableSellers: 3, status: 'unavailable_currency' },
      },
    ],
    ['source sample of one (pre-saleEvidence)', { source: { sampleSize: 1 } }],
    [
      'saleEvidence insufficient',
      {
        source: { sampleSize: 1 },
        saleEvidence: {
          comparableSellers: 1,
          minimumComparableSellers: 2,
          status: 'insufficient_sellers',
        },
      },
    ],
  ])(
    'withholds stored profit and ROI from a %s and marks it partial in catalog and detail',
    async (_label, methodCost) => {
      const { catalog, detail, stored, saved } = await publishLegacy({
        status: 'success',
        methodCost,
      });
      for (const evaluation of [catalog, detail])
        expect(evaluation).toMatchObject({
          ...askAndCost,
          status: 'partial',
          profit: null,
          marginPercent: null,
          lastSuccessfulAt: null,
        });
      expect(detail).toEqual(catalog);
      // Stored history is not rewritten; only the read view is qualified.
      expect(stored).toEqual([saved]);
      expect(saved.profit).toBe('18925.72');
    },
  );

  it('keeps a legacy single-seller stale fallback stale while withholding its profit', async () => {
    const { catalog, detail } = await publishLegacy({
      status: 'stale',
      methodCost: { source: { sampleSize: 1 } },
    });
    for (const evaluation of [catalog, detail])
      expect(evaluation).toMatchObject({
        ...askAndCost,
        status: 'stale',
        profit: null,
        marginPercent: null,
      });
  });

  it.each([
    ['two sellers', { source: { sampleSize: 2 } }],
    ['twenty sellers', { source: { sampleSize: 20 } }],
  ])('keeps supported profit for %s', async (_label, methodCost) => {
    const { catalog, detail } = await publishLegacy({
      status: 'success',
      methodCost,
    });
    for (const evaluation of [catalog, detail])
      expect(evaluation).toMatchObject({
        ...askAndCost,
        status: 'success',
        profit: { amount: 18925.72, currency: 'chaos' },
        marginPercent: 2177.17,
      });
  });
});
