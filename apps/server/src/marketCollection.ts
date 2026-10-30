import type {
  MarketCollectionPoint,
  MarketCollectionRun,
  MarketCollectionSettings,
  MarketCollectionSettingsInput,
  MarketCollectionSource,
  MarketImportListing,
  MarketImportListingInput,
  MarketTarget,
} from '@poe-worksmith/contracts';
import {
  marketImportListingSchema,
  marketCollectionRunSchema,
  marketCollectionSettingsInputSchema,
  marketCollectionSettingsSchema,
} from '@poe-worksmith/contracts';
import { randomUUID } from 'node:crypto';
import { DomainError } from '@poe-worksmith/domain';

import { canonicalMarketJson, marketDigest } from './marketResearch.js';
import type { RateLimitGate } from './rateLimitController.js';

const detailBatchSize = 10;

export type MarketCollectionBatch = {
  batchCount: number;
  cached: boolean;
  cancelled?: boolean;
  capturedAt: string | null;
  coverage: 'complete' | 'partial' | 'unknown';
  currency: 'chaos' | 'divine' | null;
  errorCode?: string | null;
  fetchedCount: number;
  listings: MarketImportListing[];
  reportedTotal: number | null;
  retryAt?: string | null;
  returnedCount: number;
};

export interface MarketCollectionAdapter {
  descriptor: MarketCollectionSource;
  collect(input: {
    target: MarketTarget;
    signal: AbortSignal;
  }): Promise<MarketCollectionBatch>;
}

export type MarketCollectionTransportResponse<T> = {
  cached: boolean;
  data: T;
  headers: Pick<Headers, 'get'>;
  status: number;
};

export interface MarketCollectionTransport {
  search(input: {
    signal: AbortSignal;
    target: MarketTarget;
  }): Promise<
    MarketCollectionTransportResponse<{
      capturedAt: string | null;
      coverage: MarketCollectionBatch['coverage'];
      currency: MarketCollectionBatch['currency'];
      ids: string[];
      queryId: string | null;
      reportedTotal: number | null;
    }>
  >;
  fetchDetails(input: {
    ids: string[];
    queryId: string | null;
    signal: AbortSignal;
  }): Promise<
    MarketCollectionTransportResponse<Array<MarketImportListingInput | null>>
  >;
}

export interface MarketCollectionStore {
  findTarget(id: string): Promise<MarketTarget | null>;
  findSettings(targetId: string): Promise<MarketCollectionSettings | null>;
  listSettings(): Promise<MarketCollectionSettings[]>;
  saveSettings(
    settings: MarketCollectionSettings,
  ): Promise<MarketCollectionSettings>;
  claimScheduledSettings(
    settings: MarketCollectionSettings,
    dueAt: string,
  ): Promise<boolean>;
  findRun(id: string): Promise<MarketCollectionRun | null>;
  listRuns(targetId: string, limit?: number): Promise<MarketCollectionRun[]>;
  listObservations(targetId: string): Promise<MarketCollectionObservation[]>;
  saveRun(run: MarketCollectionRun): Promise<MarketCollectionRun>;
  requestCancel(runId: string): Promise<MarketCollectionRun | null>;
  recoverRunningRuns(at: string, activeRunIds?: string[]): Promise<string[]>;
}

export function collectionSettings(
  targetId: string,
  patch: MarketCollectionSettingsInput,
  previous: MarketCollectionSettings | null,
  now = new Date(),
) {
  const input = marketCollectionSettingsInputSchema.parse(patch);
  const intervalMinutes =
    input.intervalMinutes ?? previous?.intervalMinutes ?? 60;
  const enabled = input.enabled ?? previous?.enabled ?? false;
  const paused = input.paused ?? previous?.paused ?? false;
  const changed =
    !previous ||
    input.enabled !== undefined ||
    input.paused !== undefined ||
    input.intervalMinutes !== undefined;
  return marketCollectionSettingsSchema.parse({
    targetId,
    enabled,
    paused,
    intervalMinutes,
    nextRunAt:
      enabled && !paused
        ? changed
          ? new Date(now.getTime() + intervalMinutes * 60_000).toISOString()
          : (previous?.nextRunAt ?? null)
        : null,
    updatedAt: now.toISOString(),
  });
}

