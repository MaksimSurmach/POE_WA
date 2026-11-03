import { randomUUID } from 'node:crypto';
import {
  marketEconomySummarySchema,
  marketEconomyDetailSchema,
  marketEconomyAttemptSchema,
  type MarketEconomyAttempt,
  type MarketEconomyCategory,
  type MarketEconomySummary,
} from '@poe-worksmith/contracts';
import type {
  NinjaEconomyClient,
  NinjaEconomySnapshot,
} from './providers/ninjaEconomy.js';

export type StoredMarketEconomySnapshot = NinjaEconomySnapshot & {
  readonly id: string;
  readonly verifiedAt?: string;
};
export interface MarketEconomyRepository {
  assertReady(): Promise<void>;
  list(): Promise<MarketEconomySummary[]>;
  latest(
    league: string,
    category: MarketEconomyCategory,
  ): Promise<MarketEconomySummary | null>;
  save(
    snapshot: StoredMarketEconomySnapshot,
  ): Promise<StoredMarketEconomySnapshot>;
  find(id: string): Promise<StoredMarketEconomySnapshot | null>;
  listAttempts(): Promise<MarketEconomyAttempt[]>;
  saveAttempt(attempt: MarketEconomyAttempt): Promise<void>;
  cleanup?(input: {
    payloadBefore: Date;
    snapshotsBefore: Date;
  }): Promise<void>;
}
export type MarketEconomyOptions = {
  client?:
    Pick<NinjaEconomyClient, 'discoverLeagues' | 'fetchSnapshot'> | undefined;
  repository?: MarketEconomyRepository | undefined;
  rawRetentionDays?: number;
  summaryRetentionDays?: number;
  readRetention?: () => Promise<{
    rawRetentionHours: number;
    historyRetentionDays: number;
  }>;
};
export function newStoredEconomySnapshot(
  snapshot: NinjaEconomySnapshot,
): StoredMarketEconomySnapshot {
  return { ...snapshot, id: randomUUID() };
}
export function newEconomyAttempt(input: {
  league: string;
  category: MarketEconomyCategory;
  startedAt?: Date;
}): MarketEconomyAttempt {
  return marketEconomyAttemptSchema.parse({
    id: randomUUID(),
    league: input.league,
    category: input.category,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    completedAt: null,
    status: 'running',
    cacheStatus: null,
    errorCode: null,
    snapshotId: null,
  });
}
export function summarizeEconomy(
  snapshot: StoredMarketEconomySnapshot,
): MarketEconomySummary {
  return marketEconomySummarySchema.parse({
    id: snapshot.id,
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    game: snapshot.game,
    league: snapshot.league,
    category: snapshot.category,
    endpoint: snapshot.endpoint,
    payloadHash: snapshot.payloadHash,
    capturedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    priceBasis: snapshot.priceBasis,
    lineCount: snapshot.lines.length,
    payloadAvailable: true,
  });
}
export function previewEconomy(snapshot: StoredMarketEconomySnapshot) {
  return marketEconomyDetailSchema.parse({
    ...summarizeEconomy(snapshot),
    lines: snapshot.lines.slice(0, 200),
    truncated: snapshot.lines.length > 200,
  });
}

/** The handbook uses the same client cache, attempt history and stored economy snapshots as the market API. */
export async function collectRecipeMaterialPrices(
  league: string,
  client: NinjaEconomyClient,
  repository: MarketEconomyRepository,
  signal?: AbortSignal,
  onProgress?: (report: Record<string, unknown>) => Promise<void>,
) {
  const report = {
    total: 4,
    succeeded: 0,
    failed: 0,
    sourceFreshness: null as string | null,
    cooldownUntil: null as string | null,
    errorCode: null as string | null,
  };
  await onProgress?.(report);
  for (const category of [
    'Currency',
    'Essence',
    'Fossil',
    'Resonator',
  ] as const) {
    signal?.throwIfAborted();
    const attempt = newEconomyAttempt({ league, category });
    await repository.saveAttempt(attempt);
    try {
      const result = await client.fetchSnapshot({ league, category });
      if (!result.archiveAllowed) throw new Error('ECONOMY_ARCHIVE_DISALLOWED');
      const snapshot = await repository.save(
        newStoredEconomySnapshot(result.snapshot),
      );
      await repository.saveAttempt({
        ...attempt,
        completedAt: new Date().toISOString(),
        status: 'succeeded',
        cacheStatus: result.cacheStatus,
        snapshotId: snapshot.id,
      });
      report.succeeded++;
      report.sourceFreshness = result.checkedAt;
    } catch (error) {
      await repository.saveAttempt({
        ...attempt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        errorCode:
          error instanceof Error && 'code' in error
            ? String(error.code)
            : 'ECONOMY_UNAVAILABLE',
      });
      report.failed++;
      report.errorCode =
        error instanceof Error && 'code' in error
          ? String(error.code)
          : 'ECONOMY_UNAVAILABLE';
      if (
        error instanceof Error &&
        'retryAt' in error &&
        typeof error.retryAt === 'string'
      )
        report.cooldownUntil = error.retryAt;
    }
    await onProgress?.(report);
  }
  return report;
}
