import {
  marketImportListingSchema,
  marketCollectionSearchEvidenceSchema,
  type MarketImportListing,
  type MarketTarget,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type Capture,
  type CanonicalJsonObject,
} from '@poe-worksmith/domain';
import { convertChaosDivineQuote } from '@poe-worksmith/domain/economics';
import { z } from 'zod';

import type { MarketCollectionTransportResponse } from './marketCollection.js';
import {
  completeOutputLimit,
  isCompleteSortedPriceSample,
} from './marketCollection.js';
import { convertMarketQuote } from './marketCurrency.js';
import type { MarketEconomyRepository } from './marketEconomy.js';
import { marketDigest } from './marketResearch.js';
import {
  loadTradeLoginConfig,
  PoeTradeSessionManager,
  TradeLoginRateLimited,
} from './providers/poeTradeSessionManager.js';
import {
  TradeCompatibleTransport,
  loadTradeCompatibleConfig,
  type TradePriceRange,
} from './providers/tradeCompatible.js';
import {
  ProviderRateLimitDeferred,
  type RateLimitGate,
} from './rateLimitController.js';
import { recipeQueryTarget } from './recipeMarket.js';
import {
  TradeSessionDecryptError,
  type createTradeSessionRepository,
} from './repositories/tradeSessionRepository.js';
import type { captures, collectorSchedule } from './schema.js';

const maxPriceSlices = 5;
const detailBatchSize = 10;
const schedulePayload = z.object({
  provider: z.literal('poe-trade'),
  schemaVersion: z.literal(1),
  query: z.object({ handbookTarget: z.string() }),
});
const modifierRolls = z.array(
  z.union([
    z.string(),
    z.object({
      description: z.string(),
      hash: z.string().optional(),
      domain: z.string().optional(),
      mods: z.array(z.object({ tier: z.string().optional() })).optional(),
    }),
  ]),
);

type CaptureData = Omit<typeof captures.$inferInsert, 'id' | 'scheduleId'> & {
  listings: Capture['listings'];
};

type TradeCaptureResult =
  | { status: 'success'; capture: CaptureData }
  | { status: 'retry'; reason: string; retryAt?: Date }
  | { status: 'blocked'; reason: string };

type TradeTransport = Pick<TradeCompatibleTransport, 'search' | 'fetchDetails'>;
type Economy = Pick<MarketEconomyRepository, 'latest' | 'find'>;
type TradeCaptureOptions = {
  sessions?: () => ReturnType<typeof createTradeSessionRepository>;
  recoverAuthentication?: boolean;
};

function authenticationDenial(
  response: MarketCollectionTransportResponse<unknown>,
) {
  if (response.status === 401) return 'PROVIDER_AUTH_FAILED';
  if (response.status === 403)
    return response.headers.get('cf-mitigated') === 'challenge'
      ? 'PROVIDER_CHALLENGE'
      : 'PROVIDER_ACCESS_DENIED';
  return null;
}

function fingerprint(item: CanonicalJsonObject) {
  const { baseType, itemLevel } = item;
  if (typeof baseType !== 'string' || typeof itemLevel !== 'number')
    return null;
  const mods = Object.entries(item).filter(
    ([key, value]) => key.endsWith('Mods') && Array.isArray(value),
  );
  const rolls: Record<string, string[]> = {};
  for (const [key, value] of mods) {
    const parsed = modifierRolls.safeParse(value);
    if (!parsed.success) return null;
    if (parsed.data.length)
      rolls[key] = parsed.data.map((mod) => JSON.stringify(mod)).sort();
  }
  return Object.keys(rolls).length
    ? marketDigest({ baseType, itemLevel, rolls })
    : null;
}

async function captureFx(target: MarketTarget, economy: Economy, at: Date) {
  const snapshotId =
    target.tradeSearch?.exchangeSnapshotId ??
    (await economy.latest(target.league, 'Currency'))?.id;
  if (!snapshotId) return null;
  const quote = await convertMarketQuote({
    money: { amount: '1', currency: 'divine' },
    currency: 'chaos',
    target,
    capturedAt: at.toISOString(),
    exchangeSnapshotId: snapshotId,
    economy,
    now: at.getTime(),
    dataKind: 'observed',
  });
  return quote?.exchange ?? null;
}