export const disabledMarketCollectionSource: MarketCollectionAdapter = {
  descriptor: {
    id: 'ggg-public-trade',
    name: 'Официальный источник объявлений GGG',
    access: 'blocked',
    dataKind: 'observed',
    reason:
      'GGG не документирует Trade search/fetch как API; источник не подключён. Включите только после явного разрешения поддерживаемого доступа.',
  },
  async collect() {
    throw new DomainError('MARKET_ACCESS_BLOCKED');
  },
};

export const manualImportMarketCollectionSource: MarketCollectionAdapter = {
  descriptor: {
    id: 'manual-import',
    name: 'Ручной импорт объявлений',
    access: 'blocked',
    dataKind: 'observed',
    reason:
      'Автоматический Trade endpoint не поддерживается документацией GGG. Импортируйте выбранные объявления из пользовательской сессии.',
  },
  async collect() {
    throw new DomainError('MARKET_ACCESS_BLOCKED');
  },
};

export function configuredMarketCollectionSource(value?: string) {
  switch (value?.trim() || 'manual-import') {
    case 'manual-import':
      return manualImportMarketCollectionSource;
    case 'disabled':
      return disabledMarketCollectionSource;
    default:
      throw new TypeError(
        'MARKET_COLLECTION_SOURCE must be manual-import or disabled',
      );
  }
}

/** Runs one search then fetches at most 1,000 details in sequential groups of 10. */
export function createBatchedMarketCollectionSource(options: {
  descriptor: MarketCollectionSource;
  rateLimits: RateLimitGate;
  transport: MarketCollectionTransport;
}): MarketCollectionAdapter {
  let accessBlocked = false;
  return {
    descriptor: options.descriptor,
    async collect({ target, signal }) {
      const search = await rateLimitedRequest(
        'trade-search',
        signal,
        options.rateLimits,
        () => options.transport.search({ target, signal }),
        () => accessBlocked,
        () => {
          accessBlocked = true;
        },
      );
      if (
        !search.data ||
        typeof search.data !== 'object' ||
        !Array.isArray(search.data.ids) ||
        search.data.ids.some((id) => typeof id !== 'string')
      )
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const ids = [...new Set(search.data.ids)];
      if (
        ids.length !== search.data.ids.length ||
        ids.some((id) => id.trim().length === 0 || id.length > 256)
      )
        throw new DomainError('PROVIDER_RESPONSE_INVALID');
      const selectedIds = ids.slice(0, 1000);
      const listings: MarketImportListing[] = [];
      let cached = search.cached;
      let batchCount = 0;
      let errorCode: string | null = null;
      let cancelled = false;
      for (let index = 0; index < selectedIds.length; index += detailBatchSize) {
        const batchIds = selectedIds.slice(index, index + detailBatchSize);
        try {
          const response = await rateLimitedRequest(
            'trade-fetch',
            signal,
            options.rateLimits,
            () =>
              options.transport.fetchDetails({
                ids: batchIds,
                queryId: search.data.queryId,
                signal,
              }),
            () => accessBlocked,
            () => {
              accessBlocked = true;
            },
          );
          const detailResponse = marketImportListingSchema
            .nullable()
            .array()
            .max(batchIds.length)
            .safeParse(response.data);
          if (!detailResponse.success)
            throw new DomainError('PROVIDER_RESPONSE_INVALID');
          const details = detailResponse.data.filter(
            (listing): listing is MarketImportListing => listing !== null,
          );
          const returnedIds = details.flatMap((listing) =>
            listing.externalId ? [listing.externalId] : [],
          );
          if (
            returnedIds.length !== details.length ||
            new Set(returnedIds).size !== returnedIds.length ||
            returnedIds.some((id) => !batchIds.includes(id))
          )
            throw new DomainError('PROVIDER_RESPONSE_INVALID');
          listings.push(...details);
          cached ||= response.cached;
          batchCount += 1;
        } catch (error) {
          if (
            signal.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          )
            cancelled = true;
          else
            errorCode =
              error instanceof DomainError
                ? error.code
                : 'MARKET_COLLECTION_FAILED';
          break;
        }
      }
      const partial =
        cancelled ||
        errorCode !== null ||
        ids.length > selectedIds.length ||
        search.data.coverage !== 'complete' ||
        (search.data.reportedTotal !== null &&
          ids.length < search.data.reportedTotal) ||
        listings.length !== selectedIds.length;
      return {
        batchCount,
        cached,
        capturedAt: search.data.capturedAt,
        coverage: partial ? 'partial' : 'complete',
        currency: search.data.currency,
        fetchedCount: listings.length,
        listings,
        reportedTotal: search.data.reportedTotal,
        returnedCount: ids.length,
        ...(cancelled ? { cancelled: true } : {}),
        ...(errorCode ? { errorCode } : {}),
      };
    },
  };
}

