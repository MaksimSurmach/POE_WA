import type {
  ScrapedCaptureDiagnostics,
  ScrapedCaptureFacts,
  ScrapedItem,
  ScrapedItemDiagnostic,
  ScrapedItemModifiersResponse,
  ScrapedItemTest,
  ScrapedNameSource,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  RegisteredTradeQueryGenerator,
  clusterJewelVariantFilter,
  hashMarketQuery,
  mappedTargetFilter,
  noVariantFilter,
  scrapedItemDigest,
  scrapedItemEditIssues,
  scrapedItemIdentityChanged,
  scrapedItemSpecSchema,
  scrapedItemSpecFromRecipe,
  validateRecipeDocument,
  type CanonicalJsonObject,
  type CanonicalRecipe,
  type MarketListing,
  type ScrapedItemRole,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';
import { convertChaosDivineQuote } from '@poe-worksmith/domain/economics';
import type { Pool } from 'pg';
import { z } from 'zod';

import { storedListingQuote } from './collectorResults.js';
import {
  compileScrapedItemQuery,
  recipeQueryTarget,
  recipeMarketTradeUrl,
  diagnoseRecipeListings,
  type RecipeMarketQuery,
  type ScrapedItemCompilation,
} from './recipeMarket.js';
import type { ItemPresentationCatalog } from './itemPresentation.js';
import { createPostgresRepositories } from './repositories/index.js';
import {
  enqueueScrapedItemTest,
  linkRecipeToScrapedItem,
  readScrapedItem,
  readScrapedItemLinks,
  readScrapedItems,
  seedScrapedItems,
  unlinkRecipeFromScrapedItem,
  updateScrapedItemSpec,
  type ScrapedItemRecord,
  type ScrapedItemWrite,
} from './repositories/scrapedItemRepository.js';
import { classifyScrapedItemTest } from './scrapedItemTest.js';
import { loadTradeMappingCatalog } from './tradeMappings.js';
import { tradeStatMappings } from './tradeStatMappings.js';

/** Fixable field problems, in the shape the editor shows next to each field. */
export function zodDiagnostics(error: z.ZodError): ScrapedItemDiagnostic[] {
  return error.issues.map((issue) => ({
    code: 'REQUIREMENT_INVALID',
    message: issue.message,
    path: issue.path.join('.') || 'body',
  }));
}

/** The request is understood but cannot be saved or run; carries what to fix. */
export class ScrapedItemRejected extends Error {
  constructor(readonly diagnostics: readonly ScrapedItemDiagnostic[]) {
    super(diagnostics.map(({ code }) => code).join(','));
    this.name = 'ScrapedItemRejected';
  }
}

export type ScrapedItemServiceOptions = {
  pool: Pool;
  /** Applies saved configuration to the collector's trade schedules. */
  applySchedules: () => Promise<'synchronized' | 'deferred'>;
  readCollectionsPaused: () => Promise<boolean>;
  /** Descriptive names for ids whose canonical entity has no name. */
  presentation?: ItemPresentationCatalog;
  now?: () => Date;
};

type ActiveRecipe = {
  id: string;
  title: string;
  definition: CanonicalRecipe;
};
type ItemCompilation = ScrapedItemCompilation & { key: string | null };

const maximumModifierResults = 25;
/**
 * The authoritative identity registry: every canonical entity plus every active
 * Trade mapping of the active game data. Real game data can map a modifier
 * without carrying descriptive metadata for it, and such a modifier is still a
 * valid, editable identity.
 */
const identityRegistrySql = `with registry as (
  select gdv.patch_version as patch, ce.entity_kind as kind, ce.canonical_id as id,
    ce.payload->>'name' as name, ce.payload->>'generationType' as "generationType",
    ce.payload->>'familyId' as "familyId", (ce.payload->>'requiredLevel')::int as "requiredLevel",
    false as mapped, null::text as "externalId"
  from canonical_entities ce join game_data_versions gdv on gdv.id = ce.game_data_version_id
  where gdv.status = 'active' and gdv.game = 'poe1' and ce.entity_kind in ('mod', 'modFamily')
  union all
  select gdv.patch_version, pm.entity_kind, pm.canonical_id, null, null, null, null, true, pm.external_id
  from provider_mappings pm join game_data_versions gdv on gdv.id = pm.game_data_version_id
  where gdv.status = 'active' and gdv.game = 'poe1' and pm.provider = 'poe-trade'
    and pm.status = 'active' and pm.entity_kind in ('mod', 'modFamily')
)`;
const scheduleQueryPayload = z.object({
  query: z.object({ handbookTarget: z.string() }).passthrough(),
});

export function createScrapedItemService(options: ScrapedItemServiceOptions) {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const repositories = createPostgresRepositories(pool);

  async function readRecipes() {
    const recipes = new Map<string, ActiveRecipe>();
    for (const recipe of await repositories.recipes.listActive()) {
      try {
        recipes.set(recipe.id, {
          id: recipe.id,
          title: recipe.title,
          definition: validateRecipeDocument(recipe.definition),
        });
      } catch {
        // An unreadable recipe cannot be derived; the collector sync reports it.
      }
    }
    return recipes;
  }

  async function tradeFor(specs: readonly ScrapedItemSpec[]) {
    const mappings = await loadTradeMappingCatalog(pool, [
      ...new Set(specs.map(({ gameDataVersion }) => gameDataVersion)),
    ]);
    return {
      mappings,
      trade: new RegisteredTradeQueryGenerator(
        mappings,
        [noVariantFilter, clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
    };
  }

  async function compile(
    trade: RegisteredTradeQueryGenerator,
    league: { gggId: string } | null,
    item: Pick<ScrapedItemRecord, 'role' | 'spec'>,
  ): Promise<ItemCompilation> {
    if (!league)
      return {
        ok: false,
        key: null,
        diagnostics: [
          {
            code: 'CURRENT_LEAGUE_UNRESOLVED',
            message: 'The current league is not resolved yet.',
          },
        ],
      };
    const result = await compileScrapedItemQuery(
      trade,
      item.role,
      item.spec,
      league.gggId,
    );
    if (!result.ok) return { ...result, key: null };
    const key = await hashMarketQuery({
      ...result.query,
      league: league.gggId,
    });
    try {
      recipeMarketTradeUrl(result.query);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'MARKET_QUERY_INVALID'
      )
        throw error;
      return {
        ok: false,
        key,
        diagnostics: [
          {
            code: 'COLLECTOR_QUERY_UNSUPPORTED',
            message:
              'The collector cannot interpret this search. Check its Trade stat mappings and requirements.',
          },
        ],
      };
    }
    return { ...result, key };
  }

  /**
   * A descriptive name from the best available source. Canonical metadata can
   * be sparse, so this falls back to presentation metadata and then to the
   * provider's own wording; it never derives a name from the id.
   */
  function describe(
    canonical: string | undefined,
    id: string,
    tradeName: string | null = null,
  ): { name: string | null; source: ScrapedNameSource } {
    if (canonical) return { name: canonical, source: 'canonical' };
    const presented = options.presentation?.get(id)?.name;
    if (presented) return { name: presented, source: 'presentation' };
    if (tradeName) return { name: tradeName, source: 'trade' };
    return { name: null, source: 'unavailable' };
  }

  async function readNames(specs: readonly ScrapedItemSpec[]) {
    const names = new Map<string, string>();
    if (!specs.length) return names;
    const { rows } = await pool.query<{
      kind: string;
      id: string;
      name: string | null;
      patch: string;
    }>(
      `select ce.entity_kind as kind, ce.canonical_id as id, ce.payload->>'name' as name, gdv.patch_version as patch
       from canonical_entities ce join game_data_versions gdv on gdv.id = ce.game_data_version_id
       where gdv.status = 'active' and gdv.game = 'poe1' and gdv.patch_version = any($1::text[])
         and ((ce.entity_kind = 'base' and ce.canonical_id = any($2::text[]))
           or (ce.entity_kind = 'mod' and ce.canonical_id = any($3::text[]))
           or (ce.entity_kind = 'modFamily' and ce.canonical_id = any($4::text[])))`,
      [
        [...new Set(specs.map(({ gameDataVersion }) => gameDataVersion))],
        [...new Set(specs.map(({ item }) => item.baseId))],
        [
          ...new Set(
            specs.flatMap(({ conditions }) =>
              conditions.flatMap(({ modId }) => (modId ? [modId] : [])),
            ),
          ),
        ],
        [
          ...new Set(
            specs.flatMap(({ conditions }) =>
              conditions.flatMap(({ modFamilyId }) =>
                modFamilyId ? [modFamilyId] : [],
              ),
            ),
          ),
        ],
      ],
    );
    for (const row of rows)
      if (row.name) names.set(`${row.patch}:${row.kind}:${row.id}`, row.name);
    return names;
  }

  async function readSchedules(leagueId: string, keys: string[]) {
    if (!keys.length) return new Map<string, ScheduleRow>();
    const { rows } = await pool.query<ScheduleRow>(
      `select id, key, enabled, interval_minutes as "intervalMinutes", next_due_at as "nextDueAt",
         last_status as "lastStatus", last_error as "lastError", last_finished_at as "lastFinishedAt"
       from collector_schedule
       where kind = 'trade-target' and league_id = $1 and key = any($2::text[])`,
      [leagueId, keys],
    );
    return new Map(rows.map((row) => [row.key, row]));
  }

  async function readLatestCaptures(schedules: readonly ScheduleRow[]) {
    const facts = new Map<string, ScrapedCaptureFacts>();
    if (!schedules.length) return facts;
    const { rows } = await pool.query<CaptureRow>(
      `select distinct on (c.schedule_id) ${captureColumns}
       from captures c join collector_schedule s on s.id = c.schedule_id
       where c.schedule_id = any($1::uuid[]) and (c.query_version is null or c.query_version = s.key)
       order by c.schedule_id, c.captured_at desc`,
      [schedules.map(({ id }) => id)],
    );
    for (const row of rows) facts.set(row.scheduleId, captureFacts(row));
    return facts;
  }

  async function list() {
    const [league, recipes, paused] = await Promise.all([
      repositories.leagues.findCurrent(),
      readRecipes(),
      options.readCollectionsPaused(),
    ]);
    await seedScrapedItems(pool, [...recipes.values()]);
    const [records, links] = await Promise.all([
      readScrapedItems(pool),
      readScrapedItemLinks(pool),
    ]);
    const linksByItem = new Map<string, typeof links>();
    for (const link of links) {
      if (!recipes.has(link.recipeId)) continue;
      linksByItem.set(link.itemId, [
        ...(linksByItem.get(link.itemId) ?? []),
        link,
      ]);
    }
    // Seeds for recipes that are no longer active are history, not current targets.
    const items = records.filter(
      (item) => item.origin === 'owner' || linksByItem.has(item.id),
    );
    const { trade, mappings } = await tradeFor(items.map(({ spec }) => spec));
    const compiled = new Map<string, ItemCompilation>();
    for (const item of items)
      compiled.set(item.id, await compile(trade, league, item));
    const schedules = league
      ? await readSchedules(
          league.id,
          [...compiled.values()].flatMap(({ key }) => (key ? [key] : [])),
        )
      : new Map<string, ScheduleRow>();
    const [captures, names] = await Promise.all([
      readLatestCaptures([...schedules.values()]),
      readNames(items.map(({ spec }) => spec)),
    ]);
    const byKey = new Map<string, string[]>();
    for (const [id, { key }] of compiled)
      if (key) byKey.set(key, [...(byKey.get(key) ?? []), id]);
    const recipeUse = (itemId: string) =>
      (linksByItem.get(itemId) ?? []).map((link) => ({
        id: link.recipeId,
        role: link.role,
        title: recipes.get(link.recipeId)!.title,
        definitionChanged:
          link.authoredDigest !==
          scrapedItemDigest(
            link.role,
            scrapedItemSpecFromRecipe(
              recipes.get(link.recipeId)!.definition,
              link.role,
            ),
          ),
      }));

    const views: ScrapedItem[] = [];
    for (const item of items) {
      const result = compiled.get(item.id)!;
      const schedule = result.key ? schedules.get(result.key) : undefined;
      const sharing = (result.key ? (byKey.get(result.key) ?? []) : []).filter(
        (id) => id !== item.id,
      );
      const base = describe(
        names.get(`${item.spec.gameDataVersion}:base:${item.spec.item.baseId}`),
        item.spec.item.baseId,
        // The compiled Trade base type is the provider's own name for the base.
        result.ok ? tradeBaseType(result.query) : null,
      );
      views.push({
        baseId: item.spec.item.baseId,
        baseName: base.name,
        baseNameSource: base.source,
        id: item.id,
        latestCapture: schedule ? (captures.get(schedule.id) ?? null) : null,
        modifiers: await Promise.all(
          item.spec.conditions.map(async (condition) => {
            const id = condition.modId ?? condition.modFamilyId!;
            const described = describe(
              names.get(
                `${item.spec.gameDataVersion}:${condition.modId ? 'mod' : 'modFamily'}:${id}`,
              ),
              id,
            );
            const resolved = await mappings.resolveTarget({
              gameDataVersion: item.spec.gameDataVersion,
              target: condition,
            });
            return {
              name: described.name,
              nameSource: described.source,
              tradeMapped: resolved.ok,
              tradeText: resolved.ok
                ? (tradeStatMappings[resolved.value.id]?.text ?? null)
                : null,
            };
          }),
        ),
        origin: item.origin,
        query: {
          diagnostics: result.ok ? [] : [...result.diagnostics],
          key: result.key,
          status: result.ok ? 'ready' : 'blocked',
          tradeUrl:
            result.ok && league ? recipeMarketTradeUrl(result.query) : null,
        },
        recipes: recipeUse(item.id).map(({ id, title, definitionChanged }) => ({
          id,
          title,
          definitionChanged,
        })),
        revision: item.revision,
        role: item.role,
        schedule: schedule
          ? {
              enabled: schedule.enabled,
              intervalMinutes: schedule.intervalMinutes,
              lastError: schedule.lastError,
              lastFinishedAt: schedule.lastFinishedAt?.toISOString() ?? null,
              lastStatus: schedule.lastStatus,
              nextDueAt: schedule.nextDueAt.toISOString(),
            }
          : null,
        sharedQuery: {
          itemIds: sharing,
          recipes: sharing.flatMap((id) =>
            recipeUse(id).map(({ id: recipeId, role, title }) => ({
              id: recipeId,
              role,
              title,
            })),
          ),
        },
        spec: item.spec,
        updatedAt: item.updatedAt.toISOString(),
      });
    }
    const roleItem = (recipeId: string, role: ScrapedItemRole) =>
      links.find((link) => link.recipeId === recipeId && link.role === role)
        ?.itemId ?? null;
    return {
      collectionsPaused: paused,
      generatedAt: now().toISOString(),
      items: views,
      league: league
        ? { gggId: league.gggId, id: league.id, name: league.name }
        : null,
      recipes: [...recipes.values()]
        .map(({ id, title }) => ({
          base: roleItem(id, 'base'),
          id,
          output: roleItem(id, 'output'),
          title,
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  async function view(id: string) {
    const data = await list();
    const item = data.items.find((candidate) => candidate.id === id);
    if (!item) throw new DomainError('PERSISTENCE_NOT_FOUND');
    return item;
  }

  /** Why a configuration cannot be scraped; empty means it can. */
  async function review(
    current: ScrapedItemRecord,
    spec: ScrapedItemSpec,
  ): Promise<ScrapedItemDiagnostic[]> {
    const diagnostics: ScrapedItemDiagnostic[] = [];
    if (scrapedItemIdentityChanged(current.spec, spec))
      diagnostics.push({
        code: 'ITEM_IDENTITY_IMMUTABLE',
        message:
          'The base item, game data version and variant cannot be changed; create the search from a recipe instead.',
        path: 'item.baseId',
      });
    for (const issue of scrapedItemEditIssues(current.role, spec))
      diagnostics.push({ code: 'REQUIREMENT_UNSUPPORTED', ...issue });
    if (diagnostics.length) return diagnostics;
    // A modifier is known when game data names it or the active Trade mapping
    // authoritatively maps it. Game data can carry mappings without metadata.
    const known = await pool.query<{ kind: string; id: string }>(
      `${identityRegistrySql}
       select kind, id from registry
       where patch = $1
         and ((kind = 'mod' and id = any($2::text[])) or (kind = 'modFamily' and id = any($3::text[])))`,
      [
        spec.gameDataVersion,
        spec.conditions.flatMap(({ modId }) => (modId ? [modId] : [])),
        spec.conditions.flatMap(({ modFamilyId }) =>
          modFamilyId ? [modFamilyId] : [],
        ),
      ],
    );
    const exists = new Set(known.rows.map(({ kind, id }) => `${kind}:${id}`));
    spec.conditions.forEach((condition, index) => {
      const kind = condition.modId ? 'mod' : 'modFamily';
      const id = condition.modId ?? condition.modFamilyId!;
      if (!exists.has(`${kind}:${id}`))
        diagnostics.push({
          code: 'MODIFIER_UNKNOWN',
          entityId: id,
          message: `${id} is not a canonical modifier in game data ${spec.gameDataVersion}.`,
          path: `conditions.${index}`,
        });
    });
    if (diagnostics.length) return diagnostics;
    const league = await repositories.leagues.findCurrent();
    const { trade } = await tradeFor([spec]);
    const compiled = await compile(trade, league, { role: current.role, spec });
    return compiled.ok ? [] : [...compiled.diagnostics];
  }

  function checkWrite(write: ScrapedItemWrite) {
    if (write.status === 'not-found')
      throw new DomainError('PERSISTENCE_NOT_FOUND');
    if (write.status === 'conflict')
      throw new DomainError('PERSISTENCE_CONFLICT');
  }

  async function applied(id: string) {
    let schedule: 'synchronized' | 'deferred';
    try {
      schedule = await options.applySchedules();
    } catch {
      // The edit is durable; the collector applies it on its next synchronization.
      schedule = 'deferred';
    }
    return { item: await view(id), schedule };
  }

  async function authoredFor(
    recipeId: string,
    role: ScrapedItemRole,
    item: ScrapedItemRecord,
  ) {
    const recipe = (await readRecipes()).get(recipeId);
    if (!recipe) throw new DomainError('PERSISTENCE_NOT_FOUND');
    const authored = scrapedItemSpecFromRecipe(recipe.definition, role);
    if (scrapedItemIdentityChanged(authored, item.spec))
      throw new ScrapedItemRejected([
        {
          code: 'RECIPE_INCOMPATIBLE',
          message: `${recipe.title} uses a different ${role === 'base' ? 'starting base' : 'output base'} than this item.`,
        },
      ]);
    return scrapedItemDigest(role, authored);
  }

  async function readCaptureDiagnostics(captureId: string) {
    const client = await pool.connect();
    try {
      // Listings are overwritten by later captures; read facts and rows from one snapshot.
      await client.query('begin isolation level repeatable read read only');
      const result = await readCaptureSnapshot(client, captureId);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function readCaptureSnapshot(
    connection: Pick<Pool, 'query'>,
    captureId: string,
  ): Promise<ScrapedCaptureDiagnostics | null> {
    const { rows } = await connection.query<
      CaptureRow & {
        payload: Record<string, unknown>;
        fxChaosPerDivine: string | null;
        latestId: string;
      }
    >(
      `select ${captureColumns}, s.payload, c.fx_chaos_per_divine as "fxChaosPerDivine",
         (select l.id from captures l where l.schedule_id = c.schedule_id order by l.captured_at desc limit 1) as "latestId"
       from captures c join collector_schedule s on s.id = c.schedule_id where c.id = $1`,
      [captureId],
    );
    const capture = rows[0];
    if (!capture) return null;
    const facts = captureFacts(capture);
    const unavailable = (
      reason: 'superseded-by-later-capture' | 'query-unavailable',
    ) => ({
      ...facts,
      listings: null,
      listingsUnavailable: reason,
      reasons: [],
    });
    // Listing rows keep only their latest capture, so older captures cannot be re-analyzed.
    if (capture.latestId !== capture.id)
      return unavailable('superseded-by-later-capture');
    const payload = scheduleQueryPayload.safeParse(capture.payload);
    if (!payload.success) return unavailable('query-unavailable');
    const stored = await connection.query<{
      id: string;
      seller: string | null;
      price: string | null;
      currency: string | null;
      indexedAt: Date | null;
      item: Parameters<typeof storedListingQuote>[0]['item'];
    }>(
      `select item_id as id, seller, price_original as price, currency, indexed_at as "indexedAt", item
       from listings
       where schedule_id = $1 and last_capture_id = $2 and status = 'active'
         and ($3::text[] is null or item_id = any($3::text[]))`,
      [capture.scheduleId, capture.id, capture.sortedSampleIds],
    );
    const rate = capture.fxChaosPerDivine
      ? Number(capture.fxChaosPerDivine)
      : null;
    const listings: MarketListing[] = [];
    for (const row of stored.rows) {
      if (!row.seller || !row.price || !row.currency) continue;
      const quote = storedListingQuote(
        {
          ...row,
          seller: row.seller,
          price: row.price,
          currency: row.currency,
        },
        capture.capturedAt,
      );
      const converted =
        quote.price.currency === 'divine' && rate
          ? convertChaosDivineQuote(quote.price, 'chaos', rate)
          : quote.price;
      listings.push({
        ...quote,
        indexedAt: new Date(quote.indexedAt),
        item: { ...quote.item, currency: converted.currency } as never,
        price: converted as MarketListing['price'],
      });
    }
    const analysis = diagnoseRecipeListings(
      payload.data.query as CanonicalJsonObject,
      listings,
      capture.capturedAt,
      now(),
    );
    return {
      ...facts,
      listings: {
        stored: stored.rows.length,
        priced: listings.length,
        completeItems: analysis.completeItems,
        analyzed: analysis.analyzed,
        excluded: analysis.received - analysis.unreadable - analysis.analyzed,
        unreadable: analysis.unreadable,
        matched: analysis.matched,
        comparable: analysis.comparable,
        rejected: analysis.rejected,
        unknown: analysis.unknown,
      },
      listingsUnavailable: null,
      reasons: analysis.reasons.slice(0, 20),
    };
  }

  return {
    list,

    async save(
      id: string,
      input: { expectedRevision: number; spec: ScrapedItemSpec },
    ) {
      const current = await readScrapedItem(pool, id);
      if (!current) throw new DomainError('PERSISTENCE_NOT_FOUND');
      if (current.revision !== input.expectedRevision)
        throw new DomainError('PERSISTENCE_CONFLICT');
      const parsed = scrapedItemSpecSchema.safeParse(input.spec);
      if (!parsed.success)
        throw new ScrapedItemRejected(zodDiagnostics(parsed.error));
      const diagnostics = await review(current, parsed.data);
      if (diagnostics.length) throw new ScrapedItemRejected(diagnostics);
      checkWrite(
        await updateScrapedItemSpec(pool, {
          expectedRevision: input.expectedRevision,
          id,
          spec: parsed.data,
        }),
      );
      return applied(id);
    },

    async link(
      id: string,
      input: { expectedRevision: number; recipeId: string },
    ) {
      const current = await readScrapedItem(pool, id);
      if (!current) throw new DomainError('PERSISTENCE_NOT_FOUND');
      const authoredDigest = await authoredFor(
        input.recipeId,
        current.role,
        current,
      );
      checkWrite(
        await linkRecipeToScrapedItem(pool, {
          authoredDigest,
          expectedRevision: input.expectedRevision,
          itemId: id,
          recipeId: input.recipeId,
        }),
      );
      return applied(id);
    },

    async unlink(
      id: string,
      input: { expectedRevision: number; recipeId: string },
    ) {
      const result = await unlinkRecipeFromScrapedItem(pool, {
        expectedRevision: input.expectedRevision,
        itemId: id,
        recipeId: input.recipeId,
      });
      if (result.status === 'sole-recipe' || result.status === 'not-linked')
        throw new ScrapedItemRejected([
          {
            code:
              result.status === 'sole-recipe'
                ? 'RECIPE_IS_SOLE_USER'
                : 'RECIPE_NOT_LINKED',
            message:
              result.status === 'sole-recipe'
                ? 'This is the only recipe using the item; there is no shared search to split.'
                : 'That recipe is not linked to this item.',
          },
        ]);
      checkWrite(result);
      return applied(id);
    },

    async searchModifiers(
      query: string,
      gameDataVersion?: string,
    ): Promise<ScrapedItemModifiersResponse['data']> {
      const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
      const { rows } = await pool.query<{
        id: string;
        name: string | null;
        generationType: string | null;
        familyId: string | null;
        requiredLevel: number | null;
        tradeMapped: boolean;
        externalId: string | null;
      }>(
        `${identityRegistrySql}
         select id, max(name) as name, max("generationType") as "generationType",
           max("familyId") as "familyId", max("requiredLevel") as "requiredLevel",
           bool_or(mapped) as "tradeMapped", min("externalId") as "externalId"
         from registry
         where kind = 'mod' and ($2::text is null or patch = $2)
           and (id ilike $1 or name ilike $1 or id ilike $3)
         group by id
         order by "tradeMapped" desc, max(name) nulls last, id limit ${maximumModifierResults}`,
        [
          `%${escape(query)}%`,
          gameDataVersion ?? null,
          `%${escape(query.trim().replace(/\s+/g, '-'))}%`,
        ],
      );
      return {
        modifiers: rows.map((row) => {
          const described = describe(row.name ?? undefined, row.id);
          return {
            familyId: row.familyId || null,
            generationType:
              row.generationType ||
              options.presentation?.get(row.id)?.generationType ||
              null,
            id: row.id,
            name: described.name,
            nameSource: described.source,
            requiredLevel: row.requiredLevel,
            tradeMapped: row.tradeMapped,
            tradeText: row.externalId
              ? (tradeStatMappings[row.externalId]?.text ?? null)
              : null,
          };
        }),
      };
    },

    async startTest(id: string, input: { expectedRevision: number }) {
      if (await options.readCollectionsPaused())
        throw new DomainError('MARKET_COLLECTION_PAUSED');
      const item = await readScrapedItem(pool, id);
      if (!item) throw new DomainError('PERSISTENCE_NOT_FOUND');
      if (item.revision !== input.expectedRevision)
        throw new DomainError('PERSISTENCE_CONFLICT');
      const league = await repositories.leagues.findCurrent();
      const { trade } = await tradeFor([item.spec]);
      const compiled = await compile(trade, league, item);
      if (!compiled.ok || !compiled.key || !league)
        throw new ScrapedItemRejected(
          compiled.ok
            ? [
                {
                  code: 'CURRENT_LEAGUE_UNRESOLVED',
                  message: 'The current league is not resolved yet.',
                },
              ]
            : compiled.diagnostics,
        );
      const key = compiled.key;
      const find = async () => (await readSchedules(league.id, [key])).get(key);
      let schedule = await find();
      if (!schedule?.enabled) {
        // The configuration may be saved but not yet applied; apply it once, then re-check.
        await options.applySchedules().catch(() => undefined);
        schedule = await find();
      }
      if (!schedule?.enabled)
        throw new ScrapedItemRejected([
          {
            code: 'SEARCH_NOT_SCHEDULED',
            message:
              'The collector is not scraping this search. Link an active recipe or wait for the collector to apply the saved configuration.',
          },
        ]);
      // Report the persisted request, not what this call compiled.
      return enqueueScrapedItemTest(pool, {
        itemId: id,
        revision: item.revision,
        scheduleKey: key,
      });
    },

    async readTest(
      itemId: string,
      requestId: string,
    ): Promise<ScrapedItemTest> {
      const { rows } = await pool.query<{
        id: string;
        itemId: string;
        itemRevision: number;
        scheduleKey: string;
        state: string;
        summary: Record<string, unknown> | null;
        requestedAt: Date;
        startedAt: Date | null;
        finishedAt: Date | null;
        currentRevision: number;
      }>(
        `select r.id, r.scraped_item_id as "itemId", r.scraped_item_revision as "itemRevision",
           r.schedule_key as "scheduleKey", r.state, r.summary, r.requested_at as "requestedAt",
           r.started_at as "startedAt", r.finished_at as "finishedAt", i.revision as "currentRevision"
         from run_requests r join scraped_items i on i.id = r.scraped_item_id
         where r.id = $1 and r.scope = 'item' and r.scraped_item_id = $2`,
        [requestId, itemId],
      );
      const request = rows[0];
      if (!request) throw new DomainError('PERSISTENCE_NOT_FOUND');
      const outcome = classifyScrapedItemTest(request);
      // A search is current only while it still compiles to the submitted hash.
      // The league or a Trade mapping can change that without any edit.
      const current = await readScrapedItem(pool, itemId);
      const currentKey = current
        ? (
            await compile(
              (await tradeFor([current.spec])).trade,
              await repositories.leagues.findCurrent(),
              current,
            )
          ).key
        : null;
      return {
        capture: outcome.captureId
          ? await readCaptureDiagnostics(outcome.captureId)
          : null,
        currentRevision: current?.revision ?? request.currentRevision,
        currentScheduleKey: currentKey,
        finishedAt: request.finishedAt?.toISOString() ?? null,
        itemId: request.itemId,
        itemRevision: request.itemRevision,
        reason: outcome.reason,
        requestId: request.id,
        requestedAt: request.requestedAt.toISOString(),
        scheduleKey: request.scheduleKey,
        stale:
          (current?.revision ?? request.currentRevision) !==
            request.itemRevision || currentKey !== request.scheduleKey,
        startedAt: request.startedAt?.toISOString() ?? null,
        state: outcome.state,
      };
    },

    /** The latest capture of the item's current search, if any. */
    async readLatestCapture(id: string) {
      const item = await view(id);
      if (!item.latestCapture) return null;
      return readCaptureDiagnostics(item.latestCapture.captureId);
    },
  };
}

export type ScrapedItemService = ReturnType<typeof createScrapedItemService>;

type ScheduleRow = {
  id: string;
  key: string;
  enabled: boolean;
  intervalMinutes: number;
  nextDueAt: Date;
  lastStatus: string | null;
  lastError: string | null;
  lastFinishedAt: Date | null;
};
const captureColumns = `c.id, c.schedule_id as "scheduleId", c.captured_at as "capturedAt",
  c.reported_total as "reportedTotal", c.fetched, c.complete, c.sorted_sample_ids as "sortedSampleIds",
  c.partial_reason as "partialReason", c.slices, c.duration_ms as "durationMs", c.query_version as "queryVersion"`;
type CaptureRow = {
  id: string;
  scheduleId: string;
  capturedAt: Date;
  reportedTotal: number;
  fetched: number;
  complete: boolean;
  sortedSampleIds: string[] | null;
  partialReason: string | null;
  slices: number;
  durationMs: number;
  queryVersion: string | null;
};

function captureFacts(row: CaptureRow): ScrapedCaptureFacts {
  return {
    captureId: row.id,
    capturedAt: row.capturedAt.toISOString(),
    // A sorted sample is a deliberate partial read, never a complete capture.
    coverage:
      row.complete && row.sortedSampleIds === null ? 'complete' : 'partial',
    durationMs: row.durationMs,
    fetched: row.fetched,
    partialReason: row.partialReason,
    queryVersion: row.queryVersion,
    reportedTotal: row.reportedTotal,
    slices: row.slices,
  };
}

/** The Trade base type a compiled search asks for, when it names one. */
function tradeBaseType(query: RecipeMarketQuery) {
  return recipeQueryTarget(query.query.handbookTarget).baseTypes[0] ?? null;
}
