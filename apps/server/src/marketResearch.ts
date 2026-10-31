import { createHash, randomUUID } from 'node:crypto';

import {
  marketResearchSnapshotSummarySchema,
  marketSnapshotImportSchema,
  marketTargetInputSchema,
  type MarketResearchSnapshot,
  type MarketResearchSnapshotSummary,
  type MarketSourceCapability,
  type MarketTarget,
  type BeltPriceUpdate,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';

export const MARKET_IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

export interface MarketResearchRepository {
  listTargets(): Promise<MarketTarget[]>;
  findTarget(id: string): Promise<MarketTarget | null>;
  saveTarget(target: MarketTarget): Promise<MarketTarget>;
  listSnapshots(): Promise<MarketResearchSnapshotSummary[]>;
  findSnapshot(id: string): Promise<MarketResearchSnapshot | null>;
  saveSnapshot(
    snapshot: MarketResearchSnapshot,
  ): Promise<MarketResearchSnapshot>;
  listPriceUpdates?(targetId: string): Promise<BeltPriceUpdate[]>;
  savePriceUpdate?(update: BeltPriceUpdate): Promise<BeltPriceUpdate>;
}

export const marketSourceCapabilities: MarketSourceCapability[] = [
  {
    id: 'manual_import',
    name: 'Imported observations',
    status: 'available',
    description:
      'Store user-selected comparable listings and their original item JSON. Prices are asking prices; the importer is responsible for source permission and comparability.',
    documentationUrl: 'https://www.pathofexile.com/developer/docs',
  },
  {
    id: 'poe_ninja_economy',
    name: 'poe.ninja economy',
    status: 'planned',
    description:
      'Configured public economy overviews for supported materials and bases. Aggregate base prices do not price arbitrary rare items.',
    documentationUrl: 'https://poe.ninja/docs/api',
  },
  {
    id: 'ggg_currency_exchange',
    name: 'GGG Currency Exchange',
    status: 'planned',
    description:
      'Public hourly historical currency exchange data. No OAuth key is required. Connector integration is pending.',
    documentationUrl: 'https://www.pathofexile.com/developer/docs/reference',
  },
  {
    id: 'ggg_public_stash',
    name: 'GGG Public Stash',
    status: 'requires_approval',
    description:
      'Requires an existing approved confidential OAuth client with service:psapi. New application registration is currently paused. Not connected.',
    documentationUrl: 'https://www.pathofexile.com/developer/docs',
  },
  {
    id: 'poe_trade',
    name: 'PoE Trade',
    status: 'manual_only',
    description:
      'Open saved searches yourself and import observations. The workbench does not call undocumented Trade endpoints or collect account passwords or browser cookies.',
    documentationUrl: 'https://www.pathofexile.com/developer/docs',
  },
  {
    id: 'poe_ninja_builds',
    name: 'poe.ninja builds API',
    status: 'unsupported',
    description:
      'The builds and profiles APIs are not available for third-party use. Curate build requirements from sources you can use instead.',
    documentationUrl: 'https://poe.ninja/docs/api',
  },
];

/** Deterministic JSON with sorted object keys; arrays retain their meaning/order. */
export function canonicalMarketJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Expected a JSON value');
    return serialized;
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalMarketJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalMarketJson(record[key])}`)
    .join(',')}}`;
}

export function marketDigest(value: unknown): string {
  return createHash('sha256').update(canonicalMarketJson(value)).digest('hex');
}

export function createMarketTarget(
  input: unknown,
  now = new Date(),
): MarketTarget {
  const result = marketTargetInputSchema.safeParse(input);
  if (!result.success)
    throw new DomainError('MARKET_TARGET_INVALID', { cause: result.error });
  return {
    ...result.data,
    id: randomUUID(),
    version: 1,
    digest: marketDigest({ version: 1, profile: result.data }),
    createdAt: now.toISOString(),
  };
}

export function createImportedMarketSnapshot(
  input: unknown,
  target: MarketTarget,
  now = new Date(),
): MarketResearchSnapshot {
  const result = marketSnapshotImportSchema.safeParse(input);
  if (!result.success)
    throw new DomainError('MARKET_IMPORT_INVALID', { cause: result.error });
  const parsed = result.data;
  if (
    parsed.targetId !== target.id ||
    Date.parse(parsed.capturedAt) > now.getTime() + 5 * 60_000
  ) {
    throw new DomainError('MARKET_IMPORT_INVALID');
  }
  // A payload carrying an explicit different league is never a comparable for this target.
  if (
    parsed.listings.some(
      ({ item }) =>
        typeof item.league === 'string' && item.league !== target.league,
    )
  ) {
    throw new DomainError('MARKET_IMPORT_INVALID');
  }
  const prices = parsed.listings
    .flatMap((listing) =>
      listing.price === null ||
      (listing.currency !== undefined && listing.currency !== parsed.currency)
        ? []
        : [listing.price],
    )
    .sort((a, b) => a - b);
  const capturedAt = new Date(parsed.capturedAt).toISOString();
  const digest = marketDigest({
    schemaVersion: 1,
    ...parsed,
    capturedAt,
    emptyResult: parsed.listings.length === 0,
    targetDigest: target.digest,
    // Row order is not an economic observation. Importing the same rows in a different order is idempotent.
    listings: [...parsed.listings].sort((a, b) => {
      const left = canonicalMarketJson(a);
      const right = canonicalMarketJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  });
  return {
    id: randomUUID(),
    targetId: target.id,
    targetVersion: target.version,
    targetDigest: target.digest,
    digest,
    game: target.game,
    realm: target.realm,
    league: target.league,
    patch: target.patch,
    capturedAt,
    retrievedAt: now.toISOString(),
    sourceUrl: parsed.sourceUrl,
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
    provenance: 'manual_import',
    comparability: 'user_selected',
    currency: parsed.currency,
    dataKind: parsed.dataKind,
    outcome: parsed.listings.length === 0 ? 'no_listings' : 'observed',
    count: prices.length,
    rejectedCount: 0,
    p25: quantile(prices, 0.25),
    median: quantile(prices, 0.5),
    p75: quantile(prices, 0.75),
    listings: parsed.listings,
  };
}

function quantile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[Math.ceil(position)]!;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function summarizeMarketSnapshot(
  snapshot: MarketResearchSnapshot,
): MarketResearchSnapshotSummary {
  return marketResearchSnapshotSummarySchema.parse(
    Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== 'listings'),
    ),
  );
}