async function rateLimitedRequest<T>(
  endpoint: 'trade-search' | 'trade-fetch',
  signal: AbortSignal,
  rateLimits: RateLimitGate,
  request: () => Promise<MarketCollectionTransportResponse<T>>,
  accessBlocked: () => boolean,
  blockAccess: () => void,
) {
  throwIfAborted(signal);
  await rateLimits.waitForPermit(endpoint, signal);
  throwIfAborted(signal);
  if (accessBlocked()) throw new DomainError('MARKET_ACCESS_BLOCKED');
  const response = await request();
  if (response.status === 401 || response.status === 403) blockAccess();
  await rateLimits.observeResponse(endpoint, response);
  if (response.status === 401 || response.status === 403)
    throw new DomainError('PROVIDER_AUTH_FAILED');
  if (response.status === 429)
    throw new DomainError('PROVIDER_RATE_LIMITED');
  if (response.status >= 400 && response.status < 500)
    throw new DomainError('MARKET_QUERY_INVALID');
  if (response.status >= 500)
    throw new DomainError('PROVIDER_UNAVAILABLE');
  return response;
}

/** Replays explicit fixtures as demo data; repeated calls retain the original capture time. */
export function createReplayMarketCollectionSource(
  snapshots: readonly MarketCollectionBatch[],
): MarketCollectionAdapter {
  let cursor = 0;
  let last: MarketCollectionBatch | undefined;
  const responses = new Map<
    string,
    { batch: MarketCollectionBatch; ids: string[] }
  >();
  const transport: MarketCollectionTransport = {
    async search({ signal }) {
      throwIfAborted(signal);
      const next = snapshots[cursor++];
      const batch = next ?? (last ? { ...last, cached: true } : undefined);
      if (!batch) throw new DomainError('PROVIDER_UNAVAILABLE');
      last = batch;
      const queryId = randomUUID();
      const count = Math.max(batch.returnedCount, batch.listings.length);
      const ids = Array.from(
        { length: count },
        (_, index) =>
          batch.listings[index]?.externalId ?? `fixture-${queryId}-${index}`,
      );
      responses.set(queryId, { batch, ids });
      return {
        cached: batch.cached,
        data: {
          capturedAt: batch.capturedAt,
          coverage: batch.coverage,
          currency: batch.currency,
          ids,
          queryId,
          reportedTotal: batch.reportedTotal,
        },
        headers: new Headers(),
        status: 200,
      };
    },
    async fetchDetails({ ids, queryId, signal }) {
      throwIfAborted(signal);
      const replay = queryId ? responses.get(queryId) : undefined;
      if (!replay) throw new DomainError('PROVIDER_RESPONSE_INVALID');
      return {
        cached: replay.batch.cached,
        data: ids.flatMap((id) => {
          const index = replay.ids.indexOf(id);
          const listing = replay.batch.listings[index];
          return listing ? [listing] : [];
        }),
        headers: new Headers(),
        status: 200,
      };
    },
  };
  const replayRateLimits: RateLimitGate = {
    async waitForPermit(endpoint, signal) {
      throwIfAborted(signal);
      return emptyRateLimitState(endpoint);
    },
    async observeResponse(endpoint) {
      return emptyRateLimitState(endpoint);
    },
  };
  return createBatchedMarketCollectionSource({
    descriptor: {
      id: 'fixture-replay',
      name: 'Локальный replay fixtures',
      access: 'replay',
      dataKind: 'demo',
      reason: 'Учебные данные для проверки последовательных снимков; не рынок.',
    },
    rateLimits: replayRateLimits,
    transport,
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function emptyRateLimitState(endpoint: string) {
  const now = new Date(0);
  return {
    blockedUntil: now,
    endpoints: [endpoint],
    lastResponseAt: null,
    lastStatus: null,
    minimumDelayMs: 0,
    nextRequestAt: now,
    policy: 'fixture-replay',
    updatedAt: now,
    windows: [],
  };
}

export class MarketCollectionManager {
  readonly #active = new Map<string, AbortController>();
  readonly #adapter: MarketCollectionAdapter;
  readonly #activeRunIds = new Map<string, string>();
  readonly #clock: () => Date;
  readonly #store: MarketCollectionStore;
  readonly #requests = new Set<Promise<MarketCollectionRun>>();
  readonly #tasks = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopping = false;
  #accessBlocked = false;

  constructor(options: {
    adapter: MarketCollectionAdapter;
    clock?: () => Date;
    store: MarketCollectionStore;
  }) {
    this.#adapter = options.adapter;
    this.#clock = options.clock ?? (() => new Date());
    this.#store = options.store;
  }

  get source() {
    return this.#accessBlocked
      ? {
          ...this.#adapter.descriptor,
          access: 'blocked' as const,
          reason: 'Источник заблокирован после отказа доступа; повторные запросы отключены.',
        }
      : this.#adapter.descriptor;
  }

  async start(intervalMs = 30_000) {
    if (this.#timer) return;
    await this.#recoverRunningRuns();
    this.#timer = setInterval(() => this.#track(this.tick()), intervalMs);
    await this.tick();
  }

  async stop() {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    while (this.#requests.size > 0 || this.#tasks.size > 0) {
      for (const controller of this.#active.values()) controller.abort();
      await Promise.allSettled([...this.#requests, ...this.#tasks]);
    }
  }

  async updateSettings(targetId: string, patch: unknown) {
    const target = await this.#store.findTarget(targetId);
    if (!target) throw new DomainError('MARKET_TARGET_NOT_FOUND');
    const previous = await this.#store.findSettings(targetId);
    const settings = collectionSettings(
      targetId,
      patch as MarketCollectionSettingsInput,
      previous,
      this.#clock(),
    );
    return this.#store.saveSettings(settings);
  }

  runNow(targetId: string, trigger: 'manual' | 'scheduled' = 'manual') {
    if (this.#stopping)
      return Promise.reject(new DomainError('MARKET_COLLECTION_BUSY'));
    const request = this.#runNow(targetId, trigger);
    this.#requests.add(request);
    void request.then(
      () => this.#requests.delete(request),
      () => this.#requests.delete(request),
    );
    return request;
  }

  async #runNow(
    targetId: string,
    trigger: 'manual' | 'scheduled' = 'manual',
  ) {
    const target = await this.#store.findTarget(targetId);
    if (!target) throw new DomainError('MARKET_TARGET_NOT_FOUND');
    const settings = await this.#store.findSettings(targetId);
    if (settings?.paused) throw new DomainError('MARKET_COLLECTION_PAUSED');
    if (
      trigger === 'scheduled' &&
      (!settings?.enabled || settings.paused)
    )
      throw new DomainError('MARKET_COLLECTION_PAUSED');
    if (this.#active.has(targetId))
      throw new DomainError('MARKET_COLLECTION_BUSY');

    const startedAt = this.#clock().toISOString();
    const queryDigest = marketDigest({
      version: 1,
      targetId: target.id,
      targetDigest: target.digest,
      league: target.league,
      patch: target.patch,
      source: this.#adapter.descriptor.id,
    });
    const run = marketCollectionRunSchema.parse({
      id: randomUUID(),
      targetId,
      targetDigest: target.digest,
      league: target.league,
      patch: target.patch,
      sourceId: this.#adapter.descriptor.id,
      queryDigest,
      dataKind: this.#adapter.descriptor.dataKind,
      trigger,
      status: 'running',
      coverage: null,
      reportedTotal: null,
      returnedCount: 0,
      fetchedCount: 0,
      cached: false,
      currency: null,
      listings: [],
      startedAt,
      capturedAt: null,
      completedAt: null,
      batchCount: 0,
      listingCount: 0,
      errorCode: null,
      retryAt: null,
      snapshotId: null,
      cancelRequested: false,
    });
    const stored = await this.#store.saveRun(run);
    const controller = new AbortController();
    this.#active.set(targetId, controller);
    this.#activeRunIds.set(stored.id, targetId);
    this.#track(this.#execute(target, stored, controller));
    return stored;
  }

  async cancel(runId: string) {
    const existing = await this.#store.findRun(runId);
    if (!existing || existing.status !== 'running')
      throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
    this.#active.get(existing.targetId)?.abort();
    const requested = await this.#store.requestCancel(runId);
    if (!requested) throw new DomainError('MARKET_COLLECTION_NOT_RUNNING');
    return requested;
  }

  async tick() {
    await this.#recoverRunningRuns();
    if (this.source.access === 'blocked') return;
    const now = this.#clock();
    const settings = await this.#store.listSettings();
    for (const setting of settings) {
      if (
        !setting.enabled ||
        setting.paused ||
        !setting.nextRunAt ||
        Date.parse(setting.nextRunAt) > now.getTime() ||
        this.#active.has(setting.targetId)
      )
        continue;
      const target = await this.#store.findTarget(setting.targetId);
      if (!target) continue;
      const claimed = await this.#store.claimScheduledSettings({
        ...setting,
        nextRunAt: new Date(
          now.getTime() + setting.intervalMinutes * 60_000,
        ).toISOString(),
        updatedAt: now.toISOString(),
      }, setting.nextRunAt);
      if (!claimed) continue;
      await this.runNow(target.id, 'scheduled').catch(() => undefined);
    }
  }

  #track(task: Promise<void>) {
    this.#tasks.add(task);
    void task.catch(() => undefined).finally(() => this.#tasks.delete(task));
  }

  async #recoverRunningRuns() {
    const activeRunIds = [...this.#activeRunIds.keys()];
    const cancelledRunIds = await this.#store.recoverRunningRuns(
      this.#clock().toISOString(),
      activeRunIds,
    );
    for (const runId of cancelledRunIds) {
      const targetId = this.#activeRunIds.get(runId);
      if (targetId) this.#active.get(targetId)?.abort();
    }
  }

  async #execute(
    target: MarketTarget,
    initial: MarketCollectionRun,
    controller: AbortController,
  ) {
    let result: MarketCollectionRun;
    try {
      if (this.source.access === 'blocked') {
        result = this.#finish(initial, 'blocked', {
          errorCode: 'MARKET_ACCESS_BLOCKED',
        });
      } else {
        const batch = await this.#adapter.collect({
          target,
          signal: controller.signal,
        });
        validateCollectionBatch(batch);
        const cappedListings = batch.listings.slice(0, 1000);
        const accessDenied =
          batch.errorCode === 'PROVIDER_AUTH_FAILED' ||
          batch.errorCode === 'MARKET_ACCESS_BLOCKED';
        if (accessDenied) {
          this.#accessBlocked = true;
          for (const active of this.#active.values())
            if (active !== controller) active.abort();
        }
        const partial =
          batch.cancelled === true ||
          batch.errorCode != null ||
          batch.coverage !== 'complete' ||
          batch.batchCount > 100 ||
          batch.returnedCount > 1000 ||
          batch.listings.length > 1000 ||
          batch.fetchedCount < batch.returnedCount ||
          batch.listings.length !== batch.fetchedCount ||
          (batch.reportedTotal !== null &&
            batch.returnedCount < batch.reportedTotal);
        const status =
          batch.cancelled
            ? 'cancelled'
            : accessDenied
              ? 'blocked'
              : batch.errorCode === 'PROVIDER_RATE_LIMITED'
                ? 'rate_limited'
                : batch.errorCode
                  ? 'failed'
                  : partial
                    ? 'partial'
                    : cappedListings.length === 0
                      ? 'empty'
                      : 'succeeded';
        result = marketCollectionRunSchema.parse({
          ...initial,
          status,
          coverage: partial ? 'partial' : 'complete',
          reportedTotal: batch.reportedTotal,
          returnedCount: batch.returnedCount,
          fetchedCount: batch.fetchedCount,
          cached: batch.cached,
          currency: batch.currency,
          listings: cappedListings.map((listing) => ({
            ...listing,
            fingerprint: marketDigest(listing),
          })),
          capturedAt: batch.capturedAt,
          completedAt: this.#clock().toISOString(),
          snapshotId: initial.id,
          batchCount: Math.min(batch.batchCount, 100),
          listingCount: cappedListings.length,
          errorCode: batch.errorCode ?? null,
          retryAt: batch.retryAt ?? null,
        });
      }
    } catch (error) {
      const accessDenied =
        error instanceof DomainError && error.code === 'PROVIDER_AUTH_FAILED';
      if (accessDenied) {
        this.#accessBlocked = true;
        for (const active of this.#active.values()) active.abort();
      }
      const blocked =
        accessDenied ||
        (error instanceof DomainError &&
          error.code === 'MARKET_ACCESS_BLOCKED');
      const rateLimited =
        error instanceof DomainError && error.code === 'PROVIDER_RATE_LIMITED';
      const cancelled =
        controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError');
      result = this.#finish(
        initial,
        blocked ? 'blocked' : rateLimited ? 'rate_limited' : cancelled ? 'cancelled' : 'failed',
        {
          errorCode:
            error instanceof DomainError
              ? error.code
              : controller.signal.aborted
                ? null
                : 'MARKET_COLLECTION_FAILED',
        },
      );
    }
    try {
      const requested = await this.#store.findRun(initial.id);
      if (!requested?.cancelRequested || result.status === 'cancelled')
        await this.#store.saveRun(result);
      else
        await this.#store.saveRun(
          this.#finish(result, 'cancelled', {
            coverage: 'partial',
            errorCode: null,
          }),
        );
    } finally {
      this.#activeRunIds.delete(initial.id);
      if (this.#active.get(target.id) === controller)
        this.#active.delete(target.id);
    }
  }

  #finish(
    run: MarketCollectionRun,
    status: MarketCollectionRun['status'],
    patch: Partial<MarketCollectionRun>,
  ) {
    return marketCollectionRunSchema.parse({
      ...run,
      ...patch,
      status,
      completedAt: this.#clock().toISOString(),
    });
  }
}

