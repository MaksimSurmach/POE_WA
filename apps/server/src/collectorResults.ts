import {
  DomainError,
  clusterJewelVariantFilter,
  mappedTargetFilter,
  noVariantFilter,
  RegisteredTradeQueryGenerator,
} from '@poe-worksmith/domain';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  evaluateFreshRecipe,
  loadEvaluationEconomy,
  type QuoteEvidence,
  type snapshotPayloadSchema,
} from './catalogPublisher.js';
import type { CollectorSchedule } from './collector.js';
import { convertMarketQuote } from './marketCurrency.js';
import {
  verifyEconomySnapshot,
  type MarketEconomyRepository,
  type StoredMarketEconomySnapshot,
} from './marketEconomy.js';
import { createRecipeMarketDependencies } from './recipeMarket.js';
import { recipeResultSchema } from './recipeResult.js';
import { createPostgresRepositories } from './repositories/index.js';
import { createMarketEconomyRepository } from './repositories/marketEconomyRepository.js';
import {
  captures,
  collectorSchedule,
  listings,
  recipePriceObservations,
  recipeResults,
} from './schema.js';
import { loadTradeMappingCatalog } from './tradeMappings.js';

type CaptureQuote = QuoteEvidence & {
  payload: z.input<typeof snapshotPayloadSchema>;
};
type QuoteSettings = { maximumQuoteAgeMs: number; freshnessWarningMs: number };

export function createCollectorResultReader(pool: Pool) {
  const db = drizzle({ client: pool });
  return (leagueId: string, recipeId?: string) =>
    db
      .select()
      .from(recipeResults)
      .where(
        and(
          eq(recipeResults.leagueId, leagueId),
          recipeId === undefined
            ? undefined
            : eq(recipeResults.recipeId, recipeId),
        ),
      );
}

export function createCollectorEconomyCache() {
  const snapshots = new Map<string, StoredMarketEconomySnapshot>();
  return async (
    repository: Pick<MarketEconomyRepository, 'find'>,
    id: string,
  ) => {
    const cached = snapshots.get(id);
    const snapshot = cached ?? (await repository.find(id));
    if (!snapshot) return null;
    if (cached) snapshots.delete(id);
    const evidence = cached ?? { ...snapshot, raw: {} };
    snapshots.set(id, evidence);
    if (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value!);
    return evidence;
  };
}

