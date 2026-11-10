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
import { recipeResultSchema } from './recipeResult.js';

const correlationId = '44444444-4444-4444-8444-444444444444';
const recipesPath = fileURLToPath(new URL('../../../recipes', import.meta.url));
const presentationPath = fileURLToPath(
  new URL(
    '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
    import.meta.url,
  ),
);

describe('repository-backed resource views', () => {
  it('reads collector results for the current league and hides mismatched or expired prices', async () => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const recipeId = 'physical-large-cluster-chaos';
    const recipe = (await repositories.recipes.findById(recipeId))!;
    const league = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Standard',
      isCurrent: true,
      metadata: {},
      name: 'Standard',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date(),
    });
    const evaluatedAt = new Date();
    const result = recipeResultSchema.parse({
      confidence: 'high',
      currency: 'chaos',
      errorCode: null,
      estimatedSalePrice: null,
      expectedCraftCost: '17',
      marginPercent: null,
      profit: null,
      status: 'partial',
      methodCost: {
        oldestInputAt: evaluatedAt.toISOString(),
        expiresAt: new Date(evaluatedAt.getTime() + 60_000).toISOString(),
        baseCost: { amount: '17', currency: 'chaos' },
        marketStatus: 'priced',
        saleEvidence: { comparableSellers: 0 },
        budget: null,
      },
    });
    const row = {
      leagueId: league.id,
      recipeId,
      recipeContentHash: recipe.contentHash,
      evaluatedAt,
      result,
    };
    const unexpectedRead = async () => {
      throw new Error('collector view read legacy storage');
    };
    repositories.catalog.getPublished = unexpectedRead;
    repositories.catalog.getProgress = unexpectedRead;
    repositories.snapshots.findLatest = unexpectedRead;
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      undefined,
      undefined,
      async (leagueId, id) => {
        expect(leagueId).toBe(id === undefined ? undefined : league.id);
        expect(id === undefined || id === recipeId).toBe(true);
        return [row];
      },
    );
    const catalog = catalogResponseSchema.parse(
      await readers.readCatalog(correlationId),
    );
    expect(catalog).toMatchObject({
      data: { pipeline: 'collector' },
      state: 'partial',
      isStale: false,
      lastSuccessfulAt: null,
      publishedAt: evaluatedAt.toISOString(),
    });
    expect(
      catalog.data?.entries.find(({ recipe }) => recipe.id === recipeId),
    ).toMatchObject({
      evaluation: { expectedCraftCost: { amount: 17 } },
      snapshot: null,
    });
    const readDetail = async () =>
      recipeResponseSchema.parse(
        await readers.readRecipe(correlationId, recipeId),
      ).data;
    expect(await readDetail()).toMatchObject({
      method: { baseCost: { amount: 17 } },
      snapshot: null,
    });
    row.leagueId = 'previous league';
    expect((await readDetail())?.evaluation.status).toBe('loading');
    row.leagueId = league.id;
    row.recipeContentHash = 'previous recipe';
    expect((await readDetail())?.evaluation.status).toBe('loading');
    row.recipeContentHash = recipe.contentHash;
    row.result.methodCost!.expiresAt = new Date(
      evaluatedAt.getTime() - 1,
    ).toISOString();
    expect(
      recipeResponseSchema.parse(
        await readers.readRecipe(correlationId, recipeId),
      ),
    ).toMatchObject({
      state: 'partial',
      errorCode: 'SNAPSHOT_EXPIRED',
      isStale: true,
      lastSuccessfulAt: null,
      publishedAt: evaluatedAt.toISOString(),
      data: {
        evaluation: { status: 'stale', expectedCraftCost: null },
        method: { baseCost: null },
      },
    });
    row.result.methodCost!.craftInputAt = evaluatedAt.toISOString();
    row.result.methodCost!.craftExpiresAt = new Date(
      evaluatedAt.getTime() + 60_000,
    ).toISOString();
    expect(await readDetail()).toMatchObject({
      evaluation: {
        status: 'stale',
        expectedCraftCost: { amount: 17 },
        estimatedSalePrice: null,
        profit: null,
      },
      method: { baseCost: { amount: 17 } },
    });
    row.result = {
      ...result,
      errorCode: 'NO_LISTINGS',
      status: 'error',
      expectedCraftCost: null,
      methodCost: null,
    };
    expect(
      recipeResponseSchema.parse(
        await readers.readRecipe(correlationId, recipeId),
      ),
    ).toMatchObject({
      state: 'partial',
      errorCode: 'NO_LISTINGS',
      isStale: false,
      lastSuccessfulAt: null,
    });
  });

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
    expect(catalog.data?.entries).toHaveLength(31);
    expect(
      catalog.data?.entries
        .filter(({ recipe }) =>
          [
            'physical-large-cluster-chaos',
            'physical-large-cluster-jagged',
          ].includes(recipe.id),
        )
        .map(({ recipe }) => recipe.targetSignature),
    ).toEqual([
      '3.29.3.3:7bf68c4f67b27b2ae65c467e1d5bfac5',
      '3.29.3.3:7bf68c4f67b27b2ae65c467e1d5bfac5',
    ]);
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
          source: { sampleSize: 2, coverage: 'complete' },
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
      expect(upgraded.updated).toHaveLength(oldRecipes.length);
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
          source: { sampleSize: 2, coverage: 'complete' },
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

