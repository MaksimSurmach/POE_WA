import type {
  LeagueUpsert,
  PoeLeague,
  Recipe,
  Repositories,
} from '@poe-worksmith/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { poeLeagues, recipes } from '../schema.js';
import { mapRepositoryError, RepositoryNotFoundError } from './errors.js';

type LeagueRow = typeof poeLeagues.$inferSelect;
type RecipeRow = typeof recipes.$inferSelect;

export function createPostgresCatalogRepository(
  pool: Pool,
  collectorClient?: PoolClient,
): Pick<Repositories, 'leagues' | 'recipes'> {
  const collectorDatabase = drizzle({ client: collectorClient ?? pool });

  return {
    leagues: {
      list() {
        return mapRepositoryError('leagues', 'list', async () =>
          (
            await collectorDatabase
              .select()
              .from(poeLeagues)
              .orderBy(desc(poeLeagues.startAt), desc(poeLeagues.createdAt))
          ).map(mapLeague),
        );
      },
      findCurrent() {
        return mapRepositoryError('leagues', 'findCurrent', async () => {
          const [row] = await collectorDatabase
            .select()
            .from(poeLeagues)
            .where(eq(poeLeagues.isCurrent, true))
            .limit(1);
          return row ? mapLeague(row) : null;
        });
      },
      upsert(input: LeagueUpsert) {
        return mapRepositoryError('leagues', 'upsert', async () => {
          const [row] = await collectorDatabase
            .insert(poeLeagues)
            .values({ ...input, metadata: { ...input.metadata } })
            .onConflictDoUpdate({
              target: [poeLeagues.game, poeLeagues.realm, poeLeagues.gggId],
              set: {
                name: input.name,
                syncedAt: input.syncedAt,
                metadata: { ...input.metadata },
                updatedAt: new Date(),
              },
            })
            .returning();
          return mapLeague(row!);
        });
      },
      setCurrent(leagueId: string, switchedAt: Date) {
        return mapRepositoryError('leagues', 'setCurrent', async () => {
          const client = collectorClient ?? (await pool.connect());
          try {
            await client.query('begin');
            const selected = await client.query<LeagueRow>(
              'select id, game, realm, ggg_id as "gggId", name, start_at as "startAt", end_at as "endAt", is_current as "isCurrent", synced_at as "syncedAt", metadata, created_at as "createdAt", updated_at as "updatedAt" from poe_leagues where id = $1 for update',
              [leagueId],
            );
            const row = selected.rows[0];
            if (!row)
              throw new RepositoryNotFoundError('leagues', 'setCurrent');
            if (row.isCurrent) {
              await client.query('commit');
              return mapLeague(row);
            }
            const current = await client.query<LeagueRow>(
              'select id, game, realm, ggg_id as "gggId", name, start_at as "startAt", end_at as "endAt", is_current as "isCurrent", synced_at as "syncedAt", metadata, created_at as "createdAt", updated_at as "updatedAt" from poe_leagues where game = $1 and realm = $2 and is_current = true for update',
              [row.game, row.realm],
            );
            if (current.rows[0] && !current.rows[0].endAt && row.startAt)
              await client.query(
                'update poe_leagues set is_current = false, end_at = $2, updated_at = $2 where id = $1',
                [current.rows[0].id, row.startAt],
              );
            else
              await client.query(
                'update poe_leagues set is_current = false, updated_at = $2 where game = $1 and realm = $3 and is_current = true',
                [row.game, switchedAt, row.realm],
              );
            const updated = await client.query<LeagueRow>(
              'update poe_leagues set is_current = true, updated_at = $2 where id = $1 returning id, game, realm, ggg_id as "gggId", name, start_at as "startAt", end_at as "endAt", is_current as "isCurrent", synced_at as "syncedAt", metadata, created_at as "createdAt", updated_at as "updatedAt"',
              [leagueId, switchedAt],
            );
            await client.query('commit');
            return mapLeague(updated.rows[0]!);
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            if (!collectorClient) client.release();
          }
        });
      },
    },
    recipes: {
      findById(id) {
        return mapRepositoryError('recipes', 'findById', async () => {
          const [row] = await collectorDatabase
            .select()
            .from(recipes)
            .where(eq(recipes.id, id))
            .limit(1);
          return row ? mapRecipe(row) : null;
        });
      },
      listAll() {
        return mapRepositoryError('recipes', 'listAll', async () => {
          const rows = await collectorDatabase
            .select()
            .from(recipes)
            .orderBy(recipes.id);
          return rows.map(mapRecipe);
        });
      },
      listActive(ids) {
        return mapRepositoryError('recipes', 'listActive', async () => {
          const rows = await collectorDatabase
            .select()
            .from(recipes)
            .where(
              and(eq(recipes.active, true), ids && inArray(recipes.id, ids)),
            )
            .orderBy(recipes.title);
          return rows.map(mapRecipe);
        });
      },
      save(recipe) {
        return mapRepositoryError('recipes', 'save', async () => {
          const [row] = await collectorDatabase
            .insert(recipes)
            .values(recipeValues(recipe))
            .onConflictDoUpdate({
              set: { ...recipeValues(recipe), updatedAt: new Date() },
              target: recipes.id,
            })
            .returning();
          if (!row) throw new RepositoryNotFoundError('recipes', 'save');
          return mapRecipe(row);
        });
      },
    },
  };
}

function recipeValues(recipe: Recipe) {
  return {
    ...recipe,
    definition: { ...recipe.definition },
    tags: [...recipe.tags],
  };
}

export function mapRecipe(row: RecipeRow): Recipe {
  return {
    active: row.active,
    category: row.category,
    contentHash: row.contentHash,
    craftMethod: row.craftMethod,
    definition: row.definition,
    gameVersion: row.gameVersion,
    guideMarkdown: row.guideMarkdown,
    id: row.id,
    tags: row.tags,
    title: row.title,
  };
}

function mapLeague(row: LeagueRow): PoeLeague {
  return { ...row, metadata: row.metadata };
}