function validateCollectionBatch(batch: MarketCollectionBatch) {
  if (
    !Number.isInteger(batch.batchCount) ||
    batch.batchCount < 0 ||
    !Number.isInteger(batch.returnedCount) ||
    batch.returnedCount < 0 ||
    !Number.isInteger(batch.fetchedCount) ||
    batch.fetchedCount < 0 ||
    (batch.reportedTotal !== null &&
      (!Number.isInteger(batch.reportedTotal) || batch.reportedTotal < 0)) ||
    (batch.errorCode != null && batch.errorCode.length > 100) ||
    batch.listings.some(
      (listing) =>
        (listing.price !== null &&
          (!Number.isFinite(listing.price) || listing.price <= 0)) ||
        (listing.externalId !== undefined && listing.externalId.length > 256),
    )
  )
    throw new DomainError('PROVIDER_RESPONSE_INVALID');
  const ids = batch.listings.flatMap((listing) =>
    listing.externalId ? [listing.externalId] : [],
  );
  if (new Set(ids).size !== ids.length)
    throw new DomainError('PROVIDER_RESPONSE_INVALID');
  if (batch.listings.length > 0 && !batch.currency)
    throw new DomainError('PROVIDER_RESPONSE_INVALID');
}

export type MarketCollectionObservation = Omit<
  Pick<
    MarketCollectionRun,
    | 'id'
    | 'targetId'
    | 'targetDigest'
    | 'queryDigest'
    | 'league'
    | 'patch'
    | 'status'
    | 'coverage'
    | 'currency'
    | 'startedAt'
    | 'capturedAt'
    | 'cached'
    | 'dataKind'
  >,
  'listings'
