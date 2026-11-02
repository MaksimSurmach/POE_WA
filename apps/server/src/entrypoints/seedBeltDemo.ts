import { beltDemoFixture } from '../beltDemoFixture.js';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import {
  createImportedMarketSnapshot,
  createMarketTarget,
} from '../marketResearch.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';

const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repo = createMarketResearchRepository(pool);
  const fixture = beltDemoFixture();
  const target = await repo.saveTarget(createMarketTarget(fixture.target));
  const snapshot = await repo.saveSnapshot(
    createImportedMarketSnapshot(fixture.observation(target.id), target),
  );
  console.log(
    `Synthetic DEMO ready: target ${target.id}, snapshot ${snapshot.id}.`,
  );
} finally {
  await pool.end();
}
