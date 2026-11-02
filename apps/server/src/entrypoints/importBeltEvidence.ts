import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createImportedMarketSnapshot } from '../marketResearch.js';
import { createMarketResearchRepository } from '../repositories/marketResearchRepository.js';

// Explicitly imported manual observations, kept separate from synthetic demo data.
const records = [
  {
    prefix: 'Flicker Strike Slayer — редкий Stygian',
    file: 'max-1287-flicker-trade-2026-10-29.json',
  },
  {
    prefix: 'Winter Orb Elementalist — Stygian',
    file: 'max-1287-winter-orb-trade-2026-10-29.json',
  },
];
const pool = createDatabasePool(loadDatabaseConfig());
try {
  const repo = createMarketResearchRepository(pool);
  const targets = await repo.listTargets();
  for (const record of records) {
    const target = targets.find((entry) =>
      entry.name.startsWith(record.prefix),
    );
    if (!target)
      throw new Error(
        `Missing ${record.prefix}; run market:seed-library first.`,
      );
    const input: unknown = JSON.parse(
      await readFile(
        resolve(process.cwd(), `../../docs/evidence/${record.file}`),
        'utf8',
      ),
    );
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid observation file');
    const snapshot = createImportedMarketSnapshot(
      { ...input, targetId: target.id },
      target,
    );
    const stored = await repo.saveSnapshot(snapshot);
    console.log(`${target.name}: observed snapshot ${stored.id}`);
  }
} finally {
  await pool.end();
}
