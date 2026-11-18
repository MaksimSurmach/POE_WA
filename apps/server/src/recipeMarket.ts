import {
  DomainError,
  aggregateMarketListings,
  scrapedItemDigest,
  scrapedItemSpecFromRecipe,
  scrapedItemTargetSignature,
  type CanonicalCraftSetup,
  type MarketListing,
  type CanonicalJsonObject,
  type LoadedRecipeDefinition,
  type ScrapedItemRole,
  type ScrapedItemSpec,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';
import { z } from 'zod';
import { normalizeTradeCompatibleListing } from './providers/tradeCompatible.js';
import {
  canonicalMarketJson,
  createMarketTarget,
  createImportedMarketSnapshot,
} from './marketResearch.js';
import {
  analyzeListingComparability,
  compareListingItems,
} from './listingComparability.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { tradeStatMappings } from './tradeStatMappings.js';
import {
  marketImportListingSchema,
  marketTargetInputSchema,
} from '@poe-worksmith/contracts';
import {
  derivedRecipeSpecs,
  type RecipeSpecResolver,
} from './scrapedItemConfig.js';

export type RecipeMarketQuery = {
  provider: 'poe-trade';
  query: CanonicalJsonObject;
  schemaVersion: 1;
};

/** The same wire query used by the collector, including state and influence filters. */
export function recipeMarketTradeUrl(query: RecipeMarketQuery) {
  return generateMarketTradeQuery(recipeQueryTarget(query.query.handbookTarget))
    .url;
}
export type RecipeMarketDependency =
  | Readonly<{
      kind: 'base' | 'target';
      /** The search that is fetched, hashed, linked and diagnosed. */
      query: RecipeMarketQuery;
      /**
       * What a listing must satisfy to count for the recipe, present only when
       * the owner changed the search so it no longer is the recipe's own
       * requirement. A collected listing can match the search and still not
       * be the item the recipe crafts or consumes.
       */
      eligibility?: RecipeMarketQuery;
      materialId?: never;
    }>
  | Readonly<{
      kind: 'material';
      materialId: string;
      query: RecipeMarketQuery | null;
      eligibility?: never;
    }>;
export type RecipeMarketDependencies = (input: {
  league: string;
  recipe: LoadedRecipeDefinition;
}) => Promise<readonly RecipeMarketDependency[]>;

export function createRecipeMarketDependencies(options: {
  trade: TradeQueryGenerator;
  /**
   * Decides the base/output requirements. Omitted means the requirements as
   * authored in each recipe; production callers pass the configured resolver.
   */
  specs?: RecipeSpecResolver;
  resolveResource(
    itemId: string,
    gameDataVersion: string,
  ): Promise<string | null>;
}): RecipeMarketDependencies {
  const specs = options.specs ?? derivedRecipeSpecs;
  return async ({ league, recipe }) => {
    const resourceIds = new Set(
      recipe.craft.steps.flatMap((step) =>
        step.materials.map(({ itemId }) => itemId),
      ),
    );
    // One read decides both the search and the eligibility, so an edit between
    // the two cannot make them describe different configurations.
    const configured = await specs(recipe);
    const fixed: RecipeSpecResolver = () => configured;
    const eligibility = async (starting: boolean) => {
      const role = starting ? 'base' : 'output';
      const authored = scrapedItemSpecFromRecipe(recipe, role);
      if (
        scrapedItemDigest(role, authored) ===
        scrapedItemDigest(role, configured[role].spec)
      )
        return {};
      const result = await compileScrapedItemQuery(
        options.trade,
        role,
        authored,
        league,
      );
      if (!result.ok)
        throw new Error(result.diagnostics.map(({ code }) => code).join(','));
      return { eligibility: result.query };
    };
    return [
      {
        kind: 'base',
        query: await generateRecipeMarketQuery(
          options.trade,
          recipe,
          league,
          true,
          fixed,
        ),
        ...(await eligibility(true)),
      },
      ...(await Promise.all(
        [...resourceIds].sort().map(async (materialId) => {
          const exchangeId =
            materialId === 'chaos-orb'
              ? null
              : await options.resolveResource(
                  materialId,
                  recipe.gameDataVersion,
                );
          return {
            kind: 'material' as const,
            materialId,
            query: exchangeId
              ? tradeQuery({
                  exchange: { have: ['chaos'], want: [exchangeId] },
                })
              : null,
          };
        }),
      )),
      {
        kind: 'target',
        query: await generateRecipeMarketQuery(
          options.trade,
          recipe,
          league,
          false,
          fixed,
        ),
        ...(await eligibility(false)),
      },
    ];
  };
}
function tradeQuery(query: Record<string, unknown>): RecipeMarketQuery {
  return {
    provider: 'poe-trade',
    query: z.record(z.string(), z.json()).parse(query),
    schemaVersion: 1,
  };
}

const tradeRangeSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
});
const generatedSearch = z.object({
  query: z.object({
    type: z.string(),
    filters: z
      .object({
        armour_filters: z
          .object({
            filters: z.object({
              es: tradeRangeSchema.optional(),
              base_defence_percentile: tradeRangeSchema.optional(),
            }),
          })
          .optional(),
        socket_filters: z
          .object({
            filters: z.object({
              links: tradeRangeSchema.optional(),
            }),
          })
          .optional(),
        misc_filters: z
          .object({
            filters: z.object({
              quality: tradeRangeSchema.optional(),
            }),
          })
          .optional(),
      })
      .optional(),
    stats: z
      .array(
        z.object({
          type: z.literal('and'),
          filters: z.array(
            z.object({
              id: z.string(),
              value: tradeRangeSchema.optional(),
            }),
          ),
        }),
      )
      .default([]),
  }),
});

