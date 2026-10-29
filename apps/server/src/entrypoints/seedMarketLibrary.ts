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
assert.equal(marketStarterLibrary.length, 12);
assert.equal(builds.size, 7);

const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repository: MarketResearchRepository =
    createMarketResearchRepository(pool);
  const seeded = [];
  for (const input of marketStarterLibrary)
    seeded.push(await repository.saveTarget(createMarketTarget(input)));
  assert.equal(
    new Set(seeded.map((target) => target.digest)).size,
    marketStarterLibrary.length,
  );
  console.log(
    `Market starter library ready: ${seeded.length} profiles across ${builds.size} builds.`,
  );
} finally {
  await pool.end();
}
