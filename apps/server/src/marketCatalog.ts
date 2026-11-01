import { z } from 'zod';
import {
  marketTargetInputSchema,
  type MarketTarget,
} from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import {
  createMarketTarget,
  type MarketResearchRepository,
} from './marketResearch.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';

export const marketCatalogImportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z
    .array(marketTargetInputSchema.required({ catalog: true }))
    .min(1)
    .max(200),
});

function catalogScope(target: MarketTarget) {
  return JSON.stringify([
    target.game,
    target.realm,
    target.league,
    target.patch,
    target.catalog?.key ?? target.id,
  ]);
}

/** Old revisions remain addressable and keep their snapshots; ranking selects the newest revision. */
export function activeCatalogTargets(targets: MarketTarget[]) {
  const latest = new Map<string, MarketTarget>();
  for (const target of targets) {
    const key = catalogScope(target);
    const previous = latest.get(key);
    if (
      !previous ||
      (target.catalog?.revision ?? 1) > (previous.catalog?.revision ?? 1)
    )
      latest.set(key, target);
  }
  return [...latest.values()];
}

export async function importMarketCatalog(
  input: unknown,
  repository: Pick<MarketResearchRepository, 'listTargets' | 'saveTarget'>,
  dryRun = false,
) {
  const parsed = marketCatalogImportSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('MARKET_TARGET_INVALID');
  const targets = parsed.data.profiles.map((profile) =>
    createMarketTarget(profile),
  );
  const existing = await repository.listTargets();
  const revisions = new Map<string, string>();
  // Validate the entire file before writing any profile.
  for (const target of [...existing, ...targets]) {
    if (!target.catalog) continue;
    const key = `${catalogScope(target)}:${target.catalog.revision}`;
    const digest = revisions.get(key);
    if (digest && digest !== target.digest)
      throw new DomainError('MARKET_TARGET_INVALID');
    revisions.set(key, target.digest);
  }
  for (const target of targets)
    if (target.tradeSearch) generateMarketTradeQuery(target);
  const unique = [
    ...new Map(targets.map((target) => [target.digest, target])).values(),
  ];
  const created = unique.filter(
    (target) => !existing.some((old) => old.digest === target.digest),
  ).length;
  const stored: MarketTarget[] = [];
  for (const target of unique)
    stored.push(
      dryRun
        ? (existing.find((old) => old.digest === target.digest) ?? target)
        : await repository.saveTarget(target),
    );
  return {
    dryRun,
    created,
    unchanged: unique.length - created,
    targets: stored,
  };
}