async function readCaptureQuotes(
  client: PoolClient,
  leagueId: string,
  recipeIds: string[] | undefined,
  now: Date,
  maximumQuoteAgeMs: number,
) {
  const db = drizzle({ client });
  const latest = db
    .select()
    .from(captures)
    .where(eq(captures.scheduleId, collectorSchedule.id))
    .orderBy(desc(captures.capturedAt))
    .limit(1)
    .as('latest');
  const rows = await db
    .select({
      key: collectorSchedule.key,
      captureId: latest.id,
      capturedAt: latest.capturedAt,
      reportedTotal: latest.reportedTotal,
      complete: latest.complete,
      sortedSampleIds: latest.sortedSampleIds,
      fxSnapshotId: latest.fxSnapshotId,
      row: {
        id: listings.itemId,
        seller: listings.seller,
        price: listings.priceOriginal,
        currency: listings.currency,
        indexedAt: listings.indexedAt,
        item: listings.item,
      },
    })
    .from(collectorSchedule)
    .innerJoinLateral(latest, sql`true`)
    .leftJoin(
      listings,
      and(
        eq(listings.scheduleId, collectorSchedule.id),
        eq(listings.lastCaptureId, latest.id),
        eq(listings.status, 'active'),
        sql`(${latest.sortedSampleIds} is null or ${listings.itemId} = any(${latest.sortedSampleIds}))`,
      ),
    )
    .where(
      and(
        eq(collectorSchedule.leagueId, leagueId),
        eq(collectorSchedule.kind, 'trade-target'),
        eq(collectorSchedule.enabled, true),
        gt(latest.capturedAt, new Date(now.getTime() - maximumQuoteAgeMs)),
        lte(latest.capturedAt, now),
        recipeIds
          ? sql`(${collectorSchedule.payload}->'recipeIds') ?| array[${sql.join(
              recipeIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[]`
          : undefined,
      ),
    );
  const quotes = new Map<string, CaptureQuote>();
  for (const {
    key,
    captureId,
    capturedAt,
    reportedTotal,
    complete,
    sortedSampleIds,
    fxSnapshotId,
    row,
  } of rows) {
    let quote = quotes.get(key);
    if (!quote) {
      quote = {
        capturedAt,
        expiresAt: new Date(capturedAt.getTime() + maximumQuoteAgeMs),
        capture: { captureId, captureFxSnapshotId: fxSnapshotId },
        revalue: true,
        payload: {
          coverage:
            complete && sortedSampleIds === null ? 'complete' : 'partial',
          sortedSampleComplete: sortedSampleIds !== null,
          totalResults: reportedTotal,
          listings: [],
        },
      };
      quotes.set(key, quote);
    }
    if (!row?.seller || !row.price || !row.currency) continue;
    const indexedAt = row.indexedAt ?? capturedAt;
    const price = { amount: row.price, currency: row.currency };
    const item = {
      ...row.item,
      seller: row.seller,
      currency: row.currency,
      ...(row.item.rawItem
        ? {
            rawListing: {
              id: row.id,
              item: row.item.rawItem,
              listing: {
                account: { name: row.seller },
                price: { amount: Number(row.price), currency: row.currency },
              },
            },
          }
        : {}),
    };
    quote.payload.listings.push({
      id: row.id,
      account: row.seller,
      ageSeconds: Math.max(
        0,
        Math.floor((capturedAt.getTime() - indexedAt.getTime()) / 1000),
      ),
      indexedAt: indexedAt.toISOString(),
      price,
      item,
      fee: null,
    });
  }
  return quotes;
}

