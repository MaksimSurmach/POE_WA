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
};
export interface MarketEconomyRepository {
  assertReady(): Promise<void>;
  list(): Promise<MarketEconomySummary[]>;
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
