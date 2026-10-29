import { z } from 'zod';
import type {
  MarketResearchSnapshot,
  MarketTarget,
} from '@poe-worksmith/contracts';

// This schema is deliberately separate from raw item JSON. Missing evidence is not a match.
const evidence = z
  .object({
    baseType: z.string().optional(),
    rarity: z.string().optional(),
    league: z.string().optional(),
    patch: z.string().optional(),
    quality: z.number().int().optional(),
    modsComplete: z.boolean().optional(),
    currency: z.string().optional(),
    itemLevel: z.number().int().optional(),
    corrupted: z.boolean().optional(),
    influences: z.array(z.string()).optional(),
    seller: z.string().trim().min(1).optional(),
    status: z.enum(['listed', 'delisted', 'unknown']).optional(),
    mods: z
      .array(
        z.object({
          id: z.string(),
          value: z.number().finite().optional(),
          tier: z.number().int().positive().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

/** Version 1 is an explicit interpretation of immutable imported data. */
export function analyzeBeltSnapshot(
  target: MarketTarget,
  snapshot: MarketResearchSnapshot,
  now = Date.now(),
) {
  const rows = snapshot.listings.map((listing, index) => {
    const parsed = evidence.safeParse(listing.item);
    const item = parsed.success ? parsed.data : {};
    const rejected: string[] = [];
    const unknown: string[] = [];
    const check = (name: string, value: unknown, matches: boolean) => {
      if (value === undefined) unknown.push(`${name}: unknown`);
      else if (!matches) rejected.push(`${name}: mismatch`);
    };
    const rules = target.beltRules;
    if (!rules || target.slot.toLowerCase() !== 'belt')
      unknown.push('versioned belt rules unavailable');
    check(
      'base',
      item.baseType,
      item.baseType !== undefined && target.baseTypes.includes(item.baseType),
    );
    check('rarity', item.rarity, item.rarity === 'rare');
    check('league', item.league, item.league === target.league);
    check('patch', item.patch, item.patch === target.patch);
    check('currency', item.currency, item.currency === snapshot.currency);
    if (target.qualityMin != null)
      check(
        'quality',
        item.quality,
        item.quality !== undefined && item.quality >= target.qualityMin,
      );
    check(
      'listing status',
      item.status === 'unknown' ? undefined : item.status,
      item.status === 'listed',
    );
    if (!item.seller) unknown.push('seller: unknown');
    if (target.minItemLevel != null)
      check(
        'target item level',
        item.itemLevel,
        item.itemLevel !== undefined && item.itemLevel >= target.minItemLevel,
      );
    if (target.corrupted != null)
      check(
        'target corruption',
        item.corrupted,
        item.corrupted === target.corrupted,
      );
    if (target.influences && target.influences.length > 0)
      check(
        'target influences',
        item.influences,
        item.influences !== undefined &&
          target.influences.every((influence) =>
            item.influences?.includes(influence),
          ),
      );
    if (rules) {
      check(
        'item level',
        item.itemLevel,
        item.itemLevel !== undefined && item.itemLevel >= rules.minItemLevel,
      );
      check('corruption', item.corrupted, item.corrupted === rules.corrupted);
      check(
        'influences',
        item.influences,
        item.influences !== undefined &&
          [...item.influences].sort().join('|') ===
            [...rules.influences].sort().join('|'),
      );
      for (const mod of rules.mods) {
        if (!item.mods) {
          unknown.push(`${mod.id}: mods unknown`);
          continue;
        }
        const found = item.mods.filter((entry) => entry.id === mod.id);
        if (found.length === 0) {
          if (item.modsComplete === true) rejected.push(`${mod.id}: missing`);
          else unknown.push(`${mod.id}: mod list completeness unknown`);
          continue;
        }
        if (found.length !== 1) {
          unknown.push(`${mod.id}: ambiguous`);
          continue;
        }
        const entry = found[0];
        if (!entry || entry.value === undefined)
          unknown.push(`${mod.id}: value unknown`);
        else if (entry.value < mod.minValue)
          rejected.push(`${mod.id}: below threshold`);
        if (mod.maxTier !== undefined) {
          if (entry?.tier === undefined)
            unknown.push(`${mod.id}: tier unknown`);
          else if (entry.tier > mod.maxTier)
            rejected.push(`${mod.id}: tier mismatch`);
        }
      }
    }
    return {
      index,
      externalId: listing.externalId ?? null,
      price: listing.price,
      seller: item.seller ?? null,
      status: rejected.length
        ? ('REJECT' as const)
        : unknown.length
          ? ('PARTIAL' as const)
          : ('MATCH' as const),
      reasons: [...rejected, ...unknown],
    };
  });
  const sellers = new Map<string, number>();
  for (const row of rows)
    if (row.status === 'MATCH' && row.seller)
      sellers.set(
        row.seller.toLowerCase(),
        Math.min(row.price, sellers.get(row.seller.toLowerCase()) ?? Infinity),
      );
  const prices = [...sellers.values()].sort((a, b) => a - b);
  const fresh =
    now >= Date.parse(snapshot.capturedAt) &&
    now - Date.parse(snapshot.capturedAt) <= 24 * 60 * 60 * 1000;
  return {
    algorithm: 'belt-comparability-v1',
    targetDigest: target.digest,
    snapshotId: snapshot.id,
    dataKind: snapshot.dataKind,
    capturedAt: snapshot.capturedAt,
    currency: snapshot.currency,
    status: 'INSUFFICIENT_DATA' as const,
    reasons: [
      'Craft method, probability, and dated material prices are not validated.',
      ...(!fresh ? ['Observation is stale or dated in the future.'] : []),
      ...(prices.length < 5 ? ['Fewer than five independent sellers.'] : []),
    ],
    selectionBias: 'Manually selected asking prices; delisting is not a sale.',
    independentSellers: prices.length,
    confirmedListings: rows.filter((row) => row.status === 'MATCH').length,
    conservativeAskingPrice:
      fresh && prices.length >= 5
        ? prices[Math.floor((prices.length - 1) * 0.25)]
        : null,
    rows,
  };
}