> & {
  listings: Array<{
    externalId?: string;
    fingerprint?: string;
    currency?: string;
    item?: MarketCollectionRun['listings'][number]['item'];
    price: number | null;
  }>;
};

/** Compares positive IDs in fresh observations; only complete rows infer absences. */
export function compareMarketObservations(
  observations: readonly MarketCollectionObservation[],
): MarketCollectionPoint[] {
  if (observations.length === 0) return [];
  const scope = observations[0]!;
  if (
    observations.some(
      (entry) =>
        entry.targetId !== scope.targetId ||
        entry.targetDigest !== scope.targetDigest ||
        entry.dataKind !== scope.dataKind ||
        entry.queryDigest !== scope.queryDigest ||
        entry.league !== scope.league ||
        entry.patch !== scope.patch,
    )
  ) {
    throw new TypeError('Market observations must share one profile scope');
  }

  const ordered = [...observations].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const seen = new Map<string, string>();
  const missingSinceComplete = new Set<string>();
  let hasBaseline = false;
  let previousComplete = new Map<string, string>();

  return ordered.map((observation) => {
    const comparable =
      observation.status === 'succeeded' || observation.status === 'empty';
    const complete = comparable && observation.coverage === 'complete';
    const listings = observation.listings;
    const usable = comparable || listings.length > 0;
    const current = new Map(
      listings.flatMap((listing) =>
        listing.externalId
          ? [
              [
                listing.externalId,
                listing.fingerprint ?? marketDigest(listing),
              ] as const,
            ]
          : [],
      ),
    );
    const capturedAt = observation.capturedAt ?? observation.startedAt;
    const prices = listings
      .flatMap((listing) =>
        listing.price === null ||
        (listing.currency !== undefined && listing.currency !== observation.currency)
          ? []
          : [listing.price],
      )
      .sort((a, b) => a - b);
    const point: MarketCollectionPoint = {
      snapshotId: observation.id,
      queryDigest: observation.queryDigest,
      capturedAt,
      cached: observation.cached,
      count: listings.length,
      median: prices.length === 0 ? null : quantile(prices, 0.5),
      untracked: listings.filter((listing) => !listing.externalId).length,
      newCount: 0,
      persistedCount: 0,
      missingCount: 0,
      restoredCount: 0,
      missing: [],
      restored: [],
      changedCount: 0,
      changed: [],
    };

    // Cached responses do not advance history; partial responses can prove positive identity changes only.
    if (observation.cached || !usable) return point;

    const newIds: string[] = [];
    const persistedIds: string[] = [];
    const changedIds: string[] = [];
    const restoredIds: string[] = [];
    const hadBaseline = hasBaseline;
    for (const [id, digest] of current) {
      const oldDigest = seen.get(id);
      if (oldDigest !== undefined) {
        if (oldDigest === digest) persistedIds.push(id);
        else changedIds.push(id);
      } else if (hadBaseline) newIds.push(id);
      if (missingSinceComplete.delete(id)) restoredIds.push(id);
      seen.set(id, digest);
    }
    const missingIds = complete
      ? [...previousComplete.keys()].filter((id) => !current.has(id))
      : [];
    point.newCount = newIds.length;
    point.persistedCount = persistedIds.length;
    point.changed = changedIds.slice(0, 50);
    point.changedCount = changedIds.length;
    point.missing = missingIds.slice(0, 50);
    point.missingCount = missingIds.length;
    point.restored = restoredIds.slice(0, 50);
    point.restoredCount = restoredIds.length;
    if (complete) {
      missingIds.forEach((id) => missingSinceComplete.add(id));
      previousComplete = current;
    }
    hasBaseline = true;
    return point;
  });
}

export function marketCollectionScopeKey(
  observation: Pick<
    MarketCollectionObservation,
    | 'targetId'
    | 'targetDigest'
    | 'queryDigest'
    | 'dataKind'
    | 'league'
    | 'patch'
  >,
) {
  return canonicalMarketJson({
    targetId: observation.targetId,
    targetDigest: observation.targetDigest,
    dataKind: observation.dataKind,
    queryDigest: observation.queryDigest,
    league: observation.league,
    patch: observation.patch,
  });
}

function quantile(sorted: number[], fraction: number) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[Math.ceil(position)]!;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}
