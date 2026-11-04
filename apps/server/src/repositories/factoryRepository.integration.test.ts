import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  factoryBatchSchema,
  factoryEventSchema,
  type FactoryEvent,
} from '@poe-worksmith/domain';
import { fixtureRecipe } from '@poe-worksmith/domain/fixtures';
import { loadDatabaseConfig } from '../config.js';
import { createDatabasePool } from '../database.js';
import { createPostgresRepositories } from './postgresRepositories.js';
import { createFactoryRepository } from './factoryRepository.js';
import { craftRequestHash } from './craftAnalysisRepository.js';
const config = loadDatabaseConfig();
const address = new URL(config.connectionString);
if (
  config.environment !== 'test' ||
  address.pathname !== '/poe_worksmith_test' ||
  !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(
    address.hostname,
  )
)
  throw new Error(
    'Factory integration requires isolated local poe_worksmith_test',
  );
const pool = createDatabasePool(config),
  repositories = createPostgresRepositories(pool),
  repository = createFactoryRepository(pool);
const at = '2026-11-04T12:00:00.000Z';
let leagueId: string;
const tx = (
  unitPrice: string,
  quantity = '1',
  currency: 'chaos' | 'divine' = 'chaos',
  chaosPerUnit = '1',
) => ({
  quantity,
  unitPrice,
  currency,
  chaosPerUnit,
  rateSource: 'synthetic transaction rate',
});
function event(payload: unknown) {
  return factoryEventSchema.parse({
    id: randomUUID(),
    occurredAt: at,
    source: 'synthetic:factory-test',
    notes: '',
    payload,
  });
}
async function batch() {
  const document = factoryBatchSchema.parse({
    id: randomUUID(),
    recipeId: 'factory-test',
    recipeHash: 'factory-revision',
    targetSignature: 'synthetic-target',
    leagueId,
    league: 'Factory Test League',
    accountingCurrency: 'chaos',
    startedAt: at,
    plannedBudget: tx('1000'),
    notes: 'Synthetic scenario',
    forecast: null,
  });
  return repository.create(
    document,
    randomUUID(),
    craftRequestHash(document),
    at,
  );
}
beforeEach(async () => {
  await pool.query('truncate factory_mutations,factory_events,factory_batches');
  await repositories.recipes.save({
    id: 'factory-test',
    active: true,
    category: 'cluster-jewel',
    contentHash: 'factory-revision',
    craftMethod: 'synthetic',
    definition: { ...fixtureRecipe() },
    gameVersion: 'fixture',
    guideMarkdown: '',
    title: 'Factory fixture',
    tags: [],
  });
  const league = await repositories.leagues.upsert({
    gggId: 'Factory Test League',
    name: 'Factory Test League',
    game: 'poe1',
    realm: 'pc',
    startAt: null,
    endAt: null,
    isCurrent: false,
    metadata: {},
    syncedAt: new Date(at),
  });
  leagueId = league.id;
});
afterAll(async () => pool.end());
describe('PostgreSQL factory transaction integrity', () => {
  it('creates one immutable batch for concurrent retries and preserves timestamps on an older read clock', async () => {
    const original = await batch();
    const document = { ...original.batch, id: randomUUID() };
    const key = randomUUID();
    const hash = craftRequestHash(document);
    const [a, b] = await Promise.all([
      repository.create(document, key, hash, at),
      repository.create(document, key, hash, at),
    ]);
    expect(a.batch.id).toBe(b.batch.id);
    const later = '2026-11-04T12:01:00.000Z';
    const entry = {
      ...event({ type: 'note', text: 'Concurrent commit' }),
      occurredAt: later,
    };
    await repository.append(a.batch.id, 0, entry, randomUUID(), later);
    const read = await repository.get(a.batch.id, at);
    expect(read.projection.asOf).toBe(later);
    expect(read.version).toBe(1);
    await expect(
      repository.create(
        { ...document, notes: 'changed' },
        key,
        craftRequestHash({ different: true }),
        at,
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
  });

  it('serializes identical concurrent retries and rejects global key reuse with changed payload', async () => {
    const original = await batch();
    const key = randomUUID();
    const purchase = event({
      type: 'purchase',
      resourceId: 'essence',
      transaction: tx('2', '10'),
    });
    const [a, b] = await Promise.all([
      repository.append(original.batch.id, 0, purchase, key, at),
      repository.append(original.batch.id, 0, purchase, key, at),
    ]);
    expect(a).toEqual(b);
    expect(a.version).toBe(1);
    await expect(
      repository.append(
        original.batch.id,
        0,
        event({ type: 'note', text: 'different' }),
        key,
        at,
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const second = await batch();
    await expect(
      repository.append(second.batch.id, 0, purchase, key, at),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    expect((await repository.get(original.batch.id, at)).events).toHaveLength(
      1,
    );
  });
  it('rejects concurrent overspending, over-allocation and duplicate sales without changing history', async () => {
    let current = await batch();
    const add = async (e: FactoryEvent) =>
      (current = await repository.append(
        current.batch.id,
        current.version,
        e,
        randomUUID(),
        at,
      ));
    const purchase = event({
      type: 'purchase',
      resourceId: 'base',
      transaction: tx('10', '2'),
    });
    await add(purchase);
    const concurrent = await Promise.allSettled(
      [1, 2].map(() =>
        repository.append(
          current.batch.id,
          current.version,
          event({
            type: 'consume',
            purchaseEventId: purchase.id,
            quantity: '2',
          }),
          randomUUID(),
          at,
        ),
      ),
    );
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    current = await repository.get(current.batch.id, at);
    const consumption = current.events[1]!;
    await expect(
      add(
        event({ type: 'consume', purchaseEventId: purchase.id, quantity: '1' }),
      ),
    ).rejects.toThrow('Insufficient');
    const itemId = randomUUID();
    await add(
      event({
        type: 'produce',
        itemId,
        description: 'Target',
        modifiers: [],
        outcome: 'target',
        allocations: [{ costEventId: consumption.id, amount: '20' }],
      }),
    );
    await expect(
      add(
        event({
          type: 'produce',
          itemId: randomUUID(),
          description: 'Impossible',
          modifiers: [],
          outcome: 'salvage',
          allocations: [{ costEventId: consumption.id, amount: '1' }],
        }),
      ),
    ).rejects.toThrow('exceeds');
    await add(
      event({ type: 'sale', itemId, transaction: tx('30'), expenses: [] }),
    );
    await expect(
      add(event({ type: 'sale', itemId, transaction: tx('30'), expenses: [] })),
    ).rejects.toThrow('immutable');
    expect((await repository.get(current.batch.id, at)).version).toBe(4);
  });
  it('preserves partial sales, original FX and corrections across repository restart', async () => {
    let current = await batch();
    const add = async (e: FactoryEvent) =>
      (current = await repository.append(
        current.batch.id,
        current.version,
        e,
        randomUUID(),
        at,
      ));
    const expense = event({
      type: 'expense',
      category: 'crafting',
      transaction: tx('1', '1', 'divine', '100'),
    });
    await add(expense);
    const first = randomUUID(),
      second = randomUUID();
    for (const itemId of [first, second])
      await add(
        event({
          type: 'produce',
          itemId,
          description: 'Result',
          modifiers: [],
          outcome: 'salvage',
          allocations: [{ costEventId: expense.id, amount: '50' }],
        }),
      );
    const sale = event({
      type: 'sale',
      itemId: first,
      transaction: tx('1', '1', 'divine', '120'),
      expenses: [tx('5')],
    });
    await add(sale);
    expect(current.projection.metrics).toMatchObject({
      realizedProfit: '65',
      cashFlow: '15',
      inventoryCost: '50',
      soldCount: 1,
      productionCost: '100',
    });
    const restarted = createFactoryRepository(pool);
    expect((await restarted.get(current.batch.id, at)).projection).toEqual(
      current.projection,
    );
    await expect(
      add(
        event({
          type: 'void',
          eventId: expense.id,
          reason: 'Invalid dependency removal',
        }),
      ),
    ).rejects.toThrow('unknown cost');
    await add(
      event({
        type: 'void',
        eventId: sale.id,
        reason: 'Sale entered incorrectly',
      }),
    );
    expect(current.events).toHaveLength(5);
    expect(current.projection.metrics).toMatchObject({
      realizedProfit: '0',
      cashFlow: '-100',
      inventoryCost: '100',
      soldCount: 0,
    });
  });
  it('returns resources and refunds only available material; keeps retry response at original version', async () => {
    let current = await batch();
    const add = async (e: FactoryEvent) =>
      (current = await repository.append(
        current.batch.id,
        current.version,
        e,
        randomUUID(),
        at,
      ));
    const purchase = event({
      type: 'purchase',
      resourceId: 'currency',
      transaction: tx('5', '10'),
    });
    const key = randomUUID();
    current = await repository.append(current.batch.id, 0, purchase, key, at);
    const consume = event({
      type: 'consume',
      purchaseEventId: purchase.id,
      quantity: '6',
    });
    await add(consume);
    await add(
      event({
        type: 'return-material',
        consumeEventId: consume.id,
        quantity: '2',
      }),
    );
    await add(
      event({
        type: 'refund',
        purchaseEventId: purchase.id,
        quantity: '6',
        transaction: tx('30'),
      }),
    );
    expect(current.projection.metrics).toMatchObject({
      cashFlow: '-20',
      productionCost: '20',
      unusedMaterialCost: '0',
    });
    await expect(
      add(
        event({
          type: 'refund',
          purchaseEventId: purchase.id,
          quantity: '1',
          transaction: tx('5'),
        }),
      ),
    ).rejects.toThrow('exceeds');
    const retry = await repository.append(
      current.batch.id,
      0,
      purchase,
      key,
      at,
    );
    expect(retry.version).toBe(1);
    expect(retry.events).toHaveLength(1);
  });
});
