import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  RegisteredTradeQueryGenerator,
  clusterJewelVariantFilter,
  scrapedItemDigest,
  scrapedItemSpecFromRecipe,
  hashMarketQuery,
  mappedTargetFilter,
  noVariantFilter,
  validateRecipeDocument,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';
import pino from 'pino';
import type { PoolClient } from 'pg';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { buildApi } from './api.js';
import { runCollector, type CollectorResult } from './collector.js';
import {
  createCollectorResultPublisher,
  createCollectorResultReader,
} from './collectorResults.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { loadItemPresentationCatalog } from './itemPresentation.js';
import { createMarketAdminStore, defaultAdminSettings } from './marketAdmin.js';
import { recipeResultSchema } from './recipeResult.js';
import { createRecipeMarketDependencies } from './recipeMarket.js';
import { recipeQueryTarget } from './recipeMarket.js';
import { generateMarketTradeQuery } from './marketTradeQuery.js';
import { createResourceReaders } from './resourceViews.js';
import { createCraftAnalysisRepository } from './repositories/craftAnalysisRepository.js';
import {
  synchronizeCollectorSchedules,
  synchronizeRecipeCatalog,
  synchronizeTradeTargetSchedules,
} from './recipes/synchronizeRecipes.js';
import { createPostgresRepositories } from './repositories/index.js';
import { writeCaptureInTransaction } from './repositories/captureRepository.js';
import { enqueueRunRequest } from './repositories/runRequestRepository.js';
import {
  createScrapedItemSpecResolver,
  linkRecipeToScrapedItem,
  preloadScrapedItemSpecs,
  seedScrapedItems,
} from './repositories/scrapedItemRepository.js';
import { loadCollectorScheduleConfig } from './runtimeConfig.js';
import { createScrapedItemService } from './scrapedItems.js';
import {
  importTradeMappings,
  loadTradeMappingCatalog,
} from './tradeMappings.js';

const pool = createDatabasePool({ ...loadDatabaseConfig(), maxConnections: 6 });
const repositories = createPostgresRepositories(pool);
const catalog = fileURLToPath(new URL('../../../recipes', import.meta.url));
const patch = '3.29.3.3';
const recipeId = 'physical-large-cluster-jagged';
let paused = false;
const service = createScrapedItemService({
  pool,
  applySchedules: async () =>
    (await synchronizeTradeTargetSchedules(pool)) === 'synchronized'
      ? 'synchronized'
      : 'deferred',
  readCollectionsPaused: async () => paused,
});

async function prepare() {
  paused = false;
  await pool.query(
    'truncate table scraped_items, collector_schedule, recipes, poe_leagues, game_data_versions restart identity cascade',
  );
  await repositories.leagues.upsert({
    endAt: null,
    game: 'poe1',
    gggId: 'FixtureGGG',
    isCurrent: true,
    metadata: {},
    name: 'Fixture display name',
    realm: 'pc',
    startAt: null,
    syncedAt: new Date(),
  });
  const version = await pool.query<{ id: string }>(
    `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
     values ('poe1', $1, 'fixture', 'fixture', 'scraped-items', 'active') returning id`,
    [patch],
  );
  for (const name of ['physical-large-cluster', 'recipe-catalog']) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../mappings/poe-trade/${patch}/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
    await importTradeMappings(pool, {
      ...manifest,
      sourceRevision: manifest.mappingVersion,
    });
    for (const mapping of manifest.mappings.filter(
      ({ entityKind }: { entityKind: string }) => entityKind === 'mod',
    ))
      await pool.query(
        `insert into canonical_entities (game_data_version_id, entity_kind, canonical_id, payload, payload_hash)
         values ($1, 'mod', $2, $3, $2) on conflict do nothing`,
        [
          version.rows[0]!.id,
          mapping.canonicalId,
          {
            id: mapping.canonicalId,
            familyId: `family:${mapping.canonicalId}`,
            name: `Canonical ${mapping.canonicalId}`,
            generationType: 'prefix',
            requiredLevel: 1,
            tags: [],
            spawnWeights: [],
            stats: [],
          },
        ],
      );
  }
  await synchronizeRecipeCatalog(catalog, repositories.recipes);
  expect(
    await synchronizeCollectorSchedules(pool, loadCollectorScheduleConfig()),
  ).toBe('synchronized');
}

async function item(role: 'base' | 'output', recipe = recipeId) {
  const found = (await service.list()).items.find(
    (candidate) =>
      candidate.role === role &&
      candidate.recipes.some(({ id }) => id === recipe),
  );
  if (!found) throw new Error(`No ${role} item for ${recipe}`);
  return found;
}
const enabledKeys = async () =>
  (
    await pool.query<{ key: string }>(
      "select key from collector_schedule where kind = 'trade-target' and enabled and payload->>'discovery' is null order by key",
    )
  ).rows.map(({ key }) => key);
const edited = (
  spec: ScrapedItemSpec,
  change: (draft: ScrapedItemSpec) => void,
) => {
  const draft = structuredClone(spec);
  change(draft);
  return draft;
};

beforeEach(prepare, 120_000);
afterAll(() => pool.end());