export function createCollectorResultPublisher(
  pool: Pool,
  readSettings: () => Promise<QuoteSettings>,
  readEconomySnapshot = createCollectorEconomyCache(),
) {
  return async (
    schedule: Pick<CollectorSchedule, 'kind' | 'leagueId' | 'payload'>,
    now: Date,
    client: PoolClient,
  ) => {
    if (schedule.kind !== 'trade-target' && schedule.kind !== 'economy') return;
    const repositories = createPostgresRepositories(pool, client);
    const league = await repositories.leagues.findCurrent();
    if (!league || league.id !== schedule.leagueId) return;
    const recipeIds =
      schedule.kind === 'trade-target'
        ? z
            .array(z.string().min(1))
            .nonempty()
            .parse(schedule.payload.recipeIds)
        : undefined;
    const recipes = (await repositories.recipes.listActive()).filter(
      ({ id }) => !recipeIds || recipeIds.includes(id),
    );
    if (!recipes.length) return;
    const settings = await readSettings();
    const quotes = await readCaptureQuotes(
      client,
      league.id,
      recipeIds,
      now,
      settings.maximumQuoteAgeMs,
    );
    const economyStore = createMarketEconomyRepository(client);
    const economy = {
      ...economyStore,
      find: (id: string) => readEconomySnapshot(economyStore, id),
    };
    const { currencyExchange, materialEconomies, attempts } =
      await loadEvaluationEconomy(
        economy,
        league.gggId,
        now,
        settings.maximumQuoteAgeMs,
      );
    const fxSnapshots = new Map<string, ReturnType<typeof economy.find>>();
    if (currencyExchange)
      fxSnapshots.set(currencyExchange.id, Promise.resolve(currencyExchange));
    for (const quote of quotes.values()) {
      const id = quote.capture?.captureFxSnapshotId;
      if (
        !id ||
        !quote.payload.listings.some(({ price }) => price.currency === 'divine')
      )
        continue;
      const found = fxSnapshots.get(id) ?? economy.find(id);
      fxSnapshots.set(id, found);
      const snapshot = verifyEconomySnapshot(
        await found,
        attempts,
        quote.capturedAt,
      );
      const rate = await convertMarketQuote({
        money: { amount: '1', currency: 'divine' },
        currency: 'chaos',
        target: { league: league.gggId },
        capturedAt: quote.capturedAt.toISOString(),
        exchangeSnapshotId: id,
        economy: { find: async () => snapshot },
        now: quote.capturedAt.getTime(),
        dataKind: 'observed',
      });
      if (rate?.exchange) quote.captureExchange = rate.exchange;
    }
    const versions = new Set(
      recipes.flatMap(({ definition }) =>
        typeof definition.gameDataVersion === 'string'
          ? [definition.gameDataVersion]
          : [],
      ),
    );
    const marketDependencies = createRecipeMarketDependencies({
      trade: new RegisteredTradeQueryGenerator(
        await loadTradeMappingCatalog(client, [...versions]),
        [noVariantFilter, clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
      resolveResource: async () => null,
    });
    const rows = [];
    const observations: (typeof recipePriceObservations.$inferInsert)[] = [];
    for (const recipe of recipes) {
      let result;
      try {
        const { observationId, sourceSnapshotDedupeKey, ...fresh } =
          await evaluateFreshRecipe(
            recipe,
            {
              league: league.gggId,
              now,
              quotes: async (hash) => quotes.get(hash) ?? null,
            },
            {
              ...settings,
              allowMissingOutput: true,
              currencyExchange,
              marketDependencies,
              materialEconomies,
            },
          );
        if (observationId !== null || sourceSnapshotDedupeKey !== null)
          throw new Error('Collector result cannot use legacy quote evidence');
        result = {
          ...fresh,
          errorCode: null,
          status: fresh.status ?? 'success',
        };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        result = {
          confidence: null,
          currency: null,
          errorCode: error.code,
          estimatedSalePrice: null,
          expectedCraftCost: null,
          marginPercent: null,
          methodCost: null,
          profit: null,
          status: 'error',
        };
      }
      const parsed = recipeResultSchema.parse(result);
      const { currency, estimatedSalePrice, expectedCraftCost, methodCost } =
        parsed;
      const source = methodCost?.source;
      if (
        source &&
        methodCost.saleEvidence.status === 'accepted' &&
        (currency === 'chaos' || currency === 'divine') &&
        estimatedSalePrice !== null
      ) {
        observations.push({
          recipeId: recipe.id,
          recipeContentHash: recipe.contentHash,
          leagueId: league.id,
          currency,
          sourceSnapshotDedupeKey: `collector:${source.captureId}`,
          observedAt: new Date(source.capturedAt),
          ask: estimatedSalePrice,
          craftCost:
            Date.parse(methodCost.expiresAt) > now.getTime()
              ? expectedCraftCost
              : null,
          comparableSellers: methodCost.saleEvidence.comparableSellers,
          coverage: source.coverage,
          sortedSampleComplete: source.sortedSampleComplete,
        });
      }
      rows.push({
        recipeId: recipe.id,
        recipeContentHash: recipe.contentHash,
        leagueId: league.id,
        evaluatedAt: now,
        result: parsed,
      });
    }
    const db = drizzle({ client });
    await db
      .insert(recipeResults)
      .values(rows)
      .onConflictDoUpdate({
        target: [recipeResults.recipeId, recipeResults.leagueId],
        set: {
          recipeContentHash: sql`excluded.recipe_content_hash`,
          evaluatedAt: sql`excluded.evaluated_at`,
          result: sql`excluded.result`,
        },
      });
    if (observations.length)
      await db
        .insert(recipePriceObservations)
        .values(observations)
        .onConflictDoNothing();
  };
}
