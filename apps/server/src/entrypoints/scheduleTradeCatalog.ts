import type { MarketTarget } from '@poe-worksmith/contracts';
import {
  clusterJewelVariantFilter,
  mappedTargetFilter,
  noVariantFilter,
  recipeSchema,
  RegisteredTradeQueryGenerator,
} from '@poe-worksmith/domain';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { generateMarketTradeQuery } from '../marketTradeQuery.js';
import {
  generateRecipeMarketQuery,
  recipeQueryTarget,
} from '../recipeMarket.js';
import { createPostgresRepositories } from '../repositories/index.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';
import { createPostgresTradeMappingCatalog } from '../tradeMappings.js';

const apply = process.argv.includes('--apply');
const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repositories = createPostgresRepositories(pool);
  const league = await repositories.leagues.findCurrent();
  if (!league) throw new Error('TRADE_CATALOG_LEAGUE_UNAVAILABLE');
  const generator = new RegisteredTradeQueryGenerator(
    createPostgresTradeMappingCatalog(pool),
    [noVariantFilter, clusterJewelVariantFilter],
    [mappedTargetFilter],
  );
  const recipes = await repositories.recipes.listActive();
  const targets = new Map<string, MarketTarget>();
  const skipped: Array<{ recipeId: string; side: string }> = [];
  for (const starting of [true, false]) {
    for (const recipe of recipes) {
      try {
        const query = await generateRecipeMarketQuery(
          generator,
          recipeSchema.parse(recipe.definition),
          league.name,
          starting,
        );
        const target = recipeQueryTarget(query.query.handbookTarget);
        generateMarketTradeQuery(target);
        targets.set(target.digest, target);
      } catch {
        skipped.push({
          recipeId: recipe.id,
          side: starting ? 'base' : 'output',
        });
      }
    }
  }

  const research = createMarketResearchRepository(pool);
  const now = new Date();
  const intervalMinutes = 120;
  let scheduled = 0;
  if (apply) {
    for (const target of targets.values()) {
      const saved = await research.saveTarget(target);
      const updatedAt = now.toISOString();
      const nextRunAt = new Date(
        now.getTime() + scheduled * 2 * 60_000,
      ).toISOString();
      const settings = {
        targetId: saved.id,
        enabled: true,
        paused: false,
        intervalMinutes,
        nextRunAt,
        updatedAt,
      };
      const result = await pool.query(
        `insert into market_collection_settings
          (target_id, enabled, paused, interval_minutes, next_run_at, updated_at, payload)
         values ($1, true, false, $2, $3, $4, $5)
         on conflict (target_id) do nothing`,
        [
          saved.id,
          intervalMinutes,
          nextRunAt,
          updatedAt,
          JSON.stringify(settings),
        ],
      );
      scheduled += result.rowCount ?? 0;
    }
  }
  console.log(
    JSON.stringify({
      league: league.name,
      recipes: recipes.length,
      validProfiles: targets.size,
      scheduled,
      skipped,
    }),
  );
} finally {
  await pool.end();
}
