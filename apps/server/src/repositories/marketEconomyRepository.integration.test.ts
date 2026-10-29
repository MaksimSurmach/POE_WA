import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { newStoredEconomySnapshot } from '../marketEconomy.js';
import { NinjaEconomyClient } from '../providers/ninjaEconomy.js';
import { createMarketEconomyRepository } from './marketEconomyRepository.js';

const config = loadDatabaseConfig();
const databaseUrl = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  databaseUrl.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    databaseUrl.hostname,
  )
) {
  throw new Error(
    'Economy integration tests require the isolated local poe_worksmith_test database',
  );
}
const pool = createDatabasePool(config);
const repository = createMarketEconomyRepository(pool);
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('truncate market_economy_snapshots');
});

describe('persistent economy observations', () => {
  it('deduplicates concurrent repeated evidence and keeps later observations across repository instances', async () => {
    const raw = {
      lines: [
        {
          id: 1,
          name: 'Fixture base',
          detailsId: 'fixture-base',
          chaosValue: 8,
        },
      ],
    };
    const client = new NinjaEconomyClient({
      userAgent: 'Worksmith integration test (contact: tests@example.com)',
      now: () => new Date('2026-10-01T00:00:00Z'),
      fetch: async () => new Response(JSON.stringify(raw)),
    });
    const { snapshot } = await client.fetchSnapshot({
      league: 'Fixture league',
      category: 'BaseType',
    });
    await repository.assertReady();
    const [first, repeated] = await Promise.all([
      repository.save(newStoredEconomySnapshot(snapshot)),
      createMarketEconomyRepository(pool).save(
        newStoredEconomySnapshot(snapshot),
      ),
    ]);
    expect(repeated.id).toBe(first.id);
    expect(
      (await createMarketEconomyRepository(pool).find(first.id))?.raw,
    ).toEqual(raw);
    await repository.save(
      newStoredEconomySnapshot({
        ...snapshot,
        capturedAt: '2026-10-02T00:00:00.000Z',
      }),
    );
    const summaries = await repository.list();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.capturedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(summaries[0]).not.toHaveProperty('raw');
    expect(summaries[0]).not.toHaveProperty('lines');
  });
});
