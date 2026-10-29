import assert from 'node:assert/strict';

import { createDatabasePool } from '../database.js';
import { loadDatabaseConfig } from '../config.js';
import {
  createMarketTarget,
  type MarketResearchRepository,
} from '../marketResearch.js';
import { marketStarterLibrary } from '../marketStarterLibrary.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';

const builds = new Set(marketStarterLibrary.flatMap(({ builds }) => builds));
assert.equal(marketStarterLibrary.length, 10);
assert.equal(builds.size, 5);

const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repository: MarketResearchRepository =
    createMarketResearchRepository(pool);
  for (const input of marketStarterLibrary)
    await repository.saveTarget(createMarketTarget(input));
  const saved = await repository.listTargets();
  const seeded = saved.filter((target) => builds.has(target.builds[0] ?? ''));
  assert.equal(seeded.length, 10);
  console.log(
    `Market starter library ready: ${seeded.length} profiles across ${builds.size} builds.`,
  );
} finally {
  await pool.end();
}