export type ScrapedItemDiagnostic = {
  code: string;
  entityId?: string;
  message: string;
};
export type ScrapedItemCompilation =
  | { ok: true; query: RecipeMarketQuery }
  | { ok: false; diagnostics: readonly ScrapedItemDiagnostic[] };

/** The recipe's base or output search, from whatever requirements are effective. */
export async function generateRecipeMarketQuery(
  trade: TradeQueryGenerator,
  recipe: LoadedRecipeDefinition,
  league: string,
  starting = false,
  specs: RecipeSpecResolver = derivedRecipeSpecs,
): Promise<RecipeMarketQuery> {
  const effective = (await specs(recipe))[starting ? 'base' : 'output'];
  const result = await compileScrapedItemQuery(
    trade,
    starting ? 'base' : 'output',
    effective.spec,
    league,
  );
  if (!result.ok)
    throw new Error(result.diagnostics.map(({ code }) => code).join(','));
  return result.query;
}

/**
 * The only compiler for scraped-item searches. Every consumer of a search
 * (collector schedules, publication, the Trade link and test diagnostics) uses
 * its output, so they cannot disagree about what is being matched.
 */
export async function compileScrapedItemQuery(
  trade: TradeQueryGenerator,
  role: ScrapedItemRole,
  spec: ScrapedItemSpec,
  league: string,
): Promise<ScrapedItemCompilation> {
  const starting = role === 'base';
  const equivalent = !starting && spec.marketEquivalent === true;
  const setup: CanonicalCraftSetup = {
    base: spec.item,
    gameDataVersion: spec.gameDataVersion,
    method: { kind: 'currency', currency: 'scraped-item' },
    startingMods: [],
    target: { allOf: spec.conditions, anyOf: [], minimumMatched: null },
  };
  const result = await trade.generate({ league, setup });
  if (!result.ok)
    return {
      ok: false,
      diagnostics: result.diagnostics.map(({ code, entityId, message }) => ({
        code,
        message,
        ...(entityId ? { entityId } : {}),
      })),
    };
  const generated = generatedSearch.parse(result.value.query);
  if (equivalent) {
    const missing = generated.query.stats
      .flatMap((group) => group.filters)
      .map(({ id }) => id.replace(/^(fractured|crafted)\./, 'explicit.'))
      .filter((id) => !tradeStatMappings[id]);
    if (missing.length)
      return {
        ok: false,
        diagnostics: [...new Set(missing)].map((entityId) => ({
          code: 'COLLECTOR_QUERY_UNSUPPORTED',
          entityId,
          message: `The collector has no finished-item stat mapping for ${entityId}.`,
        })),
      };
  }
  const nativeConditions = [
    {
      id: 'armour.es',
      value: generated.query.filters?.armour_filters?.filters.es,
    },
    {
      id: 'socket.links',
      value: generated.query.filters?.socket_filters?.filters.links,
    },
    {
      id: 'misc.quality',
      value: generated.query.filters?.misc_filters?.filters.quality,
    },
    {
      id: 'misc.base_defence_percentile',
      value:
        generated.query.filters?.armour_filters?.filters
          .base_defence_percentile,
    },
  ].filter(({ value }) => value !== undefined);
  const item = spec.item;
  const parsedTarget = marketTargetInputSchema.safeParse({
    name: starting
      ? `base:${item.baseId}`.slice(0, 200)
      : scrapedItemTargetSignature(spec),
    game: 'poe1',
    realm: 'pc',
    league,
    patch: spec.patch,
    slot: starting ? 'starting-base' : 'crafted-item',
    baseTypes: [generated.query.type],
    builds: [],
    requiredMods: [],
    sources: [],
    ...(!equivalent
      ? {
          minItemLevel: item.itemLevel,
          ...(starting ? { maxItemLevel: item.itemLevel } : {}),
          influences: [...item.influences].sort(),
          synthesised: item.state.synthesised,
        }
      : {}),
    corrupted: item.state.corrupted,
    tradeSearch: {
      version: 1,
      ...(spec.marketSearchCategory
        ? { category: spec.marketSearchCategory }
        : {}),
      scope: 'strict',
      status: 'securable',
      currency: 'chaos',
      includeOtherCurrencies: true,
      rarity: item.rarity,
      ...(!equivalent ? { fractured: item.state.fractured } : {}),
      groups: [
        ...generated.query.stats.map((g) => ({
          type: g.type,
          filters: g.filters.map((stat) => {
            const id = equivalent
              ? stat.id.replace(/^(fractured|crafted)\./, 'explicit.')
              : stat.id;
            const positiveFloor =
              /^(explicit|fractured|crafted)\./.test(stat.id) &&
              stat.value?.min !== undefined &&
              stat.value.min >= 0;
            return {
              id,
              ...(!equivalent
                ? result.value.matchRules?.find((rule) => rule.id === stat.id)
                : {}),
              ...(stat.value?.min !== undefined ? { min: stat.value.min } : {}),
              ...(stat.value?.max !== undefined &&
              (!equivalent || !positiveFloor)
                ? { max: stat.value.max }
                : {}),
            };
          }),
        })),
        ...(nativeConditions.length
          ? [
              {
                type: 'and',
                filters: nativeConditions.map(({ id, value }) => ({
                  id,
                  ...value,
                })),
              },
            ]
          : []),
      ],
    },
  });
  if (!parsedTarget.success)
    return {
      ok: false,
      diagnostics: [
        {
          code: 'MARKET_TARGET_INVALID',
          message: parsedTarget.error.issues
            .map(({ path, message }) => `${path.join('.')}: ${message}`)
            .join('; '),
        },
      ],
    };
  const handbookTarget = parsedTarget.data;
  handbookTarget.tradeSearch?.groups.forEach((g) =>
    g.filters.sort((a, b) => a.id.localeCompare(b.id)),
  );
  if (equivalent) {
    try {
      return {
        ok: true,
        query: tradeQuery({
          ...generateMarketTradeQuery(createMarketTarget(handbookTarget))
            .request,
          handbookTarget: canonicalMarketJson(handbookTarget),
        }),
      };
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'MARKET_QUERY_INVALID'
      )
        throw error;
      return {
        ok: false,
        diagnostics: [
          {
            code: 'COLLECTOR_QUERY_UNSUPPORTED',
            message: 'The collector cannot execute this finished-item search.',
          },
        ],
      };
    }
  }
  // Craft odds use the authored item level. Higher levels can add affix tiers;
  // Strict finished searches retain the requested minimum level.
  const query = { ...result.value.query };
  if (starting) {
    const search = z
      .object({
        filters: z
          .object({
            misc_filters: z
              .object({ filters: z.record(z.string(), z.json()) })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(query.query);
    search.filters.misc_filters.filters.ilvl = {
      min: item.itemLevel,
      max: item.itemLevel,
    };
    query.query = search;
  }
  // Persist the same filter IDs that the worker rebuilds from the handbook.
  const wire = z
    .object({
      stats: z
        .array(
          z
            .object({
              filters: z.array(z.object({ id: z.string() }).passthrough()),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .parse(query.query);
  wire.stats?.forEach((group) =>
    group.filters.forEach((f) => {
      f.id = tradeStatMappings[f.id]?.queryId ?? f.id;
    }),
  );
  query.query = wire;
  return {
    ok: true,
    query: tradeQuery({
      ...query,
      handbookTarget: canonicalMarketJson(handbookTarget),
    }),
  };
}

/** Trade's currency ordering cannot prove a converted resale floor from a prefix. */
export function requiresCompleteOutputCoverage(query: CanonicalJsonObject) {
  if (!query.handbookTarget) return false;
  const target = recipeQueryTarget(query.handbookTarget);
  return (
    target.slot === 'crafted-item' &&
    target.tradeSearch?.includeOtherCurrencies === true
  );
}

function analyzeRecipeListings(
  query: CanonicalJsonObject,
  listings: readonly MarketListing[],
  capturedAt: Date,
  now: Date,
  currency: 'chaos' | 'divine',
) {
  const target = recipeQueryTarget(query.handbookTarget);
  // Raw provider observations remain immutable; matching uses the current normalizer.
  const normalizedListings = listings.flatMap((row) => {
    if (!row.item.rawListing) return [row];
    try {
      const normalized = normalizeTradeCompatibleListing(
        row.item.rawListing,
        target,
      );
      return [
        {
          ...row,
          item: {
            ...normalized.item,
            rawListing: row.item.rawListing,
            currency: row.price.currency,
            ...(row.item.exchange ? { exchange: row.item.exchange } : {}),
          },
        },
      ];
    } catch {
      return [];
    }
  });
  const imported = createImportedMarketSnapshot(
    {
      targetId: target.id,
      capturedAt: capturedAt.toISOString(),
      sourceUrl: 'https://www.pathofexile.com/trade',
      currency,
      dataKind: 'observed',
      emptyResult: normalizedListings.length === 0,
      listings: normalizedListings
        .filter(
          (row) =>
            typeof row.item.league !== 'string' ||
            row.item.league === target.league,
        )
        .map((row) => ({
          externalId: row.id,
          price: Number(row.price.amount),
          currency: row.price.currency,
          item: row.item,
        })),
    },
    target,
    now,
  );
  return {
    normalizedListings,
    rows: analyzeListingComparability(target, imported, now.getTime()).rows,
  };
}

export function matchingRecipeListings(
  query: CanonicalJsonObject,
  listings: readonly MarketListing[],
  capturedAt: Date,
  now: Date,
  currency: 'chaos' | 'divine' = 'chaos',
) {
  if (!query.handbookTarget) return [...listings];
  const { normalizedListings, rows } = analyzeRecipeListings(
    query,
    listings,
    capturedAt,
    now,
    currency,
  );
  const matches = new Set(
    rows.filter((row) => row.status === 'MATCH').map((row) => row.externalId),
  );
  return normalizedListings.filter((row) => matches.has(row.id));
}

/** Unknown or unreadable evidence cannot clear an unconverted asking price. */
export function rejectsRecipeListing(
  query: CanonicalJsonObject,
  row: MarketListing,
) {
  const target = recipeQueryTarget(query.handbookTarget);
  let candidate;
  try {
    const item = row.item.rawListing
      ? normalizeTradeCompatibleListing(row.item.rawListing, target).item
      : row.item;
    candidate = marketImportListingSchema.safeParse({
      externalId: row.id,
      price: Number(row.price.amount),
      currency: row.price.currency,
      item: { ...item, currency: row.price.currency },
    });
  } catch {
    return false;
  }
  if (!candidate.success) return false;
  return (
    compareListingItems(target, {
      currency: row.price.currency,
      listings: [candidate.data],
    })[0]?.status === 'REJECT'
  );
}

/**
 * Why stored listings did or did not match a search, using the exact matcher
 * that prices recipes. Matching is not a statement about collection quality.
 */
export function diagnoseRecipeListings(
  query: CanonicalJsonObject,
  listings: readonly MarketListing[],
  capturedAt: Date,
  now: Date,
  currency: 'chaos' | 'divine' = 'chaos',
) {
  const { normalizedListings, rows } = analyzeRecipeListings(
    query,
    listings,
    capturedAt,
    now,
    currency,
  );
  const matched = rows.filter((row) => row.status === 'MATCH');
  const comparable = aggregateMarketListings({
    currency,
    listings: normalizedListings.filter((row) =>
      matched.some((match) => match.externalId === row.id),
    ),
  }).listings;
  const reasons = new Map<
    string,
    { status: 'rejected' | 'unknown'; count: number }
  >();
  for (const row of rows) {
    if (row.status === 'MATCH') continue;
    const status = row.status === 'REJECT' ? 'rejected' : 'unknown';
    for (const reason of row.reasons) {
      const key = `${status}:${reason}`;
      const found = reasons.get(key);
      if (found) found.count++;
      else reasons.set(key, { status, count: 1 });
    }
  }
  return {
    received: listings.length,
    analyzed: rows.length,
    unreadable: listings.length - normalizedListings.length,
    completeItems: normalizedListings.filter(
      (row) => row.item.modsComplete === true,
    ).length,
    matched: matched.length,
    comparable: comparable.length,
    rejected: rows.filter((row) => row.status === 'REJECT').length,
    unknown: rows.filter((row) => row.status === 'PARTIAL').length,
    reasons: [...reasons]
      .map(([key, value]) => ({
        reason: key.slice(key.indexOf(':') + 1),
        ...value,
      }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export function comparableRecipeListings(
  query: CanonicalJsonObject,
  listings: readonly MarketListing[],
  capturedAt: Date,
  now: Date,
  currency: 'chaos' | 'divine' = 'chaos',
) {
  if (!query.handbookTarget) return [...listings];
  return [
    ...aggregateMarketListings({
      currency,
      listings: matchingRecipeListings(
        query,
        listings,
        capturedAt,
        now,
        currency,
      ),
    }).listings,
  ];
}

// Keep explicit empty constraints inside the generic query canonicalizer, which drops empty query containers.
export function recipeQueryTarget(value: unknown) {
  return createMarketTarget(JSON.parse(z.string().parse(value)));
}
