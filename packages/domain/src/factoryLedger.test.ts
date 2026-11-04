import { describe, expect, it } from 'vitest';
import {
  simulateCraftingRisk,
  riskSimulationRequestSchema,
} from './craftingRisk.js';
import { analyzeOutcomeModel } from './outcomeEconomics.js';
import {
  syntheticOutcomeInput,
  syntheticGeometricInput,
} from './fixtures/outcomes.js';
import {
  factoryBatchSchema,
  factoryEventSchema,
  factoryTransactionSchema,
  projectFactoryBatch,
  summarizeFactoryBatches,
  type FactoryEvent,
} from './factoryLedger.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`;
const tx = (
  quantity: string,
  unitPrice: string,
  currency: 'chaos' | 'divine' = 'chaos',
  chaosPerUnit = '1',
) => ({
  quantity,
  unitPrice,
  currency,
  chaosPerUnit,
  rateSource: 'synthetic:locked-at-transaction',
});
const batch = () =>
  factoryBatchSchema.parse({
    id: id(1),
    recipeId: 'synthetic-recipe',
    recipeHash: 'revision-1',
    targetSignature: 'premium-exact',
    leagueId: id(2),
    league: 'Synthetic League',
    accountingCurrency: 'chaos',
    startedAt: at(4),
    plannedBudget: tx('1', '100'),
    notes: '',
    forecast: null,
  });
const event = (n: number, payload: unknown, day = 4) =>
  factoryEventSchema.parse({
    id: id(n),
    occurredAt: at(day),
    source: 'synthetic:confirmed-test-transaction',
    notes: '',
    payload,
  });