async function collectTradeCapture(
  target: MarketTarget,
  signal: AbortSignal,
  transport: TradeTransport,
  rateLimits: RateLimitGate,
  economy: Economy,
  reauthenticate: (() => Promise<TradeTransport | null>) | undefined,
  recoverAuthentication: boolean,
): Promise<TradeCaptureResult> {
  const started = Date.now();
  let authenticationAttempted = false;
  let currentTransport = transport;
  async function permit(endpoint: 'trade-search' | 'trade-fetch') {
    signal.throwIfAborted();
    await rateLimits.waitForPermit(endpoint, signal, {
      collector: true,
      deferProviderBlock: true,
    });
    signal.throwIfAborted();
  }

  async function request<T>(
    endpoint: 'trade-search' | 'trade-fetch',
    run: (
      transport: TradeTransport,
    ) => Promise<MarketCollectionTransportResponse<T>>,
  ) {
    const refresh = async (
      reason: NonNullable<ReturnType<typeof authenticationDenial>>,
    ) => {
      authenticationAttempted = true;
      await permit(endpoint);
      let refreshed: TradeTransport | null | undefined;
      try {
        refreshed = await reauthenticate?.();
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof TradeLoginRateLimited) {
          const state = await rateLimits.observeResponse(endpoint, error, {
            collector: true,
          });
          throw new ProviderRateLimitDeferred(state.blockedUntil);
        }
        throw new DomainError(reason);
      }
      signal.throwIfAborted();
      if (!refreshed) throw new DomainError(reason);
      currentTransport = refreshed;
    };
    const send = async () => {
      await permit(endpoint);
      const response = await run(currentTransport);
      const state = await rateLimits.observeResponse(endpoint, response, {
        collector: true,
      });
      signal.throwIfAborted();
      if (response.status === 429)
        throw new ProviderRateLimitDeferred(state.blockedUntil);
      if (
        response.status === 503 &&
        response.headers.get('retry-after') &&
        state.blockedUntil.getTime() > Date.now()
      )
        throw new ProviderRateLimitDeferred(
          state.blockedUntil,
          'PROVIDER_UNAVAILABLE',
        );
      return response;
    };

    if (recoverAuthentication && reauthenticate && !authenticationAttempted)
      await refresh('PROVIDER_AUTH_FAILED');
    let response = await send();
    let denial: ReturnType<typeof authenticationDenial> =
      authenticationDenial(response);
    if (denial && reauthenticate && !authenticationAttempted) {
      await refresh(denial);
      response = await send();
      denial = authenticationDenial(response);
    }
    if (denial) throw new DomainError(denial);
    if (response.status >= 500) throw new DomainError('PROVIDER_UNAVAILABLE');
    if (response.status >= 400) throw new DomainError('MARKET_QUERY_INVALID');
    if (response.cached) throw new DomainError('PROVIDER_RESPONSE_INVALID');
    return response.data;
  }

  const rows = new Map<string, MarketImportListing>();
  const attempted = new Set<string>();
  const fetchRows = async (ids: string[], queryId: string) => {
    const newIds = ids.filter((id) => !attempted.has(id));
    for (let i = 0; i < newIds.length; i += detailBatchSize) {
      const batch = newIds.slice(i, i + detailBatchSize);
      batch.forEach((id) => attempted.add(id));
      const details = await request('trade-fetch', (transport) =>
        transport.fetchDetails({ target, signal, ids: batch, queryId }),
      );
      const seen = new Set<string>();
      for (const detail of details) {
        const row = marketImportListingSchema.safeParse(detail);
        const id = row.success ? row.data.externalId : undefined;
        if (!row.success || !id || !batch.includes(id)) {
          partialReason ??= 'DETAILS_INCOMPLETE';
        } else if (seen.has(id)) {
          rows.delete(id);
          partialReason ??= 'DETAILS_INCOMPLETE';
        } else {
          seen.add(id);
          rows.set(id, row.data);
        }
      }
    }
  };

  const search = (priceRange?: TradePriceRange) =>
    request('trade-search', (transport) =>
      transport.search({
        target,
        signal,
        ...(priceRange ? { priceRange } : {}),
      }),
    );
  let sliceCount = 0;
  let partialReason: string | null = null;
  const singleCurrency = target.tradeSearch?.includeOtherCurrencies
    ? undefined
    : target.tradeSearch?.currency;
  const covered = new Set<string>();
  async function prove(
    page: Awaited<ReturnType<typeof search>>,
    range: TradePriceRange,
  ): Promise<void> {
    const total = page.reportedTotal;
    if (
      !page.queryId ||
      total === null ||
      total > 2_147_483_647 ||
      page.ids.length > completeOutputLimit
    )
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    const ids = [...new Set(page.ids)];
    await fetchRows(ids, page.queryId);
    if (page.inexact || ids.length !== page.ids.length) {
      partialReason ??= 'SEARCH_INEXACT';
      return;
    }
    const asks = ids.flatMap((id) => {
      const row = rows.get(id);
      if (!row || row.price === null || row.currency !== singleCurrency)
        return [];
      return row.price >= (range.min ?? 0) &&
        row.price <= (range.max ?? Infinity)
        ? [row.price]
        : [];
    });
    if (
      ids.some((id) => !rows.has(id)) ||
      (singleCurrency && asks.length !== ids.length)
    ) {
      partialReason ??= 'DETAILS_INCOMPLETE';
      return;
    }
    if (total === ids.length) {
      ids.forEach((id) => covered.add(id));
      return;
    }
    if (total <= completeOutputLimit) {
      partialReason ??= 'SEARCH_TRUNCATED';
      return;
    }
    // shortcut: mixed-currency ranges remain partial until Trade's bounds can be reconciled across denominations.
    if (!singleCurrency) {
      partialReason ??= 'MIXED_CURRENCY_SLICE_UNPROVEN';
      return;
    }
    // Both bounds are inclusive. Dedupe the overlap rather than guessing the next valid fractional ask.
    const pivot = Math.max(
      ...asks.filter(
        (ask) => ask > (range.min ?? 0) && ask < (range.max ?? Infinity),
      ),
    );
    if (!Number.isFinite(pivot)) {
      partialReason ??= 'PRICE_SLICE_UNRESOLVED';
      return;
    }
    for (const child of [
      { ...range, max: pivot },
      { ...range, min: pivot },
    ]) {
      if (sliceCount === maxPriceSlices) {
        partialReason ??= 'PRICE_SLICE_LIMIT';
        return;
      }
      sliceCount++;
      await prove(await search(child), child);
    }
  }

  try {
    const root = await search();
    if (root.capturedAt === null || root.reportedTotal === null)
      throw new DomainError('PROVIDER_RESPONSE_INVALID');
    const capturedAt = new Date(root.capturedAt);
    const fx =
      target.tradeSearch?.includeOtherCurrencies || singleCurrency === 'divine'
        ? await captureFx(target, economy, capturedAt)
        : null;
    let sortedSampleIds: string[] | null = null;
    const startingBase = target.slot === 'starting-base';
    if (startingBase && root.reportedTotal > 20) {
      if (
        !root.queryId ||
        root.reportedTotal > 2_147_483_647 ||
        root.ids.length > completeOutputLimit
      )
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const sampleIds = root.ids.slice(0, 20);
      await fetchRows(sampleIds, root.queryId);
      if (new Set(root.ids).size !== root.ids.length || root.inexact)
        partialReason ??= 'SEARCH_INEXACT';
      const sortedSampleComplete =
        !partialReason &&
        isCompleteSortedPriceSample(
          {
            batchCount: Math.ceil(rows.size / detailBatchSize),
            cached: false,
            capturedAt: root.capturedAt,
            coverage: 'partial',
            currency: root.currency,
            fetchedCount: rows.size,
            listings: [...rows.values()],
            reportedTotal: root.reportedTotal,
            returnedCount: root.ids.length,
            inexact: root.inexact ?? false,
            searchEvidence: marketCollectionSearchEvidenceSchema.parse({
              ids: root.ids,
              queryId: root.queryId,
              reportedTotal: root.reportedTotal,
              ...(root.request ? { request: root.request } : {}),
            }),
          },
          target,
        );
      if (sortedSampleComplete) sortedSampleIds = sampleIds;
    }
    if (
      startingBase &&
      !singleCurrency &&
      root.reportedTotal > completeOutputLimit
    ) {
      partialReason ??= 'MIXED_CURRENCY_SLICE_UNPROVEN';
    } else {
      await prove(root, {});
      if (
        covered.size !== root.reportedTotal ||
        !root.ids.every((id) => covered.has(id)) ||
        rows.size !== covered.size
      )
        partialReason ??= 'SEARCH_TOTAL_MISMATCH';
    }
    if (sliceCount > 0 && partialReason === null) {
      const recheck = await search();
      const confirmed = new Set(recheck.ids);
      if (
        recheck.inexact ||
        recheck.reportedTotal !== root.reportedTotal ||
        recheck.ids.length !== root.ids.length ||
        !root.ids.every((id) => confirmed.has(id))
      )
        partialReason = 'SEARCH_CHANGED_DURING_CAPTURE';
    }
    const listings: Capture['listings'] = Array.from(rows, ([itemId, row]) => {
      const price =
        row.price !== null && row.currency
          ? { amount: String(row.price), currency: row.currency }
          : null;
      const priceChaos =
        price?.currency === 'chaos'
          ? price.amount
          : price?.currency === 'divine' && fx
            ? convertChaosDivineQuote(price, 'chaos', fx.chaosPerDivine).amount
            : null;
      const seller =
        typeof row.item.seller === 'string' ? row.item.seller : null;
      return {
        itemId,
        seller,
        fingerprint: fingerprint(row.item),
        price,
        priceChaos,
        indexedAt: row.listedAt ? new Date(row.listedAt) : null,
        item: row.rawListing?.item
          ? { rawItem: row.rawListing.item }
          : row.item,
      };
    });
    return {
      status: 'success',
      capture: {
        capturedAt,
        reportedTotal: root.reportedTotal,
        fetched: listings.length,
        complete: partialReason === null,
        sortedSampleIds,
        partialReason,
        slices: sliceCount || 1,
        fxSnapshotId: fx?.snapshotId ?? null,
        durationMs: Math.max(0, Date.now() - started),
        listings,
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProviderRateLimitDeferred)
      return {
        status: 'retry',
        reason: error.reason,
        retryAt: error.retryAt,
      };
    if (
      error instanceof DomainError &&
      [
        'MARKET_ACCESS_BLOCKED',
        'PROVIDER_AUTH_FAILED',
        'PROVIDER_CHALLENGE',
        'PROVIDER_ACCESS_DENIED',
      ].includes(error.code)
    )
      return { status: 'blocked', reason: error.code };
    return {
      status: 'retry',
      reason:
        error instanceof DomainError ? error.code : 'MARKET_COLLECTION_FAILED',
    };
  }
}