it.each(['fresh', 'expired', 'policy-expired'] as const)(
  'omits expired raw output snapshot even without a published evaluation (state=%s)',
  async (state) => {
    const expired = state === 'expired';
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
      capturedAt: new Date(
        expired
          ? '2019-01-01'
          : Date.now() - (state === 'policy-expired' ? 600_000 : 0),
      ),
      expiresAt: new Date(expired ? '2020-01-01' : '2099-01-01'),
      providerStatus: 200,
      payload: { listings: [], totalResults: 0, coverage: 'partial' },
    });
    const readers = createResourceReaders(
      repositories,
      await loadItemPresentationCatalog(presentationPath),
      trade,
      async () => 300_000,
    );
    const response = await readers.readRecipe(correlationId, recipe.id);
    expect(response.data?.snapshot === null).toBe(state !== 'fresh');
    const catalog = await readers.readCatalog(correlationId);
    expect(
      catalog.data?.entries.find((entry) => entry.recipe.id === recipe.id)
        ?.snapshot === null,
    ).toBe(state !== 'fresh');
    if (state === 'fresh')
      expect(response.data?.snapshot).toMatchObject({
        coverage: 'partial',
        listings: [],
      });
  },
);

it('reads market activity by the collector schedule key and leaves the sale basis alone', async () => {
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
        diagnostics: { gameDataVersion: '3.29.3.3', mappingVersion: 'fixture' },
        query: { query: { type: 'Large Cluster Jewel' } },
      },
    }),
  };
  const query = await generateRecipeMarketQuery(
    trade,
    validateRecipeDocument(recipe.definition),
    league.gggId,
  );
  const marketActivity = {
    capturedAt: new Date().toISOString(),
    active: 4,
    distinctSellers: 3,
    repriced72h: 1,
    inferredExits24h: 1,
    inferredExits72h: 3,
    uncertainExits72h: 2,
    recentExitAsk: { amount: 120, currency: 'chaos' as const },
  };
  const keys: string[] = [];
  const loadedPresentation =
    await loadItemPresentationCatalog(presentationPath);
  const read = (withActivity: boolean) =>
    createResourceReaders(
      repositories,
      loadedPresentation,
      trade,
      async () => 300_000,
      async () => [],
      withActivity
        ? async (leagueId, key) => {
            expect(leagueId).toBe(league.id);
            keys.push(key);
            return marketActivity;
          }
        : undefined,
    ).readRecipe(correlationId, recipe.id);

  const detail = recipeResponseSchema.parse(await read(true)).data!;
  // Same key synchronizeRecipes writes to collector_schedule for the target.
  expect(keys).toEqual([
    await hashMarketQuery({ ...query, league: league.gggId }),
  ]);
  expect(detail.marketActivity).toEqual(marketActivity);
  expect(detail).toEqual({
    ...recipeResponseSchema.parse(await read(false)).data,
    marketActivity,
  });
});

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
        source: {
          coverage: 'complete',
          ...((input.methodCost.source as Record<string, unknown>) ?? {}),
        },
        ...Object.fromEntries(
          Object.entries(input.methodCost).filter(([key]) => key !== 'source'),
        ),
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

  it.each(['fresh', 'expired'] as const)(
    'returns one-item budget prices only from fresh evidence (%s)',
    async (scenario) => {
      const { catalog, detail } = await publishLegacy({
        status: 'success',
        methodCost: {
          budget: { p50: '603.82', p90: '1998', currency: 'chaos' },
          ...(scenario === 'expired'
            ? { expiresAt: '2000-01-01T00:00:00.000Z' }
            : {}),
        },
      });

      for (const evaluation of [catalog, detail]) {
        expect(evaluation?.budget).toEqual(
          scenario === 'expired'
            ? null
            : {
                p50: { amount: 603.82, currency: 'chaos' },
                p90: { amount: 1998, currency: 'chaos' },
              },
        );
      }
    },
  );

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
      comparable: false,
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

  it('explains an unverified output comparison in catalog and detail', async () => {
    const reason = 'Additional paid finish is outside the cost model.';
    const { catalog, detail } = await publishLegacy({
      status: 'success',
      methodCost: {
        source: { sampleSize: 3 },
        saleEvidence: {
          comparableSellers: 3,
          status: 'unverified_output_value',
          reason,
        },
      },
    });
    for (const evaluation of [catalog, detail])
      expect(evaluation).toMatchObject({
        ...askAndCost,
        profit: null,
        marginPercent: null,
        profitBlockedReason: reason,
      });
  });

  it.each([
    ['unknown seller evidence', {}],
    [
      'partial sorted mixed-currency sample',
      {
        source: {
          sampleSize: 20,
          coverage: 'partial',
          sortedSampleComplete: true,
        },
        saleEvidence: { comparableSellers: 20, status: 'accepted' },
      },
    ],
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
          ...(_label === 'partial sorted mixed-currency sample'
            ? { estimatedSalePrice: null }
            : {}),
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

  it.each(['success', 'stale', 'expired'] as const)(
    'reads graded single-seller profit with %s evidence',
    async (scenario) => {
      const { catalog, detail } = await publishLegacy({
        status: scenario === 'stale' ? 'stale' : 'success',
        methodCost: {
          ...(scenario === 'expired'
            ? { expiresAt: '2000-01-01T00:00:00.000Z' }
            : {}),
          source: { sampleSize: 1 },
          saleEvidence: {
            comparableSellers: 1,
            status: 'accepted',
            grade: 'C',
            gradeReasons: ['1 seller'],
          },
        },
      });
      for (const evaluation of [catalog, detail]) {
        expect(evaluation).toMatchObject(
          scenario === 'expired'
            ? {
                status: 'stale',
                estimatedSalePrice: null,
                expectedCraftCost: null,
                profit: null,
                marginPercent: null,
              }
            : {
                ...askAndCost,
                status: scenario,
                profit: { amount: 18925.72, currency: 'chaos' },
                marginPercent: 2177.17,
              },
        );
        if (scenario !== 'expired')
          expect(evaluation).toMatchObject({
            grade: 'C',
            gradeReasons: ['1 seller'],
          });
        else {
          expect(evaluation).not.toHaveProperty('grade');
          expect(evaluation).not.toHaveProperty('gradeReasons');
        }
      }
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
    ['two sellers', { source: { sampleSize: 2, coverage: 'complete' } }],
    ['twenty sellers', { source: { sampleSize: 20, coverage: 'complete' } }],
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