describe('configured scraped items', () => {
  it('lists every current base and output search once, with the recipes sharing it', async () => {
    const data = await service.list();
    const outputs = data.items.filter(({ role }) => role === 'output');
    const bases = data.items.filter(({ role }) => role === 'base');
    // The same grouping the schedules already had before configuration existed.
    expect(outputs.length + bases.length).toBe(
      (await enabledKeys()).length === 0 ? 0 : data.items.length,
    );
    expect(data.items.every(({ query }) => query.status === 'ready')).toBe(
      true,
    );
    const keys = data.items.map(({ query }) => query.key!);
    expect((await enabledKeys()).every((key) => keys.includes(key))).toBe(true);
    const output = await item('output');
    expect(output.recipes.map(({ id }) => id)).toContain(recipeId);
    expect(output.schedule).toMatchObject({ enabled: true });
    expect(output.modifiers.every(({ tradeMapped }) => tradeMapped)).toBe(true);
    expect(
      JSON.parse(
        gunzipSync(
          Buffer.from(
            new URL(output.query.tradeUrl!).pathname.split('/').at(-1)!,
            'base64url',
          ),
        ).toString(),
      ),
    ).toMatchObject({ query: { status: { option: 'securable' } } });
    expect(output.query.tradeUrl).toContain('FixtureGGG');
    expect(
      (
        await pool.query(
          `select 1 from collector_schedule where key = $1 and payload->'scrapedItems' @> $2::jsonb`,
          [output.query.key, JSON.stringify([{ id: output.id, revision: 1 }])],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('reports an unsupported collector query on its item without hiding the other searches', async () => {
    const before = await service.list();
    const output = await item('output');
    await pool.query(
      "update provider_mappings set external_id = 'explicit.stat_9999999999' where provider = 'poe-trade' and canonical_id = 'mod:battle-hardened'",
    );
    const after = await service.list();
    expect(after.items).toHaveLength(before.items.length);
    const blocked = after.items.find(({ id }) => id === output.id)!;
    expect(blocked.query).toMatchObject({
      status: 'blocked',
      tradeUrl: null,
      diagnostics: [{ code: 'COLLECTOR_QUERY_UNSUPPORTED' }],
    });
    expect(after.items.some(({ query }) => query.status === 'ready')).toBe(
      true,
    );
    await expect(
      service.startTest(blocked.id, { expectedRevision: blocked.revision }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: 'COLLECTOR_QUERY_UNSUPPORTED' }],
    });
    expect(
      (await pool.query('select count(*)::int as n from run_requests')).rows[0]
        .n,
    ).toBe(0);
  });

  it('applies an edit to the schedule, the publication dependencies and the Trade link alike', async () => {
    const before = await item('output');
    const oldKey = before.query.key!;
    // Capture history belongs to the query that produced it.
    await pool.query(
      `insert into captures (schedule_id, captured_at, reported_total, fetched, complete, slices, duration_ms, query_version)
       select id, now() - interval '1 hour', 4, 4, true, 1, 10, key from collector_schedule where key = $1`,
      [oldKey],
    );
    const { item: after, schedule } = await service.save(before.id, {
      expectedRevision: before.revision,
      spec: edited(before.spec, (draft) => {
        draft.marketEquivalent = false;
        draft.item.itemLevel = before.spec.item.itemLevel + 1;
        draft.conditions = [
          {
            kind: 'explicit',
            modId: 'mod:furious-assault',
            excluded: false,
            minimumValue: 5,
            maximumValue: 40,
          },
          draft.conditions[1]!,
        ];
      }),
    });
    expect(schedule).toBe('synchronized');
    expect(after).toMatchObject({ revision: 2, origin: 'owner' });
    expect(after.query.key).not.toBe(oldKey);
    // A new query hash gets its own schedule and starts without inherited captures.
    expect(await enabledKeys()).toContain(after.query.key);
    expect(await enabledKeys()).not.toContain(oldKey);
    expect(after.latestCapture).toBeNull();
    expect(
      (
        await pool.query(
          `select count(*)::int as n from captures c join collector_schedule s on s.id = c.schedule_id
           where s.key = $1 and c.query_version = $1`,
          [oldKey],
        )
      ).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (
        await pool.query(
          'select revision from scraped_item_revisions where item_id = $1 order by revision',
          [before.id],
        )
      ).rows.map(({ revision }) => revision),
    ).toEqual([1, 2]);

    // Publication recompiles the same query from the same configuration.
    const stored = (await repositories.recipes.listActive()).find(
      ({ id }) => id === recipeId,
    )!;
    const definition = validateRecipeDocument(stored.definition);
    const dependencies = await createRecipeMarketDependencies({
      resolveResource: async () => null,
      specs: await preloadScrapedItemSpecs(pool, [recipeId]),
      trade: new RegisteredTradeQueryGenerator(
        await loadTradeMappingCatalog(pool, [patch]),
        [noVariantFilter, clusterJewelVariantFilter],
        [mappedTargetFilter],
      ),
    })({ league: 'FixtureGGG', recipe: definition });
    const target = dependencies.find(({ kind }) => kind === 'target')!.query!;
    expect(await hashMarketQuery({ ...target, league: 'FixtureGGG' })).toBe(
      after.query.key,
    );
    const url = new URL(after.query.tradeUrl!);
    const opened = JSON.parse(
      gunzipSync(
        Buffer.from(url.pathname.split('/').at(-1)!, 'base64url'),
      ).toString(),
    );
    expect(opened).toEqual(
      generateMarketTradeQuery(recipeQueryTarget(target.query.handbookTarget))
        .request,
    );
    expect(opened.query.filters.misc_filters.filters.corrupted).toEqual({
      option: 'false',
    });
    expect(
      opened.query.stats.some(
        (group: { type: string }) => group.type === 'not',
      ),
    ).toBe(true);
  });

  it('survives restart and collection sync: recipe sync and schedule sync never overwrite an edit', async () => {
    const before = await item('output');
    const { item: edit } = await service.save(before.id, {
      expectedRevision: before.revision,
      spec: edited(before.spec, (draft) => {
        draft.item.itemLevel = 86;
      }),
    });
    expect(
      (await synchronizeRecipeCatalog(catalog, repositories.recipes)).failed,
    ).toEqual([]);
    expect(
      await synchronizeCollectorSchedules(pool, loadCollectorScheduleConfig()),
    ).toBe('synchronized');
    const after = await item('output');
    expect(after.spec.item.itemLevel).toBe(86);
    expect(after.revision).toBe(edit.revision);
    expect(after.query.key).toBe(edit.query.key);
    expect(await enabledKeys()).toContain(edit.query.key);
    // Seeding again is idempotent: no duplicate items, no rewritten links.
    const count = async () =>
      (await pool.query('select count(*)::int as n from scraped_items'))
        .rows[0]!.n;
    const items = await count();
    await seedScrapedItems(
      pool,
      (await repositories.recipes.listActive()).map((recipe) => ({
        id: recipe.id,
        definition: validateRecipeDocument(recipe.definition),
      })),
    );
    expect(await count()).toBe(items);
  });

  it('rejects stale and unsupported edits without changing anything', async () => {
    const output = await item('output');
    await service.save(output.id, {
      expectedRevision: 1,
      spec: edited(output.spec, (draft) => {
        draft.item.itemLevel = 85;
      }),
    });
    await expect(
      service.save(output.id, { expectedRevision: 1, spec: output.spec }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const current = await item('output');
    const reject = async (change: (draft: ScrapedItemSpec) => void) =>
      service
        .save(current.id, {
          expectedRevision: current.revision,
          spec: edited(current.spec, change),
        })
        .then(
          () => null,
          (error: { diagnostics?: { code: string }[] }) =>
            error.diagnostics?.map(({ code }) => code),
        );
    expect(
      await reject((draft) => {
        draft.conditions.push({
          kind: 'explicit',
          modId: 'mod:does-not-exist',
          excluded: false,
        });
      }),
    ).toEqual(['MODIFIER_UNKNOWN']);
    expect(
      await reject((draft) => {
        draft.item.baseId = 'Another/Base';
      }),
    ).toEqual(['ITEM_IDENTITY_IMMUTABLE']);
    expect(
      await reject((draft) => {
        draft.item.influences = ['not-an-influence'];
      }),
    ).toEqual(['REQUIREMENT_UNSUPPORTED']);
    // Known to game data but without a Trade mapping: blocked, never weakened.
    await pool.query(
      `insert into canonical_entities (game_data_version_id, entity_kind, canonical_id, payload, payload_hash)
       select id, 'mod', 'mod:unmapped', '{"id":"mod:unmapped","familyId":"f","name":"Unmapped","generationType":"prefix","requiredLevel":1,"tags":[],"spawnWeights":[],"stats":[]}'::jsonb, 'unmapped'
       from game_data_versions where status = 'active'`,
    );
    expect(
      await reject((draft) => {
        draft.conditions.push({
          kind: 'explicit',
          modId: 'mod:unmapped',
          excluded: false,
        });
      }),
    ).toEqual(['TRADE_MAPPING_MISSING']);
    expect((await item('output')).revision).toBe(current.revision);
  });

  it('keeps mapped modifiers editable and discoverable when canonical metadata is sparse', async () => {
    // Real game data maps far more modifiers than it carries canonical entities for.
    await pool.query(
      "delete from canonical_entities where entity_kind in ('mod', 'modFamily')",
    );
    const output = await item('output');
    expect(output.modifiers.length).toBeGreaterThan(0);
    // Missing metadata is reported as missing, never invented from the id.
    expect(
      output.modifiers.every(
        (modifier) =>
          modifier.tradeMapped &&
          modifier.name === null &&
          modifier.nameSource === 'unavailable',
      ),
    ).toBe(true);
    expect(output.baseNameSource).toBe('trade');
    expect(output.baseName).toBe('Large Cluster Jewel');
    const gloves = await item('output', 'suppression-gloves-zeal');
    const { item: categoryOutput } = await service.save(gloves.id, {
      expectedRevision: gloves.revision,
      spec: { ...gloves.spec, marketSearchCategory: 'armour.gloves' },
    });
    expect(categoryOutput.query.status).toBe('ready');
    expect(categoryOutput.baseNameSource).toBe('trade');
    expect(categoryOutput.baseName).toBe(gloves.baseName);
    expect(categoryOutput.baseName).not.toBe(categoryOutput.baseId);

    // An unrelated edit on existing mapped modifiers is not blocked by missing metadata.
    const saved = await service.save(output.id, {
      expectedRevision: output.revision,
      spec: edited(output.spec, (draft) => {
        draft.item.itemLevel = output.spec.item.itemLevel + 1;
      }),
    });
    expect(saved.item.revision).toBe(2);

    // A newly selected known mapped modifier is accepted too.
    const found = await service.searchModifiers('attack');
    expect(found.modifiers).toContainEqual(
      expect.objectContaining({
        id: 'mod:attack-speed',
        name: null,
        nameSource: 'unavailable',
        tradeMapped: true,
        tradeText: expect.stringContaining('Attack Speed'),
      }),
    );
    const added = await service.save(saved.item.id, {
      expectedRevision: saved.item.revision,
      spec: edited(saved.item.spec, (draft) => {
        draft.conditions.push({
          kind: 'explicit',
          modId: 'mod:attack-speed',
          excluded: false,
          minimumValue: 5,
        });
      }),
    });
    expect(added.item.spec.conditions.map(({ modId }) => modId)).toContain(
      'mod:attack-speed',
    );
    expect(added.item.query.status).toBe('ready');

    // A modifier neither named by game data nor mapped is still rejected.
    await expect(
      service.save(added.item.id, {
        expectedRevision: added.item.revision,
        spec: edited(added.item.spec, (draft) => {
          draft.conditions.push({
            kind: 'explicit',
            modId: 'mod:invented-by-owner',
            excluded: false,
          });
        }),
      }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: 'MODIFIER_UNKNOWN' }],
    });
    // A disabled mapping stops a sparse modifier being selectable.
    await pool.query(
      "update provider_mappings set status = 'disabled' where canonical_id = 'mod:attack-speed'",
    );
    expect(
      (await service.searchModifiers('attack-speed')).modifiers.map(
        ({ id }) => id,
      ),
    ).not.toContain('mod:attack-speed');

    // Presentation metadata is used before a bare id where it exists.
    const described = createScrapedItemService({
      pool,
      applySchedules: async () => 'synchronized',
      readCollectionsPaused: async () => false,
      presentation: {
        get: (id) =>
          id === 'mod:furious-assault' ? { name: 'Furious Assault' } : null,
        version: () => '1',
      },
    });
    expect(
      (await described.searchModifiers('furious')).modifiers[0],
    ).toMatchObject({
      id: 'mod:furious-assault',
      name: 'Furious Assault',
      nameSource: 'presentation',
    });
  });

  it('links and unlinks recipes explicitly, with revisions guarding both sides', async () => {
    const shared = (await service.list()).items.find(
      ({ role, recipes }) => role === 'base' && recipes.length > 1,
    );
    if (!shared) throw new Error('Expected a base search shared by recipes');
    const [first, second] = shared.recipes;
    const split = await service.unlink(shared.id, {
      expectedRevision: shared.revision,
      recipeId: second!.id,
    });
    expect(split.item.revision).toBe(shared.revision + 1);
    expect(split.item.recipes.map(({ id }) => id)).not.toContain(second!.id);
    const own = await item('base', second!.id);
    expect(own.id).not.toBe(shared.id);
    expect(own.spec).toEqual(shared.spec);
    // Same requirements still compile to one shared search.
    expect(own.query.key).toBe(shared.query.key);
    await expect(
      service.unlink(shared.id, {
        expectedRevision: shared.revision,
        recipeId: first!.id,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const joined = await service.link(shared.id, {
      expectedRevision: split.item.revision,
      recipeId: second!.id,
    });
    expect(joined.item.recipes.map(({ id }) => id)).toContain(second!.id);
    expect((await item('base', second!.id)).id).toBe(shared.id);
    // Once split off, a recipe is the sole user of its own item.
    const sharedOutput = await item('output', recipeId);
    if (sharedOutput.recipes.length > 1)
      await service.unlink(sharedOutput.id, {
        expectedRevision: sharedOutput.revision,
        recipeId,
      });
    const lone = await item('output', recipeId);
    expect(lone.recipes.map(({ id }) => id)).toEqual([recipeId]);
    await expect(
      service.unlink(lone.id, {
        expectedRevision: lone.revision,
        recipeId,
      }),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'RECIPE_IS_SOLE_USER' }] });
    // A recipe cannot be moved onto an item for a different base.
    const other = (await service.list()).items.find(
      ({ role, baseId }) => role === 'base' && baseId !== shared.baseId,
    );
    if (other)
      await expect(
        service.link(other.id, {
          expectedRevision: other.revision,
          recipeId: first!.id,
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: 'RECIPE_INCOMPATIBLE' }],
      });
  });

  it('serializes concurrent moves of one recipe so every affected item stays consistent', async () => {
    const shared = (await service.list()).items.find(
      ({ role, recipes }) => role === 'base' && recipes.length > 1,
    );
    if (!shared) throw new Error('Expected a base search shared by recipes');
    const mover = shared.recipes[0]!.id;
    // Two more items with the same requirements for the recipe to move onto.
    const copy = async () => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into scraped_items (role, spec, origin)
         select role, spec, 'owner' from scraped_items where id = $1 returning id`,
        [shared.id],
      );
      await pool.query(
        `insert into scraped_item_revisions (item_id, revision, spec, cause)
         select id, revision, spec, 'seed' from scraped_items where id = $1`,
        [rows[0]!.id],
      );
      return rows[0]!.id;
    };
    const first = await copy();
    const second = await copy();
    const before = (await service.list()).items;
    const revisionOf = (id: string) =>
      before.find((candidate) => candidate.id === id)!.revision;
    const authored = scrapedItemDigest(
      'base',
      scrapedItemSpecFromRecipe(
        validateRecipeDocument(
          (await repositories.recipes.listActive()).find(
            ({ id }) => id === mover,
          )!.definition,
        ),
        'base',
      ),
    );

    // Both moves read the recipe's current link before either one commits.
    let arrived = 0;
    const barrier = async () => {
      arrived += 1;
      const deadline = Date.now() + 400;
      while (arrived < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const racing = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property !== 'query') return Reflect.get(target, property);
            return async (...args: unknown[]) => {
              const result = await (
                target.query as (...values: unknown[]) => Promise<unknown>
              )(...args);
              if (
                typeof args[0] === 'string' &&
                args[0].includes('from scraped_item_recipes') &&
                args[0].includes('where recipe_id = $1 and role = $2')
              )
                await barrier();
              return result;
            };
          },
        });
      },
    } as unknown as typeof pool;
    const move = (itemId: string) =>
      linkRecipeToScrapedItem(racing, {
        authoredDigest: authored,
        expectedRevision: revisionOf(itemId),
        itemId,
        recipeId: mover,
      });
    const unlinks = async () =>
      (
        await pool.query<{ n: number }>(
          "select count(*)::int as n from scraped_item_revisions where item_id = $1 and cause = 'unlink'",
          [shared.id],
        )
      ).rows[0]!.n;
    const unlinksBefore = await unlinks();
    const results = await Promise.all([move(first), move(second)]);
    expect(results.map(({ status }) => status)).toEqual(['saved', 'saved']);

    const links = await pool.query<{ itemId: string }>(
      'select item_id as "itemId" from scraped_item_recipes where recipe_id = $1 and role = \'base\'',
      [mover],
    );
    expect(links.rows).toHaveLength(1);
    const final = links.rows[0]!.itemId;
    const lost = final === first ? second : first;
    const history = async (id: string) =>
      (
        await pool.query<{ cause: string; revision: number }>(
          'select cause, revision from scraped_item_revisions where item_id = $1 order by revision',
          [id],
        )
      ).rows;
    // The original item was left exactly once, however the moves interleaved.
    expect(
      (await history(shared.id)).filter(({ cause }) => cause === 'unlink')
        .length,
    ).toBe(unlinksBefore + 1);
    // The item the recipe landed on and the one it left both record it.
    expect((await history(final)).at(-1)).toMatchObject({ cause: 'link' });
    expect((await history(lost)).slice(-2).map(({ cause }) => cause)).toEqual([
      'link',
      'unlink',
    ]);
    // Every stored revision has a history row; nothing changed silently.
    const drift = await pool.query(
      `select i.id from scraped_items i
       where i.revision <> (select max(revision) from scraped_item_revisions r where r.item_id = i.id)`,
    );
    expect(drift.rows).toEqual([]);
  });

  describe('published results follow the configuration', () => {
    const publisher = createCollectorResultPublisher(pool, async () => ({
      maximumQuoteAgeMs: 3_600_000,
      freshnessWarningMs: 1_800_000,
    }));
    const reader = createCollectorResultReader(pool);
    const leagueRow = async () => (await repositories.leagues.findCurrent())!;
    const wrap = (client: PoolClient, afterRead?: () => Promise<void>) =>
      new Proxy(client, {
        get(target, property) {
          if (property !== 'query' || !afterRead)
            return Reflect.get(target, property);
          return async (...args: unknown[]) => {
            const result = await (
              target.query as (...values: unknown[]) => Promise<unknown>
            )(...args);
            // The moment the publisher has read its configuration.
            if (
              typeof args[0] === 'string' &&
              args[0].includes(
                'from scraped_item_recipes l join scraped_items i',
              )
            )
              await afterRead();
            return result;
          };
        },
      });
    async function publish(afterRead?: () => Promise<void>) {
      const league = await leagueRow();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await publisher(
          {
            kind: 'trade-target',
            leagueId: league.id,
            payload: { recipeIds: [recipeId] },
          },
          new Date(),
          wrap(client, afterRead),
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    /** A priced result, as the collector would have published for the old search. */
    async function price() {
      const at = new Date();
      await pool.query(
        'update recipe_results set result = $1::jsonb, evaluated_at = $2 where recipe_id = $3',
        [
          JSON.stringify(
            recipeResultSchema.parse({
              confidence: 'high',
              currency: 'chaos',
              errorCode: null,
              estimatedSalePrice: '100',
              expectedCraftCost: '17',
              marginPercent: '83',
              profit: '83',
              status: 'success',
              methodCost: {
                oldestInputAt: at.toISOString(),
                expiresAt: new Date(at.getTime() + 3_600_000).toISOString(),
                baseCost: { amount: '17', currency: 'chaos' },
                marketStatus: 'priced',
                saleEvidence: { comparableSellers: 3, grade: 'A' },
                budget: null,
              },
            }),
          ),
          at,
          recipeId,
        ],
      );
    }
    const readers = async () =>
      createResourceReaders(
        repositories,
        await loadItemPresentationCatalog(
          fileURLToPath(
            new URL(
              '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
              import.meta.url,
            ),
          ),
        ),
        undefined,
        undefined,
        reader,
        undefined,
        undefined,
        createScrapedItemSpecResolver(pool),
      );
    const shown = async () => {
      const response = await (
        await readers()
      ).readRecipe('00000000-0000-4000-8000-000000000000', recipeId);
      return response.data?.evaluation;
    };
    const valuations = async () =>
      (
        await createCraftAnalysisRepository(
          pool,
          'collector',
        ).readValuationCandidates((await leagueRow()).id)
      ).map(({ recipe_id }) => recipe_id);
    const editOutput = async () => {
      const output = await item('output');
      return service.save(output.id, {
        expectedRevision: output.revision,
        spec: edited(output.spec, (draft) => {
          draft.item.itemLevel = output.spec.item.itemLevel + 1;
        }),
      });
    };

    it('stops serving a priced evaluation once its requirements are edited, until a new capture republishes it', async () => {
      await publish();
      await price();
      expect(
        (await pool.query('select scraped_identity from recipe_results'))
          .rows[0].scraped_identity,
      ).toEqual(expect.stringContaining('output:'));
      expect(await shown()).toMatchObject({
        status: 'success',
        estimatedSalePrice: { amount: 100 },
      });
      expect(await valuations()).toContain(recipeId);

      await editOutput();
      // The old row is still stored, but it priced a different search.
      expect(
        (await pool.query('select count(*)::int as n from recipe_results'))
          .rows[0].n,
      ).toBe(1);
      expect(await reader((await leagueRow()).id, recipeId)).toEqual([]);
      const edited = await shown();
      expect(edited?.status).toBe('loading');
      expect(edited?.estimatedSalePrice ?? null).toBeNull();
      const catalog = await (
        await readers()
      ).readCatalog('00000000-0000-4000-8000-000000000000');
      expect(
        catalog.data?.entries.find(({ recipe }) => recipe.id === recipeId)
          ?.evaluation?.estimatedSalePrice ?? null,
      ).toBeNull();
      expect(await valuations()).not.toContain(recipeId);

      // A publication after the edit is computed from the new requirements and is current.
      await publish();
      expect(await reader((await leagueRow()).id, recipeId)).toHaveLength(1);
    });

    it('never serves a result published by an edit that raced it', async () => {
      // The edit lands after the publisher read its configuration but before it wrote.
      await publish(async () => {
        await editOutput();
      });
      expect(
        (await pool.query('select count(*)::int as n from recipe_results'))
          .rows[0].n,
      ).toBe(1);
      expect(await reader((await leagueRow()).id, recipeId)).toEqual([]);
      // The next publication sees the edit and is current again.
      await publish();
      expect(await reader((await leagueRow()).id, recipeId)).toHaveLength(1);
    });

    it('keeps a result from before configuration existed only while its recipe is unedited', async () => {
      await publish();
      await price();
      await pool.query('update recipe_results set scraped_identity = null');
      expect(await reader((await leagueRow()).id, recipeId)).toHaveLength(1);
      expect(await shown()).toMatchObject({ status: 'success' });
      await editOutput();
      // Never relabelled as the current search's result.
      expect(await reader((await leagueRow()).id, recipeId)).toEqual([]);
      expect(
        (await pool.query('select scraped_identity from recipe_results'))
          .rows[0].scraped_identity,
      ).toBeNull();
    });
  });

  describe('selected-item tests', () => {
    const stops: AbortController[] = [];
    const workers: Promise<void>[] = [];
    afterEach(async () => {
      stops.splice(0).forEach((stop) => stop.abort());
      await Promise.all(workers.splice(0));
    });

    function collect(
      handle: (
        job: { id: string },
        signal: AbortSignal,
      ) => Promise<CollectorResult>,
      now = () => new Date(),
    ) {
      const handler = vi.fn(handle);
      const stop = new AbortController();
      stops.push(stop);
      const worker = runCollector({
        pool,
        signal: stop.signal,
        handlers: {
          'trade-target': handler,
          economy: handler,
          league: handler,
          retention: handler,
        },
        jitterMs: () => 0,
        now,
        maxIdleMs: 200,
      });
      workers.push(worker);
      return { handler, worker };
    }
    const success = (reportedTotal = 3): CollectorResult => ({
      status: 'success',
      capture: {
        capturedAt: new Date(),
        reportedTotal,
        fetched: reportedTotal,
        complete: true,
        slices: 1,
        durationMs: 5,
        listings: Array.from({ length: reportedTotal }, (_, index) => ({
          itemId: `listing-${index}`,
          seller: `seller-${index}`,
          fingerprint: null,
          price: { amount: '10', currency: 'chaos' },
          priceChaos: '10',
          indexedAt: new Date(),
          item: {
            baseType: 'Large Cluster Jewel',
            rarity: 'rare',
            league: 'FixtureGGG',
            patch,
            itemLevel: 84,
            modsComplete: true,
            mods: [],
          },
        })),
      },
    });
    const later = () =>
      pool.query(
        "update collector_schedule set next_due_at = now() + interval '1 day'",
      );

    // Admit the requested targets and advance past shared pacing between captures.
    async function admitSlots(keys: string[]) {
      await pool.query(
        'update collector_schedule set next_due_at = now() where key = any($1)',
        [keys],
      );
    }

    it('runs only the selected search and ties the result to that request, item revision and capture', async () => {
      await later();
      const output = await item('output');
      const test = await service.startTest(output.id, {
        expectedRevision: output.revision,
      });
      expect(test).toMatchObject({
        itemId: output.id,
        itemRevision: 1,
        scheduleKey: output.query.key,
      });
      const row = await pool.query(
        'select scope, recipe_id, state from run_requests where id = $1',
        [test.requestId],
      );
      expect(row.rows[0]).toEqual({
        scope: 'item',
        recipe_id: null,
        state: 'queued',
      });
      // The same submission is the same request; another item gets its own.
      expect(
        (await service.startTest(output.id, { expectedRevision: 1 })).requestId,
      ).toBe(test.requestId);
      const base = await item('base');
      const other = await service.startTest(base.id, {
        expectedRevision: base.revision,
      });
      expect(other.requestId).not.toBe(test.requestId);
      expect(await service.readTest(output.id, test.requestId)).toMatchObject({
        state: 'queued',
        capture: null,
      });
      await expect(
        service.readTest(base.id, test.requestId),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_NOT_FOUND' });

      let clock = Date.now();
      await admitSlots([output.query.key!, base.query.key!]);
      const { handler } = collect(
        async () => {
          clock += 60 * 60_000;
          return success(3);
        },
        () => new Date(clock),
      );
      await vi.waitFor(
        async () => {
          expect(
            (await service.readTest(output.id, test.requestId)).state,
          ).toBe('succeeded');
          expect((await service.readTest(base.id, other.requestId)).state).toBe(
            'succeeded',
          );
        },
        { timeout: 20_000 },
      );
      const keys = await pool.query<{ key: string }>(
        'select key from collector_schedule where id = any($1)',
        [handler.mock.calls.map(([job]) => job.id)],
      );
      expect(keys.rows.map(({ key }) => key).sort()).toEqual(
        [output.query.key!, base.query.key!].sort(),
      );
      const result = await service.readTest(output.id, test.requestId);
      expect(result).toMatchObject({
        itemRevision: 1,
        currentRevision: 1,
        stale: false,
        reason: null,
      });
      // Collection and comparability are reported separately.
      expect(result.capture).toMatchObject({
        reportedTotal: 3,
        fetched: 3,
        coverage: 'complete',
        partialReason: null,
        queryVersion: output.query.key,
        listings: { stored: 3, priced: 3, completeItems: 3, matched: 0 },
        listingsUnavailable: null,
      });
      expect(result.capture!.reasons.length).toBeGreaterThan(0);
      expect((await service.readLatestCapture(output.id))?.captureId).toBe(
        result.capture!.captureId,
      );

      // An edit makes the old result history, never the current one.
      stops.at(-1)!.abort();
      await workers.at(-1);
      const edit = await service.save(output.id, {
        expectedRevision: 1,
        spec: edited(output.spec, (draft) => {
          draft.item.itemLevel = 90;
        }),
      });
      expect(await service.readTest(output.id, test.requestId)).toMatchObject({
        stale: true,
        currentRevision: 2,
        itemRevision: 1,
      });
      expect(edit.item.latestCapture).toBeNull();
    }, 60_000);

    describe('persisted market admin switches', () => {
      const configure = async (change: Record<string, boolean>) => {
        const store = createMarketAdminStore({
          pool,
          defaults: defaultAdminSettings({
            refreshCron: '*/10 * * * *',
            requestTimeoutMs: 10_000,
            concurrency: 1,
            snapshotTtlMs: 60_000,
          }),
          timezone: 'UTC',
          concurrencyLimit: 4,
        });
        await store.init();
        const { version } = await store.read();
        await store.patch({ version, settings: change }, 'test');
      };
      const makeTradeDue = async () => {
        await later();
        await pool.query(
          "update collector_schedule set next_due_at = now() - interval '1 minute' where kind = 'trade-target'",
        );
      };
      const startedKeys = async () =>
        (
          await pool.query<{ key: string }>(
            'select key from collector_schedule where last_started_at is not null',
          )
        ).rows.map(({ key }) => key);
      const stopWorker = async () => {
        stops.at(-1)!.abort();
        await workers.at(-1);
      };
      beforeEach(() => pool.query('delete from market_admin_settings'));
      afterEach(() => pool.query('delete from market_admin_settings'));

      it('runs a manual item test when periodic collection is off, and nothing else', async () => {
        await configure({
          automaticRefreshEnabled: false,
          scheduledCollectionEnabled: false,
        });
        await makeTradeDue();
        const output = await item('output');
        const test = await service.startTest(output.id, {
          expectedRevision: output.revision,
        });
        const { handler } = collect(async () => success(3));
        await vi.waitFor(
          async () =>
            expect(
              (await service.readTest(output.id, test.requestId)).state,
            ).toBe('succeeded'),
          { timeout: 20_000 },
        );
        await stopWorker();
        expect(handler).toHaveBeenCalledTimes(1);
        const result = await service.readTest(output.id, test.requestId);
        expect(result).toMatchObject({
          requestId: test.requestId,
          itemRevision: output.revision,
          scheduleKey: output.query.key,
        });
        expect(result.capture?.queryVersion).toBe(output.query.key);
        expect(await startedKeys()).toEqual([output.query.key]);
      }, 60_000);

      it.each(['collectionsPaused', 'manualRefreshEnabled'] as const)(
        'interrupts the selected active item when %s stops manual collection',
        async (flag) => {
          await configure({
            automaticRefreshEnabled: false,
            scheduledCollectionEnabled: false,
          });
          await makeTradeDue();
          const output = await item('output');
          const test = await service.startTest(output.id, {
            expectedRevision: output.revision,
          });
          const { handler } = collect(
            async (_, signal) =>
              new Promise<CollectorResult>((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                });
              }),
          );
          await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
          await configure({ [flag]: flag === 'collectionsPaused' });
          await vi.waitFor(async () =>
            expect(
              (await service.readTest(output.id, test.requestId)).state,
            ).toBe('failed'),
          );
          await stopWorker();
          expect(
            await service.readTest(output.id, test.requestId),
          ).toMatchObject({
            itemRevision: output.revision,
            scheduleKey: output.query.key,
            reason: 'MARKET_COLLECTION_PAUSED',
            capture: null,
          });
          expect(handler).toHaveBeenCalledTimes(1);
          expect(await startedKeys()).toEqual([output.query.key]);
        },
        60_000,
      );

      it.each(['collectionsPaused', 'manualRefreshEnabled'] as const)(
        'blocks a queued manual item test once %s stops it',
        async (flag) => {
          await configure({
            automaticRefreshEnabled: false,
            scheduledCollectionEnabled: false,
          });
          await makeTradeDue();
          const output = await item('output');
          const test = await service.startTest(output.id, {
            expectedRevision: output.revision,
          });
          await configure({ [flag]: flag === 'collectionsPaused' });
          const { handler } = collect(async () => success(3));
          await vi.waitFor(
            async () =>
              expect(['queued', 'running']).not.toContain(
                (await service.readTest(output.id, test.requestId)).state,
              ),
            { timeout: 20_000 },
          );
          await stopWorker();
          const result = await service.readTest(output.id, test.requestId);
          expect(result.state).toBe('blocked');
          expect(result.reason).toBe('COLLECTOR_NO_ELIGIBLE_TARGETS');
          expect(result).toMatchObject({
            requestId: test.requestId,
            itemRevision: output.revision,
            scheduleKey: output.query.key,
            capture: null,
          });
          expect(handler).not.toHaveBeenCalled();
          expect(await startedKeys()).toEqual([]);
        },
        60_000,
      );
    });

    it('reads capture facts and overwritten listings from the same database snapshot', async () => {
      const output = await item('output');
      const scheduleId = (
        await pool.query<{ id: string }>(
          'select id from collector_schedule where key = $1',
          [output.query.key],
        )
      ).rows[0]!.id;
      const write = async (at: Date) => {
        const result = success(3);
        if (result.status !== 'success' || !result.capture)
          throw new Error('Missing fixture capture');
        const client = await pool.connect();
        try {
          await client.query('begin');
          const id = await writeCaptureInTransaction(client, {
            ...result.capture,
            capturedAt: at,
            scheduleId,
          });
          await client.query('commit');
          return id;
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      };
      const at = new Date(Date.now() - 1_000);
      const firstId = await write(at);
      let replaced = false;
      const racing = new Proxy(pool, {
        get(target, property) {
          if (property !== 'connect') return Reflect.get(target, property);
          return async (...args: unknown[]) => {
            if (args.length)
              return (target.connect as (...values: unknown[]) => unknown)(
                ...args,
              );
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key !== 'query') return Reflect.get(connection, key);
                return async (...query: unknown[]) => {
                  const result = await (
                    connection.query as (
                      ...values: unknown[]
                    ) => Promise<unknown>
                  )(...query);
                  if (
                    !replaced &&
                    typeof query[0] === 'string' &&
                    query[0].includes('as "latestId"')
                  ) {
                    replaced = true;
                    await write(new Date(at.getTime() + 1));
                  }
                  return result;
                };
              },
            });
          };
        },
      });
      const reader = createScrapedItemService({
        pool: racing,
        applySchedules: async () => 'deferred',
        readCollectionsPaused: async () => false,
      });
      const report = await reader.readLatestCapture(output.id);
      expect(replaced).toBe(true);
      expect(report).toMatchObject({
        captureId: firstId,
        fetched: 3,
        listings: { stored: 3, priced: 3 },
        listingsUnavailable: null,
      });
      expect((await service.readLatestCapture(output.id))!.captureId).not.toBe(
        firstId,
      );
    });

    it('keeps one request per search when a league change gives the same item and revision another query', async () => {
      await later();
      const output = await item('output');
      const first = await service.startTest(output.id, {
        expectedRevision: output.revision,
      });
      expect(first.scheduleKey).toBe(output.query.key);
      // Nothing about the item changes, only the league its search is compiled for.
      const other = await repositories.leagues.upsert({
        endAt: null,
        game: 'poe1',
        gggId: 'OtherGGG',
        isCurrent: false,
        metadata: {},
        name: 'Other league',
        realm: 'pc',
        startAt: null,
        syncedAt: new Date(),
      });
      await repositories.leagues.setCurrent(other.id, new Date());
      expect(
        await synchronizeCollectorSchedules(
          pool,
          loadCollectorScheduleConfig(),
        ),
      ).toBe('synchronized');
      await later();
      const moved = await item('output');
      expect(moved.revision).toBe(output.revision);
      expect(moved.query.key).not.toBe(output.query.key);

      const second = await service.startTest(moved.id, {
        expectedRevision: moved.revision,
      });
      expect(second.requestId).not.toBe(first.requestId);
      // The persisted row, not a combination of the old id and the new key.
      expect(second).toMatchObject({
        itemId: moved.id,
        itemRevision: moved.revision,
        scheduleKey: moved.query.key,
      });
      expect(
        (
          await pool.query(
            'select schedule_key from run_requests where id = $1',
            [first.requestId],
          )
        ).rows[0],
      ).toEqual({ schedule_key: output.query.key });
      // Submitting the current search again is still the same request.
      expect(
        (
          await service.startTest(moved.id, {
            expectedRevision: moved.revision,
          })
        ).requestId,
      ).toBe(second.requestId);
      // The first test was for a search that is no longer the item's, though its revision is.
      expect(await service.readTest(output.id, first.requestId)).toMatchObject({
        itemRevision: moved.revision,
        currentRevision: moved.revision,
        currentScheduleKey: moved.query.key,
        scheduleKey: output.query.key,
        stale: true,
      });
      expect((await service.readTest(output.id, second.requestId)).stale).toBe(
        false,
      );
    }, 60_000);

    it('reports a provider block as blocked and a recipe run as a different, two-search request', async () => {
      await later();
      const output = await item('output');
      const test = await service.startTest(output.id, {
        expectedRevision: output.revision,
      });
      let outcome: CollectorResult = {
        status: 'blocked',
        reason: 'PROVIDER_CHALLENGE',
      };
      let clock = Date.now();
      await admitSlots([output.query.key!]);
      const { handler } = collect(
        async () => {
          clock += 60 * 60_000;
          return outcome;
        },
        () => new Date(clock),
      );
      await vi.waitFor(
        async () =>
          expect(
            (await service.readTest(output.id, test.requestId)).state,
          ).toBe('blocked'),
        { timeout: 20_000 },
      );
      expect(await service.readTest(output.id, test.requestId)).toMatchObject({
        reason: 'PROVIDER_CHALLENGE',
        capture: null,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      // The existing recipe-scoped run still refreshes both its base and output.
      const calls = handler.mock.calls.length;
      await pool.query('delete from run_requests');
      await pool.query(
        "update collector_schedule set last_status = null, attempt = 0, retry_at = null, next_due_at = now() + interval '1 day', leased_until = null, enabled = enabled",
      );
      await pool.query(
        'update collector_state set blocked_reason = null where id = 1',
      );
      outcome = success(1);
      await admitSlots([output.query.key!, (await item('base')).query.key!]);
      const recipeRun = await enqueueRunRequest(pool, recipeId);
      await vi.waitFor(
        async () =>
          expect(
            (
              await pool.query(
                'select state, summary from run_requests where id = $1',
                [recipeRun],
              )
            ).rows[0]!.state,
          ).toBe('done'),
        { timeout: 20_000 },
      );
      expect(handler.mock.calls.length - calls).toBe(2);
    }, 60_000);

    it('refuses to test while collection is paused or the search is not scheduled', async () => {
      const output = await item('output');
      paused = true;
      await expect(
        service.startTest(output.id, { expectedRevision: output.revision }),
      ).rejects.toMatchObject({ code: 'MARKET_COLLECTION_PAUSED' });
      paused = false;
      await expect(
        service.startTest(output.id, { expectedRevision: 99 }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
      await pool.query('update collector_schedule set enabled = false');
      await pool.query('delete from collector_schedule where kind = $1', [
        'league',
      ]);
      await expect(
        service.startTest(output.id, { expectedRevision: output.revision }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: 'SEARCH_NOT_SCHEDULED' }],
      });
    });
  });

  describe('HTTP API', () => {
    const api = buildApi(
      pino({ level: 'silent' }),
      async () => undefined,
      async () => ({ active: null, published: null }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { scrapedItems: service, collectorPool: pool },
    );
    afterAll(() => api.close());

    it('lists, saves, rejects and conflicts with typed responses', async () => {
      const listed = await api.inject({
        method: 'GET',
        url: '/api/settings/scraped-items',
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const output = listed
        .json()
        .data.items.find(
          ({ role, recipes }: { role: string; recipes: { id: string }[] }) =>
            role === 'output' && recipes.some(({ id }) => id === recipeId),
        );
      const url = `/api/settings/scraped-items/${output.id}`;
      const invalid = await api.inject({
        method: 'PUT',
        url,
        payload: {
          expectedRevision: output.revision,
          spec: {
            ...output.spec,
            conditions: [{ kind: 'explicit', modId: 'x', excluded: true }],
          },
        },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json().data).toMatchObject({ status: 'rejected' });
      const saved = await api.inject({
        method: 'PUT',
        url,
        payload: {
          expectedRevision: output.revision,
          spec: {
            ...output.spec,
            item: { ...output.spec.item, itemLevel: 87 },
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().data).toMatchObject({
        schedule: 'synchronized',
        item: { revision: 2 },
      });
      const stale = await api.inject({
        method: 'PUT',
        url,
        payload: { expectedRevision: output.revision, spec: output.spec },
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (
          await api.inject({
            method: 'GET',
            url: '/api/settings/scraped-items/not-a-uuid/capture',
          })
        ).statusCode,
      ).toBe(400);
      const modifiers = await api.inject({
        method: 'GET',
        url: '/api/settings/scraped-items/modifiers?q=furious',
      });
      expect(modifiers.json().data.modifiers[0]).toMatchObject({
        id: 'mod:furious-assault',
        tradeMapped: true,
      });
    });
  });
});