export function configuredTradeCapture(
  rateLimits: RateLimitGate,
  economy: Economy,
  environment: Record<string, string | undefined> = process.env,
): (
  schedule: Pick<typeof collectorSchedule.$inferSelect, 'payload'>,
  signal: AbortSignal,
  options?: TradeCaptureOptions,
) => Promise<TradeCaptureResult> {
  if (
    environment.MARKET_COLLECTION_SOURCE !== 'trade-compatible' ||
    environment.POE_TRADE_ACCESS !== 'owner_permitted'
  )
    return async () => ({ status: 'blocked', reason: 'MARKET_ACCESS_BLOCKED' });

  const tradeConfig = loadTradeCompatibleConfig(environment);
  const makeTransport = (sessionId?: string) =>
    new TradeCompatibleTransport(
      { ...tradeConfig, ...(sessionId ? { sessionId } : {}) },
      { collector: true },
    );
  return async (schedule, signal, options = {}) => {
    signal.throwIfAborted();
    let target: MarketTarget;
    try {
      const { query } = schedulePayload.parse(schedule.payload);
      target = recipeQueryTarget(query.handbookTarget);
    } catch {
      return { status: 'retry', reason: 'MARKET_QUERY_INVALID' };
    }
    const { recoverAuthentication = false } = options;
    let sessions: ReturnType<typeof createTradeSessionRepository>;
    try {
      if (!options.sessions)
        return { status: 'blocked', reason: 'TRADE_SESSION_KEY_INVALID' };
      sessions = options.sessions();
    } catch {
      return { status: 'blocked', reason: 'TRADE_SESSION_KEY_INVALID' };
    }
    let loginConfig: ReturnType<typeof loadTradeLoginConfig>;
    try {
      loginConfig = loadTradeLoginConfig(environment);
    } catch {
      // Incomplete browser credentials only disable recovery.
      loginConfig = undefined;
    }
    const reauthenticate = loginConfig
      ? async () => {
          const manager = new PoeTradeSessionManager(
            tradeConfig.baseURL,
            loginConfig,
          );
          let refreshed: TradeTransport | null = null;
          try {
            await manager.reauthenticate(async (session) => {
              await sessions.save(session);
              refreshed = makeTransport(session);
            }, signal);
            return refreshed;
          } finally {
            await manager.stop();
          }
        }
      : undefined;
    let session: string | null | undefined;
    if (!recoverAuthentication || !reauthenticate) {
      try {
        session = await sessions.read();
      } catch (error) {
        signal.throwIfAborted();
        return error instanceof TradeSessionDecryptError
          ? { status: 'blocked', reason: 'TRADE_SESSION_DECRYPT_FAILED' }
          : { status: 'retry', reason: 'TRADE_SESSION_UNAVAILABLE' };
      }
    }
    return collectTradeCapture(
      target,
      signal,
      makeTransport(session ?? undefined),
      rateLimits,
      economy,
      reauthenticate,
      recoverAuthentication,
    );
  };
}
