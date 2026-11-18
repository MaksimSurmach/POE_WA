import {
  DomainError,
  scrapedItemDigest,
  scrapedItemSpecFromRecipe,
  scrapedItemSpecSchema,
  type CanonicalRecipe,
  type ScrapedItemRole,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';
import type { Pool, PoolClient } from 'pg';

import {
  derivedRecipeSpecs,
  type EffectiveScrapedItem,
  type RecipeSpecResolver,
} from '../scrapedItemConfig.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
const roles: readonly ScrapedItemRole[] = ['base', 'output'];

export type ScrapedItemRecord = {
  id: string;
  role: ScrapedItemRole;
  spec: ScrapedItemSpec;
  revision: number;
  origin: 'recipe' | 'owner';
  createdAt: Date;
  updatedAt: Date;
};
export type ScrapedItemLink = {
  recipeId: string;
  role: ScrapedItemRole;
  itemId: string;
  authoredDigest: string;
};
type ItemRow = Omit<ScrapedItemRecord, 'spec'> & { spec: unknown };

function toRecord(row: ItemRow): ScrapedItemRecord {
  // A stored spec that no longer parses must fail loudly, not fall back to the recipe.
  return { ...row, spec: scrapedItemSpecSchema.parse(row.spec) };
}
const itemColumns = `id, role, spec, revision, origin, created_at as "createdAt", updated_at as "updatedAt"`;

export async function readScrapedItems(db: Queryable) {
  const { rows } = await db.query<ItemRow>(
    `select ${itemColumns} from scraped_items order by created_at, id`,
  );
  return rows.map(toRecord);
}

export async function readScrapedItem(db: Queryable, id: string) {
  const { rows } = await db.query<ItemRow>(
    `select ${itemColumns} from scraped_items where id = $1`,
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function readScrapedItemLinks(db: Queryable) {
  const { rows } = await db.query<ScrapedItemLink>(
    `select recipe_id as "recipeId", role, item_id as "itemId", authored_digest as "authoredDigest"
     from scraped_item_recipes order by recipe_id, role`,
  );
  return rows;
}

/** One statement, so a concurrent edit cannot mix two revisions in a read. */
async function readConfigured(db: Queryable, recipeIds: readonly string[]) {
  const { rows } = await db.query<{
    recipeId: string;
    role: ScrapedItemRole;
    id: string;
    revision: number;
    spec: unknown;
  }>(
    `select l.recipe_id as "recipeId", l.role, i.id, i.revision, i.spec
     from scraped_item_recipes l join scraped_items i on i.id = l.item_id
     where l.recipe_id = any($1::text[])`,
    [recipeIds],
  );
  const configured = new Map<
    string,
    Map<ScrapedItemRole, EffectiveScrapedItem>
  >();
  for (const row of rows) {
    const byRole = configured.get(row.recipeId) ?? new Map();
    byRole.set(row.role, {
      spec: scrapedItemSpecSchema.parse(row.spec),
      configured: { id: row.id, revision: row.revision },
    });
    configured.set(row.recipeId, byRole);
  }
  return configured;
}

function resolverFrom(
  configured: Map<string, Map<ScrapedItemRole, EffectiveScrapedItem>>,
): RecipeSpecResolver {
  return (recipe) => {
    const derived = derivedRecipeSpecs(recipe) as Awaited<
      ReturnType<RecipeSpecResolver>
    >;
    const links = configured.get(recipe.id);
    return {
      base: links?.get('base') ?? derived.base,
      output: links?.get('output') ?? derived.output,
    };
  };
}

/** Resolve many recipes from one consistent read; recipes without a link use their authored requirements. */
export async function preloadScrapedItemSpecs(
  db: Queryable,
  recipeIds: readonly string[],
): Promise<RecipeSpecResolver> {
  return resolverFrom(await readConfigured(db, recipeIds));
}

/** Resolve one recipe at call time, for readers that are not batched. */
export function createScrapedItemSpecResolver(
  db: Queryable,
): RecipeSpecResolver {
  return async (recipe) =>
    resolverFrom(await readConfigured(db, [recipe.id]))(recipe);
}

/** Blocks concurrent edits until the holding transaction ends. */
export const scrapedItemLockSql = 'select id from scraped_items for share';

export const scrapedItemFingerprintSql = `select md5(coalesce((
    select string_agg(id::text || ':' || revision::text, ',' order by id) from scraped_items
  ), '') || '|' || coalesce((
    select string_agg(recipe_id || ':' || role || ':' || item_id::text, ',' order by recipe_id, role) from scraped_item_recipes
  ), '')) as fingerprint`;

/**
 * Fingerprint of every configured item and link. Schedule synchronization
 * compares it before and after compiling so it never writes a stale view.
 */
export async function readScrapedItemFingerprint(db: Queryable) {
  const { rows } = await db.query<{ fingerprint: string }>(
    scrapedItemFingerprintSql,
  );
  return rows[0]!.fingerprint;
}

async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function appendRevision(
  client: PoolClient,
  itemId: string,
  revision: number,
  spec: ScrapedItemSpec,
  cause: 'seed' | 'edit' | 'link' | 'unlink',
) {
  await client.query(
    `insert into scraped_item_revisions (item_id, revision, spec, cause) values ($1, $2, $3, $4)`,
    [itemId, revision, JSON.stringify(spec), cause],
  );
}

async function bumpRevision(
  client: PoolClient,
  item: ScrapedItemRecord,
  cause: 'link' | 'unlink',
) {
  const { rows } = await client.query<{ revision: number }>(
    `update scraped_items set revision = revision + 1, updated_at = now() where id = $1 returning revision`,
    [item.id],
  );
  await appendRevision(client, item.id, rows[0]!.revision, item.spec, cause);
  return rows[0]!.revision;
}

/**
 * Serializes every change of which item a recipe's role uses. It must be taken
 * before that link is read, so two concurrent moves of one recipe cannot both
 * believe they are leaving the same previous item. It is always acquired before
 * any item row lock, so the lock order is the same for every writer.
 */
async function lockRecipeRole(
  client: PoolClient,
  recipeId: string,
  role: ScrapedItemRole,
) {
  await client.query(
    `select pg_advisory_xact_lock(hashtext('poe-worksmith:scraped-item-link:' || $1 || ':' || $2))`,
    [recipeId, role],
  );
}

async function lockItems(client: PoolClient, ids: readonly string[]) {
  const { rows } = await client.query<ItemRow>(
    `select ${itemColumns} from scraped_items where id = any($1::uuid[]) order by id for update`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, toRecord(row)]));
}

/**
 * Creates a configured item for every recipe base/output that has none. It
 * never touches an existing link, so an owner edit always survives a sync.
 * Recipes whose authored requirements are identical share one item, matching
 * how their searches were already shared.
 */
export async function seedScrapedItems(
  pool: Pool,
  recipes: readonly { id: string; definition: CanonicalRecipe }[],
) {
  if (!recipes.length) return 0;
  return inTransaction(pool, async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtext('poe-worksmith:scraped-item-seed'))`,
    );
    const { rows: existing } = await client.query<{
      recipeId: string;
      role: ScrapedItemRole;
    }>(
      `select recipe_id as "recipeId", role from scraped_item_recipes where recipe_id = any($1::text[])`,
      [recipes.map(({ id }) => id)],
    );
    const linked = new Set(
      existing.map(({ recipeId, role }) => `${recipeId}:${role}`),
    );
    const groups = new Map<
      string,
      { role: ScrapedItemRole; spec: ScrapedItemSpec; recipeIds: string[] }
    >();
    for (const recipe of recipes)
      for (const role of roles) {
        if (linked.has(`${recipe.id}:${role}`)) continue;
        const spec = scrapedItemSpecFromRecipe(recipe.definition, role);
        const digest = scrapedItemDigest(role, spec);
        const group = groups.get(digest);
        if (group) group.recipeIds.push(recipe.id);
        else groups.set(digest, { role, spec, recipeIds: [recipe.id] });
      }
    for (const [digest, group] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const { rows } = await client.query<{ id: string }>(
        `insert into scraped_items (role, spec) values ($1, $2) returning id`,
        [group.role, JSON.stringify(group.spec)],
      );
      const id = rows[0]!.id;
      await appendRevision(client, id, 1, group.spec, 'seed');
      await client.query(
        `insert into scraped_item_recipes (recipe_id, role, item_id, authored_digest)
         select unnest($1::text[]), $2, $3, $4`,
        [group.recipeIds, group.role, id, digest],
      );
    }
    return groups.size;
  });
}

export type ScrapedItemWrite =
  | { status: 'saved'; item: ScrapedItemRecord }
  | { status: 'unchanged'; item: ScrapedItemRecord }
  | { status: 'conflict'; item: ScrapedItemRecord }
  | { status: 'not-found' };

/** Replaces requirements when the caller saw the current revision. */
export async function updateScrapedItemSpec(
  pool: Pool,
  input: { id: string; expectedRevision: number; spec: ScrapedItemSpec },
): Promise<ScrapedItemWrite> {
  return inTransaction(pool, async (client) => {
    const current = (await lockItems(client, [input.id])).get(input.id);
    if (!current) return { status: 'not-found' };
    if (current.revision !== input.expectedRevision)
      return { status: 'conflict', item: current };
    if (JSON.stringify(current.spec) === JSON.stringify(input.spec))
      return { status: 'unchanged', item: current };
    const { rows } = await client.query<ItemRow>(
      `update scraped_items set spec = $2, revision = revision + 1, origin = 'owner', updated_at = now()
       where id = $1 returning ${itemColumns}`,
      [input.id, JSON.stringify(input.spec)],
    );
    const item = toRecord(rows[0]!);
    await appendRevision(client, item.id, item.revision, item.spec, 'edit');
    return { status: 'saved', item };
  });
}

/** Moves a recipe's search for this role onto an item the caller has reviewed. */
export async function linkRecipeToScrapedItem(
  pool: Pool,
  input: {
    itemId: string;
    expectedRevision: number;
    recipeId: string;
    authoredDigest: string;
  },
): Promise<ScrapedItemWrite> {
  return inTransaction(pool, async (client) => {
    // An item's role never changes, so it can be read before any lock is held.
    const { rows: roles } = await client.query<{ role: ScrapedItemRole }>(
      'select role from scraped_items where id = $1',
      [input.itemId],
    );
    if (!roles[0]) return { status: 'not-found' };
    await lockRecipeRole(client, input.recipeId, roles[0].role);
    const { rows: existing } = await client.query<{ itemId: string }>(
      `select item_id as "itemId" from scraped_item_recipes
       where recipe_id = $1 and role = $2`,
      [input.recipeId, roles[0].role],
    );
    const previous = existing[0]?.itemId;
    const locked = await lockItems(
      client,
      previous && previous !== input.itemId
        ? [input.itemId, previous]
        : [input.itemId],
    );
    const target = locked.get(input.itemId);
    if (!target) return { status: 'not-found' };
    if (target.revision !== input.expectedRevision)
      return { status: 'conflict', item: target };
    if (previous === input.itemId) return { status: 'unchanged', item: target };
    await client.query(
      `insert into scraped_item_recipes (recipe_id, role, item_id, authored_digest)
       values ($1, $2, $3, $4)
       on conflict (recipe_id, role) do update
         set item_id = excluded.item_id, authored_digest = excluded.authored_digest, linked_at = now()`,
      [input.recipeId, target.role, input.itemId, input.authoredDigest],
    );
    const revision = await bumpRevision(client, target, 'link');
    const old = previous ? locked.get(previous) : undefined;
    if (old) await bumpRevision(client, old, 'unlink');
    return { status: 'saved', item: { ...target, revision } };
  });
}

export type ScrapedItemUnlink =
  | ScrapedItemWrite
  | { status: 'sole-recipe'; item: ScrapedItemRecord }
  | { status: 'not-linked'; item: ScrapedItemRecord };

/** Gives one recipe its own copy of the item so the shared search is split. */
export async function unlinkRecipeFromScrapedItem(
  pool: Pool,
  input: { itemId: string; expectedRevision: number; recipeId: string },
): Promise<ScrapedItemUnlink & { detachedItemId?: string }> {
  return inTransaction(pool, async (client) => {
    const { rows: roles } = await client.query<{ role: ScrapedItemRole }>(
      'select role from scraped_items where id = $1',
      [input.itemId],
    );
    if (!roles[0]) return { status: 'not-found' };
    await lockRecipeRole(client, input.recipeId, roles[0].role);
    const item = (await lockItems(client, [input.itemId])).get(input.itemId);
    if (!item) return { status: 'not-found' };
    if (item.revision !== input.expectedRevision)
      return { status: 'conflict', item };
    const { rows: links } = await client.query<{ recipeId: string }>(
      `select recipe_id as "recipeId" from scraped_item_recipes where item_id = $1`,
      [input.itemId],
    );
    if (!links.some(({ recipeId }) => recipeId === input.recipeId))
      return { status: 'not-linked', item };
    if (links.length === 1) return { status: 'sole-recipe', item };
    const { rows } = await client.query<{ id: string }>(
      `insert into scraped_items (role, spec, origin) values ($1, $2, 'owner') returning id`,
      [item.role, JSON.stringify(item.spec)],
    );
    const detachedItemId = rows[0]!.id;
    await appendRevision(client, detachedItemId, 1, item.spec, 'unlink');
    await client.query(
      `update scraped_item_recipes set item_id = $1, linked_at = now() where recipe_id = $2 and role = $3`,
      [detachedItemId, input.recipeId, item.role],
    );
    const revision = await bumpRevision(client, item, 'unlink');
    return { status: 'saved', item: { ...item, revision }, detachedItemId };
  });
}

/** The persisted facts of a queued item test, whether new or already active. */
export type ScrapedItemTestRequest = {
  requestId: string;
  itemId: string;
  itemRevision: number;
  scheduleKey: string;
};

/**
 * Queues one test of a single item at the revision and search the owner
 * submitted. An identical active submission is the same request; the same item
 * and revision under a different search is its own. The returned facts are the
 * persisted row's, so a deduplicated request never reports a search it was not
 * queued for.
 */
export async function enqueueScrapedItemTest(
  pool: Pool,
  input: { itemId: string; revision: number; scheduleKey: string },
): Promise<ScrapedItemTestRequest> {
  // One statement commits both the queue row and its wake notification.
  const { rows } = await pool.query<ScrapedItemTestRequest>(
    `with queued as (
      insert into run_requests (scope, scraped_item_id, scraped_item_revision, schedule_key)
      select 'item', i.id, i.revision, $3
      from scraped_items i where i.id = $1 and i.revision = $2
      on conflict (scope, (coalesce(recipe_id, '')), (coalesce(scraped_item_id::text || ':' || scraped_item_revision::text, '')), (coalesce(schedule_key, '')))
        where state in ('queued', 'running')
      do update set scope = excluded.scope
      returning id, scraped_item_id, scraped_item_revision, schedule_key
    )
    select id as "requestId", scraped_item_id as "itemId", scraped_item_revision as "itemRevision",
      schedule_key as "scheduleKey", pg_notify('worksmith_wake', '') from queued`,
    [input.itemId, input.revision, input.scheduleKey],
  );
  const request = rows[0];
  if (!request) throw new DomainError('PERSISTENCE_CONFLICT');
  return {
    requestId: request.requestId,
    itemId: request.itemId,
    itemRevision: request.itemRevision,
    scheduleKey: request.scheduleKey,
  };
}
