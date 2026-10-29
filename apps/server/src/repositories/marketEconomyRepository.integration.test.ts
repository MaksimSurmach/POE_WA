import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  await pool.query(
    'truncate market_economy_attempts, market_economy_snapshots',
  );
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
    const attempt = {
      id: randomUUID(),
      league: 'Fixture league',
      category: 'BaseType' as const,
      startedAt: new Date('2026-10-02T00:00:00Z').toISOString(),
      completedAt: new Date('2026-10-02T00:00:01Z').toISOString(),
      status: 'succeeded' as const,
      cacheStatus: 'fetched' as const,
      errorCode: null,
      snapshotId: summaries[0]!.id,
    };
    await repository.saveAttempt(attempt);
    expect(await createMarketEconomyRepository(pool).listAttempts()).toEqual([
      attempt,
    ]);
    await repository.saveAttempt({
      ...attempt,
      id: randomUUID(),
      startedAt: '2026-10-01T00:00:00.000Z',
      completedAt: null,
      status: 'running',
      cacheStatus: null,
      snapshotId: null,
    });
    expect((await repository.listAttempts())[1]?.status).toBe('interrupted');
  });

  it('expires raw payload before summary and removes summary after its retention window', async () => {
    const client = new NinjaEconomyClient({
      userAgent: 'Worksmith integration test (contact: tests@example.com)',
      fetch: async () =>
        new Response(
          JSON.stringify({
            lines: [
              { id: 1, name: 'Fixture', detailsId: 'fixture', chaosValue: 8 },
            ],
          }),
        ),
    });
    const { snapshot } = await client.fetchSnapshot({
      league: 'Fixture league',
      category: 'BaseType',
    });
    const saved = await repository.save(
      newStoredEconomySnapshot({
        ...snapshot,
        capturedAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    await repository.cleanup!({
      payloadBefore: new Date('2026-10-02T00:00:00.000Z'),
      snapshotsBefore: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(
      (await repository.list()).find(({ id }) => id === saved.id)
        ?.payloadAvailable,
    ).toBe(false);
    expect(await repository.find(saved.id)).toBeNull();
    await repository.cleanup!({
      payloadBefore: new Date('2026-10-02T00:00:00.000Z'),
      snapshotsBefore: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(await repository.list()).toHaveLength(0);
  });
});
