import type { MarketTarget } from '@poe-worksmith/contracts';
import { DomainError } from '@poe-worksmith/domain';
import { marketDigest } from './marketResearch.js';
import { tradeMappingVersion, tradeStatMappings } from './tradeStatMappings.js';

/** Unsupported/free-text requirements fail before any HTTP request. */
export function generateMarketTradeQuery(
  target: MarketTarget,
  scope = target.tradeSearch?.scope ?? 'strict',
) {
  const search = target.tradeSearch;
  if (!search || target.baseTypes.length !== 1)
    throw new DomainError('MARKET_QUERY_INVALID');
  for (const group of search.groups)
    for (const rule of group.filters)
      if (!tradeStatMappings[rule.id])
        throw new DomainError('MARKET_QUERY_INVALID');
  const rules = target.beltRules;
  // Strict queries must cover every executable belt rule; tiers are verified locally.
  if (rules && search.rarity !== 'rare')
    throw new DomainError('MARKET_QUERY_INVALID');
  const configured = search.groups.flatMap((group) => group.filters);
  if (
    rules &&
    !rules.mods.every((rule) =>
      configured.some(
        (stat) =>
          (stat.key ?? tradeStatMappings[stat.id]?.key) === rule.id &&
          stat.min !== undefined &&
          stat.min >= rule.minValue &&
          (rule.maxTier === undefined ||
            (stat.maxTier !== undefined && stat.maxTier <= rule.maxTier)),
      ),
    )
  )
    throw new DomainError('MARKET_QUERY_INVALID');
  const influences = rules?.influences ?? target.influences;
  if (
    influences?.some(
      (value) =>
        ![
          'shaper',
          'elder',
          'crusader',
          'redeemer',
          'hunter',
          'warlord',
        ].includes(value.toLowerCase()),
    )
  )
    throw new DomainError('MARKET_QUERY_INVALID');
  const misc: Record<string, { min?: number; option?: string }> = {};
  const level = Math.max(target.minItemLevel ?? 0, rules?.minItemLevel ?? 0);
  if (level) misc.ilvl = { min: level };
  if (target.qualityMin != null) misc.quality = { min: target.qualityMin };
  const corrupted = rules?.corrupted ?? target.corrupted;
  if (corrupted != null) misc.corrupted = { option: String(corrupted) };
  if (search.fractured !== undefined)
    misc.fractured_item = { option: String(search.fractured) };
  const stats: Array<{
    type: string;
    value?: { min?: number };
    filters: Array<{ id: string; value?: { min?: number; max?: number } }>;
  }> = search.groups.map((group) => ({
    type: group.type,
    ...(group.type === 'count' && group.min !== undefined
      ? { value: { min: group.min } }
      : {}),
    filters: group.filters.map((stat) => ({
      id: stat.id,
      value: {
        ...(stat.min !== undefined
          ? { min: scope === 'broad' ? stat.min * 0.8 : stat.min }
          : {}),
        ...(stat.max !== undefined
          ? { max: scope === 'broad' ? stat.max * 1.2 : stat.max }
          : {}),
      },
    })),
  }));
  // Influence filters use Trade's pseudo flags; stat IDs are sourced with the other mappings.
  if (influences !== undefined && influences !== null) {
    for (const name of [
      'shaper',
      'elder',
      'crusader',
      'redeemer',
      'hunter',
      'warlord',
    ])
      stats.push({
        type: influences.some((value) => value.toLowerCase() === name)
          ? 'and'
          : 'not',
        filters: [{ id: `pseudo.pseudo_has_${name}_influence` }],
      });
  }
  const request = {
    query: {
      status: { option: search.status },
      type: target.baseTypes[0],
      stats,
      filters: {
        type_filters: { filters: { rarity: { option: search.rarity } } },
        misc_filters: { filters: misc },
        trade_filters: { filters: { price: { option: search.currency } } },
      },
    },
    sort: { price: 'asc' },
  };
  const version = `market-trade-v1:${tradeMappingVersion}`;
  return {
    version,
    scope,
    request,
    hash: marketDigest({
      version,
      game: target.game,
      league: target.league,
      patch: target.patch,
      scope,
      request,
    }),
    // The website accepts the encoded query directly; no search request is needed to inspect it.
    url: `https://www.pathofexile.com/trade/search/${encodeURIComponent(target.league)}?q=${encodeURIComponent(JSON.stringify(request))}`,
  };
}