const produce = (
  item: number,
  allocations: { costEventId: string; amount: string }[] = [],
  outcome = 'target',
) => ({
  type: 'produce',
  itemId: id(item),
  description: `Synthetic item ${item}`,
  modifiers: [],
  outcome,
  classification: outcome === 'target' ? 'target' : 'salvage',
  allocations,
});
const golden = (): FactoryEvent[] => [
  event(10, {
    type: 'purchase',
    resourceId: 'essence',
    transaction: tx('10', '2'),
  }),
  event(11, {
    type: 'purchase',
    resourceId: 'base',
    transaction: tx('2', '10'),
  }),
  event(12, { type: 'consume', purchaseEventId: id(10), quantity: '4' }),
  event(13, { type: 'consume', purchaseEventId: id(11), quantity: '2' }),
  event(
    14,
    produce(100, [
      { costEventId: id(12), amount: '4' },
      { costEventId: id(13), amount: '10' },
    ]),
  ),
  event(
    15,
    produce(
      101,
      [
        { costEventId: id(12), amount: '4' },
        { costEventId: id(13), amount: '10' },
      ],
      'salvage-life-tier2',
    ),
  ),
  event(16, {
    type: 'expense',
    category: 'finishing',
    transaction: tx('1', '2'),
  }),
  event(17, {
    type: 'allocate',
    itemId: id(100),
    allocations: [{ costEventId: id(16), amount: '2' }],
  }),
  event(
    18,
    { type: 'list', itemId: id(100), price: tx('1', '0.6', 'divine', '100') },
    5,
  ),
  event(
    19,
    {
      type: 'sale',
      itemId: id(100),
      transaction: tx('1', '0.5', 'divine', '100'),
      expenses: [tx('1', '1')],
    },
    7,
  ),
];
describe('factory ledger — labelled synthetic accounting scenarios', () => {
  it('separates partially sold production, unused materials, cash and realized profit', () => {
    const p = projectFactoryBatch(batch(), golden(), at(8));
    expect(p.metrics).toMatchObject({
      realizedProfit: '33',
      cashFlow: '7',
      grossSpending: '43',
      productionCost: '30',
      inventoryCost: '14',
      unusedMaterialCost: '12',
      soldProductionCost: '16',
      transactionExpenses: '1',
      unallocatedCost: '0',
      producedCount: 2,
      soldCount: 1,
      observedSellThroughPercent: '50',
      meanTimeToSellSeconds: 172800,
    });
    expect(p.inventory[1]?.targetSignature).toBeNull();
    expect(p.inventory[1]?.recipeTargetSignature).toBe('premium-exact');
    expect(p.forecastComparison.status).toBe('unavailable');
  });
  it('locks original FX and preserves original transaction prices through replay', () => {
    const events = golden();
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.sales[0]?.transaction).toEqual(tx('1', '0.5', 'divine', '100'));
    expect(
      projectFactoryBatch(batch(), JSON.parse(JSON.stringify(events)), at(20))
        .metrics.realizedProfit,
    ).toBe('33');
    expect(p.sales[0]?.revenue).toBe('50');
  });
  it('returns unallocated consumption to its stock lot and refunds only available stock', () => {
    const events = golden().slice(0, 4);
    events.push(
      event(20, {
        type: 'return-material',
        consumeEventId: id(12),
        quantity: '2',
      }),
    );
    events.push(
      event(21, {
        type: 'refund',
        purchaseEventId: id(10),
        quantity: '3',
        transaction: tx('1', '5'),
      }),
    );
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics).toMatchObject({
      productionCost: '24',
      unusedMaterialCost: '10',
      cashFlow: '-35',
      realizedProfit: '0',
    });
    expect(p.stock[0]?.quantityAvailable).toBe('5');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...events,
          event(22, {
            type: 'refund',
            purchaseEventId: id(10),
            quantity: '6',
            transaction: tx('1', '12'),
          }),
        ],
        at(8),
      ),
    ).toThrow('Refund exceeds');
  });
  it('keeps recovery credits separate from gross cost and item sale profit', () => {
    const p = projectFactoryBatch(
      batch(),
      [
        ...golden(),
        event(
          20,
          { type: 'credit', category: 'recovery', transaction: tx('1', '3') },
          8,
        ),
      ],
      at(8),
    );
    expect(p.metrics).toMatchObject({
      recoveryCredits: '3',
      cashFlow: '10',
      productionCost: '30',
      realizedProfit: '33',
    });
  });
  it('counts salvage classification rather than assuming an outcome ID', () => {
    const p = projectFactoryBatch(
      batch(),
      [
        ...golden(),
        event(
          20,
          {
            type: 'sale',
            itemId: id(101),
            transaction: tx('1', '5'),
            expenses: [],
          },
          8,
        ),
      ],
      at(8),
    );
    expect(p.metrics).toMatchObject({
      salvageSaleRevenue: '5',
      realizedProfit: '24',
      inventoryCost: '0',
    });
    expect(p.sales[1]?.realizedProfit).toBe('-9');
    expect(p.sales[1]?.targetSignature).toBeNull();
  });
  it('derives actual output signatures and classifications only from their exact outcome', () => {
    const b = batch();
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'premium-exact',
    };
    input.model.stages[0]!.outcomes[1]!.id = 'life-tier2';
    input.model.stages[0]!.outcomes[1]!.matching = {
      kind: 'exact-target',
      targetSignature: 'life-resist-exact',
    };
    b.forecast = {
      sourceId: 'synthetic',
      analysisInput: input,
      analysis: analyzeOutcomeModel(input),
      riskRequest: null,
      riskResult: null,
    };
    const p = projectFactoryBatch(
      b,
      [event(10, produce(100, [])), event(11, produce(101, [], 'life-tier2'))],
      at(8),
    );
    expect(
      p.inventory.map((i) => [i.targetSignature, i.outcomeClassification]),
    ).toEqual([
      ['premium-exact', 'target'],
      ['life-resist-exact', 'salvage'],
    ]);
  });
  it('does not reset listing exposure when an asking price is updated', () => {
    const events = golden().slice(0, 9);
    events.push(
      event(20, { type: 'list', itemId: id(100), price: tx('1', '45') }, 10),
    );
    events.push(
      event(
        21,
        {
          type: 'sale',
          itemId: id(100),
          transaction: tx('1', '45'),
          expenses: [],
        },
        11,
      ),
    );
    expect(
      projectFactoryBatch(batch(), events, at(12)).sales[0]?.timeToSellSeconds,
    ).toBe(6 * 86400);
  });
  it('rejects duplicate sales, event IDs, negative stock and over-allocation', () => {
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden(),
          event(
            20,
            {
              type: 'sale',
              itemId: id(100),
              transaction: tx('1', '50'),
              expenses: [],
            },
            8,
          ),
        ],
        at(8),
      ),
    ).toThrow('immutable');
    expect(() =>
      projectFactoryBatch(batch(), [...golden(), golden()[0]!], at(8)),
    ).toThrow('Duplicate event');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          golden()[0]!,
          event(20, {
            type: 'consume',
            purchaseEventId: id(10),
            quantity: '11',
          }),
        ],
        at(8),
      ),
    ).toThrow('Insufficient');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden().slice(0, 4),
          event(20, produce(100, [{ costEventId: id(12), amount: '9' }])),
        ],
        at(8),
      ),
    ).toThrow('exceeds');
  });
  it('rejects returns of cost already allocated and new sold-item allocations', () => {
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden(),
          event(
            20,
            { type: 'return-material', consumeEventId: id(12), quantity: '1' },
            8,
          ),
        ],
        at(8),
      ),
    ).toThrow('allocated');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden(),
          event(
            20,
            {
              type: 'allocate',
              itemId: id(100),
              allocations: [{ costEventId: id(16), amount: '1' }],
            },
            8,
          ),
        ],
        at(8),
      ),
    ).toThrow('immutable');
  });
  it('corrects a sale through appended void/replacement without rewriting history', () => {
    const events = golden();
    events.push(
      event(
        20,
        { type: 'void', eventId: id(19), reason: 'Wrong confirmed price' },
        8,
      ),
    );
    events.push(
      event(
        21,
        {
          type: 'sale',
          itemId: id(100),
          transaction: tx('1', '0.4', 'divine', '100'),
          expenses: [tx('1', '1')],
        },
        8,
      ),
    );
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics.realizedProfit).toBe('23');
    expect(p.voidedEventIds).toEqual([id(19)]);
    expect(events[9]?.payload.type).toBe('sale');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden(),
          event(
            20,
            {
              type: 'void',
              eventId: id(10),
              reason: 'Invalid dependent purchase removal',
            },
            8,
          ),
        ],
        at(8),
      ),
    ).toThrow('Unknown purchase');
  });
  it('rounds display totals once while keeping exact cost allocation basis', () => {
    const events = [
      event(10, {
        type: 'purchase',
        resourceId: 'tiny',
        transaction: tx('3', '0.3333333333333333'),
      }),
      event(11, { type: 'consume', purchaseEventId: id(10), quantity: '3' }),
      event(
        12,
        produce(100, [{ costEventId: id(11), amount: '0.9999999999999999' }]),
      ),
    ];
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics.productionCost).toBe('1');
    expect(p.metrics.unallocatedCost).toBe('0');
    expect(p.costs[0]?.amount).toBe('0.9999999999999999');
  });
  it('does not invent sale duration, ROI or turnover before observed sales', () => {
    const p = projectFactoryBatch(batch(), golden().slice(0, 8), at(8));
    expect(p.metrics).toMatchObject({
      meanTimeToSellSeconds: null,
      timeToSellSampleSize: 0,
      actualRoiPercent: null,
      observedSellThroughPercent: null,
      profitPerCraftingHour: null,
    });
  });
  it('makes unallocated costs explicit and withholds total ROI', () => {
    const p = projectFactoryBatch(
      batch(),
      [
        ...golden(),
        event(
          20,
          { type: 'expense', category: 'other', transaction: tx('1', '100') },
          8,
        ),
      ],
      at(8),
    );
    expect(p.metrics).toMatchObject({
      unallocatedCost: '100',
      allocationComplete: false,
      actualRoiPercent: null,
    });
    expect(p.warnings[0]).toContain('unallocated');
  });
  it('aggregates realized returns using total sold costs rather than averaging ROI', () => {
    const p = projectFactoryBatch(batch(), golden(), at(8));
    const summary = summarizeFactoryBatches([p, p]);
    expect(summary).toMatchObject({
      realizedProfit: '66',
      soldProductionCost: '32',
      transactionExpenses: '2',
      meanTimeToSellSeconds: 172800,
      soldCount: 2,
      actualRoiPercent: '194.11764706',
    });
  });
  it('validates bounded decimal strings, FX and one-item sale quantities', () => {
    expect(factoryTransactionSchema.safeParse(tx('1', 'NaN')).success).toBe(
      false,
    );
    expect(
      factoryTransactionSchema.safeParse(tx('1', '1', 'chaos', '2')).success,
    ).toBe(false);
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...golden().slice(0, 9),
          event(
            20,
            {
              type: 'sale',
              itemId: id(100),
              transaction: tx('2', '50'),
              expenses: [],
            },
            8,
          ),
        ],
        at(8),
      ),
    ).toThrow('exactly one');
  });
  it('integrates held unit-time through disposal and confirmed sales over an explicit window', () => {
    const events = [
      event(10, produce(100)),
      event(11, produce(101)),
      event(
        12,
        { type: 'item-status', itemId: id(101), status: 'discarded' },
        5,
      ),
      event(
        13,
        {
          type: 'sale',
          itemId: id(100),
          transaction: tx('1', '10'),
          expenses: [],
        },
        6,
      ),
    ];
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics).toMatchObject({
      inventoryUnitSeconds: '259200',
      averageHeldUnits: '0.75',
      observedUnitTurnover: '1.33333333',
      turnoverWindowStart: at(4),
      turnoverWindowEnd: at(8),
    });
    const later = batch();
    later.startedAt = at(8);
    later.id = id(3);
    const p2 = projectFactoryBatch(
      later,
      [
        event(20, produce(102), 8),
        event(
          21,
          {
            type: 'sale',
            itemId: id(102),
            transaction: tx('1', '10'),
            expenses: [],
          },
          10,
        ),
      ],
      at(12),
    );
    expect(summarizeFactoryBatches([p, p2])).toMatchObject({
      inventoryUnitSeconds: '432000',
      averageHeldUnits: '0.625',
      observedUnitTurnover: '3.2',
      turnoverWindowStart: at(4),
      turnoverWindowEnd: at(12),
    });
  });
  it('labels own listed asks separately from allocated cost and confirmed receipts', () => {
    const p = projectFactoryBatch(batch(), golden().slice(0, 9), at(8));
    expect(p.metrics).toMatchObject({
      listedInventoryAskingValue: '60',
      listedInventoryCount: 1,
      inventoryCost: '30',
      saleRevenue: '0',
    });
  });
  it('compares only a closed batch matching its original simulation objective and asset basis', async () => {
    const b = batch();
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes.forEach((o, i) => {
      o.probability.value = i === 0 ? '1' : '0';
    });
    const analysis = analyzeOutcomeModel(input);
    const request = riskSimulationRequestSchema.parse({
      analysis: input,
      objective: { kind: 'attempts', count: 1 },
      seed: 'factory-forecast',
      trials: 100,
      budget: '100',
    });
    const risk = await simulateCraftingRisk(request);
    b.forecast = {
      sourceId: 'frozen-synthetic-risk',
      analysisInput: input,
      analysis,
      riskRequest: request,
      riskResult: risk,
    };
    const events = [
      event(10, {
        type: 'expense',
        category: 'crafting',
        transaction: tx('1', '12'),
      }),
      event(11, produce(100, [{ costEventId: id(10), amount: '12' }])),
      event(12, {
        type: 'sale',
        itemId: id(100),
        transaction: tx('1', '100'),
        expenses: [],
      }),
      event(13, { type: 'activity', attempts: 1, craftingSeconds: 60 }),
      event(14, { type: 'batch-status', status: 'completed' }),
    ];
    expect(
      projectFactoryBatch(b, events, at(8)).forecastComparison,
    ).toMatchObject({
      status: 'comparable',
      expectedCost: '12',
      expectedProfit: '18',
      costDifference: '0',
      profitDifference: '70',
    });
    b.forecast.analysis.unvaluedRetainedBaseProbability = '0.1';
    expect(
      projectFactoryBatch(b, events, at(8)).forecastComparison.status,
    ).toBe('unavailable');
    b.forecast.analysis.unvaluedRetainedBaseProbability = '0';
    b.forecast.riskResult!.objective.count = 2;
    expect(
      projectFactoryBatch(b, events, at(8)).forecastComparison.status,
    ).toBe('unavailable');
  });
  it('rejects backdated lifecycle events before production or the latest listing', () => {
    const produced = event(10, produce(100), 5);
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          produced,
          event(
            11,
            { type: 'item-status', itemId: id(100), status: 'discarded' },
            4,
          ),
        ],
        at(8),
      ),
    ).toThrow('Disposition predates');
    const listed = event(
      11,
      { type: 'list', itemId: id(100), price: tx('1', '10') },
      7,
    );
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          produced,
          listed,
          event(
            12,
            { type: 'item-status', itemId: id(100), status: 'recycled' },
            6,
          ),
        ],
        at(8),
      ),
    ).toThrow('Disposition predates');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          produced,
          listed,
          event(
            12,
            {
              type: 'sale',
              itemId: id(100),
              transaction: tx('1', '10'),
              expenses: [],
            },
            6,
          ),
        ],
        at(8),
      ),
    ).toThrow('Sale predates');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          produced,
          listed,
          event(12, { type: 'list', itemId: id(100), price: tx('1', '9') }, 6),
        ],
        at(8),
      ),
    ).toThrow('Listing predates');
    const valid = projectFactoryBatch(
      batch(),
      [
        produced,
        listed,
        event(
          12,
          { type: 'item-status', itemId: id(100), status: 'discarded' },
          8,
        ),
      ],
      at(8),
    );
    expect(valid.metrics.inventoryUnitSeconds).toBe('259200');
  });
  it('rejects observation windows before the batch or before recorded events', () => {
    expect(() => projectFactoryBatch(batch(), [], at(3))).toThrow(
      'Observation predates batch start',
    );
    expect(() =>
      projectFactoryBatch(batch(), [event(10, produce(100), 5)], at(4)),
    ).toThrow('outside batch observation window');
  });
  it.each(['single-target', 'attempts'] as const)(
    'uses the %s horizon to determine whether a reusable base remains unvalued',
    async (kind) => {
      const b = batch();
      const input = syntheticGeometricInput();
      const analysis = analyzeOutcomeModel(input);
      expect(analysis).toMatchObject({
        expectedTotalCost: '12',
        expectedNetProfit: { min: '13', max: '13' },
        unvaluedRetainedBaseProbability: '0.75',
      });
      const request = riskSimulationRequestSchema.parse({
        analysis: input,
        objective: { kind, count: kind === 'single-target' ? 1 : 4 },
        seed: 'factory-retained-base',
        trials: 100,
        budget: '100',
      });
      const risk = await simulateCraftingRisk(request);
      b.forecast = {
        sourceId: 'synthetic-target-objective',
        analysisInput: input,
        analysis,
        riskRequest: request,
        riskResult: risk,
      };
      const events = [
        event(10, {
          type: 'purchase',
          resourceId: 'base',
          transaction: tx('1', '10'),
        }),
        event(11, {
          type: 'purchase',
          resourceId: 'orb',
          transaction: tx('4', '2'),
        }),
        event(12, { type: 'consume', purchaseEventId: id(10), quantity: '1' }),
        event(13, { type: 'consume', purchaseEventId: id(11), quantity: '4' }),
        event(
          14,
          produce(100, [
            { costEventId: id(12), amount: '10' },
            { costEventId: id(13), amount: '8' },
          ]),
        ),
        event(15, {
          type: 'sale',
          itemId: id(100),
          transaction: tx('1', '100'),
          expenses: [],
        }),
        event(16, { type: 'activity', attempts: 4, craftingSeconds: 60 }),
        event(17, { type: 'batch-status', status: 'completed' }),
      ];
      const comparison = projectFactoryBatch(
        b,
        events,
        at(8),
      ).forecastComparison;
      if (kind === 'single-target')
        expect(comparison).toMatchObject({
          status: 'comparable',
          expectedCost: '18',
          expectedProfit: '82',
          costDifference: '0',
          profitDifference: '0',
        });
      else
        expect(comparison).toMatchObject({
          status: 'unavailable',
          expectedCost: null,
          expectedProfit: null,
        });
    },
  );
  it('keeps sold-item profit while recognizing discarded cost in ROI and crafting-hour result', () => {
    const events = [
      ...golden(),
      event(
        20,
        { type: 'item-status', itemId: id(101), status: 'discarded' },
        8,
      ),
      event(21, { type: 'activity', attempts: 2, craftingSeconds: 3600 }, 8),
    ];
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics).toMatchObject({
      realizedProfit: '33',
      disposedCost: '14',
      recognizedItemResult: '19',
      actualRoiPercent: '61.29032258',
      profitPerCraftingHour: '19',
    });
    expect(summarizeFactoryBatches([p, p])).toMatchObject({
      realizedProfit: '66',
      recognizedItemResult: '38',
      actualRoiPercent: '61.29032258',
      profitPerCraftingHour: '19',
    });
    const brick = projectFactoryBatch(
      batch(),
      [
        event(10, {
          type: 'expense',
          category: 'crafting',
          transaction: tx('1', '14'),
        }),
        event(11, produce(100, [{ costEventId: id(10), amount: '14' }])),
        event(12, {
          type: 'item-status',
          itemId: id(100),
          status: 'discarded',
        }),
        event(13, { type: 'activity', attempts: 1, craftingSeconds: 3600 }),
      ],
      at(8),
    );
    expect(brick.metrics).toMatchObject({
      realizedProfit: '0',
      recognizedItemResult: '-14',
      actualRoiPercent: '-100',
      profitPerCraftingHour: '-14',
    });
  });
  it('prevents manual or salvage outcomes from claiming premium exact-target sale evidence', () => {
    const b = batch();
    const input = syntheticOutcomeInput();
    b.forecast = {
      sourceId: 'synthetic',
      analysisInput: input,
      analysis: analyzeOutcomeModel(input),
      riskRequest: null,
      riskResult: null,
    };
    expect(() =>
      projectFactoryBatch(
        b,
        [event(10, { ...produce(100), targetSignature: b.targetSignature })],
        at(8),
      ),
    ).toThrow('Manual outcome matching');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          event(10, {
            ...produce(100, [], 'salvage-life-tier2'),
            targetSignature: b.targetSignature,
          }),
        ],
        at(8),
      ),
    ).toThrow('Only a confirmed target');
    expect(
      projectFactoryBatch(
        batch(),
        [event(10, { ...produce(100), targetSignature: b.targetSignature })],
        at(8),
      ).inventory[0]?.targetSignature,
    ).toBe(b.targetSignature);
    expect(
      projectFactoryBatch(
        batch(),
        [
          event(10, {
            ...produce(100, [], 'salvage-life-tier2'),
            targetSignature: 'life-tier2-signature',
          }),
        ],
        at(8),
      ).inventory[0]?.targetSignature,
    ).toBe('life-tier2-signature');
  });
  it('fully allocates exact locked-FX cost products beyond sixteen decimal places', () => {
    const events = [
      event(10, {
        type: 'purchase',
        resourceId: 'fractional-currency',
        transaction: tx('0.5', '1', 'divine', '150.1234567890123457'),
      }),
      event(11, { type: 'consume', purchaseEventId: id(10), quantity: '0.5' }),
      event(
        12,
        produce(100, [{ costEventId: id(11), amount: '75.06172839450617285' }]),
      ),
    ];
    expect(projectFactoryBatch(batch(), events, at(8)).metrics).toMatchObject({
      allocationComplete: true,
      unallocatedCost: '0',
    });
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          ...events,
          event(13, {
            type: 'allocate',
            itemId: id(100),
            allocations: [
              { costEventId: id(11), amount: '0.00000000000000001' },
            ],
          }),
        ],
        at(8),
      ),
    ).toThrow('exceeds');
    const bound = '999999999999.9999999999999999';
    const digits = ((10n ** 28n - 1n) ** 3n).toString();
    const expected = digits.slice(0, -48) + '.' + digits.slice(-48);
    const extreme = [
      event(20, {
        type: 'purchase',
        resourceId: 'bounded-synthetic',
        transaction: tx(bound, bound, 'divine', bound),
      }),
      event(21, { type: 'consume', purchaseEventId: id(20), quantity: bound }),
      event(22, produce(101, [{ costEventId: id(21), amount: expected }])),
    ];
    const projection = projectFactoryBatch(batch(), extreme, at(8));
    expect(projection.costs[0]?.amount).toBe(expected);
    expect(projection.metrics.allocationComplete).toBe(true);
  });
  it('rejects financial references to purchases, consumption or costs occurring later', () => {
    const purchase = event(
      10,
      { type: 'purchase', resourceId: 'base', transaction: tx('2', '10') },
      6,
    );
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          purchase,
          event(
            11,
            { type: 'consume', purchaseEventId: id(10), quantity: '1' },
            5,
          ),
        ],
        at(8),
      ),
    ).toThrow('predates its purchase');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          purchase,
          event(
            11,
            {
              type: 'refund',
              purchaseEventId: id(10),
              quantity: '1',
              transaction: tx('1', '10'),
            },
            5,
          ),
        ],
        at(8),
      ),
    ).toThrow('predates its purchase');
    const consumed = event(
      11,
      { type: 'consume', purchaseEventId: id(10), quantity: '1' },
      7,
    );
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          purchase,
          consumed,
          event(
            12,
            { type: 'return-material', consumeEventId: id(11), quantity: '1' },
            6,
          ),
        ],
        at(8),
      ),
    ).toThrow('Return predates');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          purchase,
          consumed,
          event(12, produce(100, [{ costEventId: id(11), amount: '10' }]), 6),
        ],
        at(8),
      ),
    ).toThrow('Allocation predates its source');
    expect(() =>
      projectFactoryBatch(
        batch(),
        [
          purchase,
          consumed,
          event(12, produce(100), 6),
          event(
            13,
            {
              type: 'allocate',
              itemId: id(100),
              allocations: [{ costEventId: id(11), amount: '10' }],
            },
            6,
          ),
        ],
        at(8),
      ),
    ).toThrow('Allocation predates its source');
  });
  it.each(['completed', 'cancelled'] as const)(
    'requires reopening a %s batch for production while allowing liquidation',
    (status) => {
      const base = [
        ...golden().slice(0, 9),
        event(20, { type: 'batch-status', status }, 6),
      ];
      const operations = [
        { type: 'purchase', resourceId: 'extra', transaction: tx('1', '1') },
        { type: 'consume', purchaseEventId: id(10), quantity: '1' },
        produce(102),
        { type: 'activity', attempts: 1, craftingSeconds: 30 },
      ];
      for (const operation of operations)
        expect(() =>
          projectFactoryBatch(
            batch(),
            [...base, event(21, operation, 7)],
            at(8),
          ),
        ).toThrow('Reopen the batch');
      const sold = projectFactoryBatch(
        batch(),
        [
          ...base,
          event(
            21,
            {
              type: 'sale',
              itemId: id(100),
              transaction: tx('1', '50'),
              expenses: [],
            },
            7,
          ),
        ],
        at(8),
      );
      expect(sold.metrics.soldCount).toBe(1);
      const reopened = projectFactoryBatch(
        batch(),
        [
          ...base,
          event(21, { type: 'batch-status', status: 'active' }, 7),
          event(22, { type: 'activity', attempts: 1, craftingSeconds: 30 }, 7),
        ],
        at(8),
      );
      expect(reopened.metrics.attempts).toBe(1);
    },
  );
  it('freezes completed turnover after final liquidation, including sales after closing', () => {
    const events = [
      event(10, produce(100), 4),
      event(11, { type: 'batch-status', status: 'completed' }, 5),
      event(
        12,
        {
          type: 'sale',
          itemId: id(100),
          transaction: tx('1', '10'),
          expenses: [],
        },
        6,
      ),
    ];
    const first = projectFactoryBatch(batch(), events, at(8));
    const later = projectFactoryBatch(batch(), events, at(20));
    expect(first.metrics).toMatchObject({
      inventoryUnitSeconds: '172800',
      averageHeldUnits: '1',
      observedUnitTurnover: '1',
      turnoverWindowEnd: '2026-11-06T00:00:00.000Z',
    });
    expect(later.metrics).toEqual(first.metrics);
    expect(summarizeFactoryBatches([first, later]).observedUnitTurnover).toBe(
      '1',
    );
  });
  it('exposes refund cost basis, actual receipts and other credits for reconciliation', () => {
    const events = [
      event(10, {
        type: 'purchase',
        resourceId: 'base',
        transaction: tx('2', '10'),
      }),
      event(11, {
        type: 'refund',
        purchaseEventId: id(10),
        quantity: '1',
        transaction: tx('1', '8'),
      }),
      event(12, {
        type: 'credit',
        category: 'other',
        transaction: tx('1', '3'),
      }),
    ];
    const p = projectFactoryBatch(batch(), events, at(8));
    expect(p.metrics).toMatchObject({
      grossSpending: '20',
      unusedMaterialCost: '10',
      refundedMaterialCost: '10',
      refundReceipts: '8',
      otherCredits: '3',
      cashReceived: '11',
      cashFlow: '-9',
      realizedProfit: '0',
      recognizedItemResult: '0',
    });
    expect(summarizeFactoryBatches([p, p])).toMatchObject({
      refundedMaterialCost: '20',
      refundReceipts: '16',
      otherCredits: '6',
    });
  });
});
