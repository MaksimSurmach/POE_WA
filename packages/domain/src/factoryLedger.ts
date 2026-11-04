import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { isOutcomeAmount, outcomeAnalysisInputSchema } from './outcomeModel.js';
import { outcomeAnalysisSchema } from './outcomeEconomics.js';
import {
  riskSimulationRequestSchema,
  riskSimulationResultSchema,
} from './craftingRisk.js';

const D = Decimal.clone({ precision: 120 });
export const factoryCalculationVersion = 'factory-1';
const key = z.string().trim().min(1).max(200);
const note = z.string().max(2000);
const instant = z.iso.datetime({ offset: true });
export const factoryAmountSchema = z
  .string()
  .refine(isOutcomeAmount, 'Invalid bounded decimal');
const positive = factoryAmountSchema.refine(
  (v) => isOutcomeAmount(v) && new D(v).gt(0),
  'Must be positive',
);
const resultAmount = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .max(160);
export const factoryTransactionSchema = z
  .strictObject({
    quantity: positive,
    unitPrice: factoryAmountSchema,
    currency: z.enum(['chaos', 'divine']),
    chaosPerUnit: positive,
    rateSource: key,
  })
  .refine(
    (v) => v.currency !== 'chaos' || new D(v.chaosPerUnit).eq(1),
    'Chaos conversion must equal one',
  );
export const factoryForecastSchema = z.strictObject({
  sourceId: key,
  analysisInput: outcomeAnalysisInputSchema,
  analysis: outcomeAnalysisSchema,
  riskRequest: riskSimulationRequestSchema.nullable(),
  riskResult: riskSimulationResultSchema.nullable(),
});
export const factoryBatchSchema = z.strictObject({
  id: z.uuid(),
  recipeId: key,
  recipeHash: key,
  targetSignature: key,
  leagueId: z.uuid(),
  league: key,
  accountingCurrency: z.literal('chaos'),
  startedAt: instant,
  plannedBudget: factoryTransactionSchema,
  notes: note,
  forecast: factoryForecastSchema.nullable(),
  forecastUnavailableReasons: z.array(note).max(100).default([]),
});
/** Three 16-decimal inputs multiply to at most 48 fractional digits.
 * Preserve that exact cost basis instead of rounding away an unallocatable residue. */
export const factoryAllocationAmountSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= 90 &&
      /^(?:0|[1-9]\d*)(?:\.\d{1,48})?$/.test(value) &&
      new D(value).gt(0) &&
      new D(value).lte('1e36'),
    'Invalid exact allocation amount',
  );
export const factoryAllocationSchema = z.strictObject({
  costEventId: z.uuid(),
  amount: factoryAllocationAmountSchema,
});
const allocations = z.array(factoryAllocationSchema).max(200);
const classification = z.enum([
  'premium',
  'target',
  'imperfect',
  'salvage',
  'unusable',
  'recovery',
  'unknown',
]);
const category = z.enum(['base', 'crafting', 'finishing', 'recovery', 'other']);
export const factoryEventPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('purchase'),
    resourceId: key,
    transaction: factoryTransactionSchema,
  }),
  z.strictObject({
    type: z.literal('consume'),
    purchaseEventId: z.uuid(),
    quantity: positive,
  }),
  z.strictObject({
    type: z.literal('return-material'),
    consumeEventId: z.uuid(),
    quantity: positive,
  }),
  z.strictObject({
    type: z.literal('refund'),
    purchaseEventId: z.uuid(),
    quantity: positive,
    transaction: factoryTransactionSchema,
  }),
  z.strictObject({
    type: z.literal('expense'),
    category,
    transaction: factoryTransactionSchema,
  }),
  z.strictObject({
    type: z.literal('credit'),
    category: z.enum(['recovery', 'other']),
    transaction: factoryTransactionSchema,
  }),
  z.strictObject({
    type: z.literal('produce'),
    itemId: z.uuid(),
    description: key,
    modifiers: z.array(key).max(32),
    outcome: key,
    classification: classification.default('unknown'),
    targetSignature: key.nullable().default(null),
    allocations,
  }),
  z.strictObject({
    type: z.literal('allocate'),
    itemId: z.uuid(),
    allocations: allocations.min(1),
  }),
  z.strictObject({
    type: z.literal('list'),
    itemId: z.uuid(),
    price: factoryTransactionSchema,
  }),
  z.strictObject({
    type: z.literal('sale'),
    itemId: z.uuid(),
    transaction: factoryTransactionSchema,
    expenses: z.array(factoryTransactionSchema).max(32),
  }),
  z.strictObject({
    type: z.literal('item-status'),
    itemId: z.uuid(),
    status: z.enum(['held', 'consumed', 'recycled', 'discarded']),
  }),
  z.strictObject({
    type: z.literal('activity'),
    attempts: z.number().int().min(0).max(1000000),
    craftingSeconds: z.number().int().min(0).max(31536000),
  }),
  z.strictObject({
    type: z.literal('batch-status'),
    status: z.enum(['active', 'completed', 'cancelled']),
  }),
  z.strictObject({ type: z.literal('note'), text: note }),
  z.strictObject({ type: z.literal('void'), eventId: z.uuid(), reason: key }),
]);
export const factoryEventSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: instant,
  source: key,
  notes: note,
  payload: factoryEventPayloadSchema,
});
export const factoryEventsSchema = z.array(factoryEventSchema).max(2000);
export const factoryInventorySchema = z.strictObject({
  id: z.uuid(),
  batchId: z.uuid(),
  recipeId: key,
  recipeTargetSignature: key,
  targetSignature: key.nullable(),
  league: key,
  outcomeClassification: classification,
  statusChangedAt: instant,
  description: key,
  modifiers: z.array(key),
  outcome: key,
  producedAt: instant,
  status: z.enum([
    'held',
    'listed',
    'sold',
    'consumed',
    'recycled',
    'discarded',
  ]),
  allocations,
  allocatedCost: resultAmount,
  listingPrice: factoryTransactionSchema.nullable(),
  listedAt: instant.nullable(),
  saleEventId: z.uuid().nullable(),
  soldAt: instant.nullable(),
  saleRevenue: resultAmount.nullable(),
  transactionExpenses: resultAmount.nullable(),
});
export const factorySaleSchema = z.strictObject({
  eventId: z.uuid(),
  itemId: z.uuid(),
  batchId: z.uuid(),
  recipeId: key,
  recipeTargetSignature: key,
  targetSignature: key.nullable(),
  league: key,
  outcomeClassification: classification,
  soldAt: instant,
  transaction: factoryTransactionSchema,
  expenses: z.array(factoryTransactionSchema),
  revenue: resultAmount,
  allocatedCost: resultAmount,
  transactionExpenses: resultAmount,
  realizedProfit: resultAmount,
  timeToSellSeconds: z.number().nonnegative().nullable(),
  outcome: key,
});
export const factoryMetricsSchema = z.strictObject({
  realizedProfit: resultAmount,
  recognizedItemResult: resultAmount,
  refundReceipts: resultAmount,
  refundedMaterialCost: resultAmount,
  otherCredits: resultAmount,
  saleRevenue: resultAmount,
  soldProductionCost: resultAmount,
  transactionExpenses: resultAmount,
  cashFlow: resultAmount,
  grossSpending: resultAmount,
  cashReceived: resultAmount,
  productionCost: resultAmount,
  inventoryCost: resultAmount,
  unusedMaterialCost: resultAmount,
  unallocatedCost: resultAmount,
  disposedCost: resultAmount,
  recoveryCredits: resultAmount,
  salvageSaleRevenue: resultAmount,
  actualRoiPercent: resultAmount.nullable(),
  attempts: z.number().int().nonnegative(),
  craftingSeconds: z.number().int().nonnegative(),
  producedCount: z.number().int().nonnegative(),
  soldCount: z.number().int().nonnegative(),
  timeToSellSampleSize: z.number().int().nonnegative(),
  meanTimeToSellSeconds: z.number().nonnegative().nullable(),
  observedSellThroughPercent: resultAmount.nullable(),
  profitPerCraftingHour: resultAmount.nullable(),
  allocationComplete: z.boolean(),
  turnoverWindowStart: instant.nullable(),
  turnoverWindowEnd: instant.nullable(),
  inventoryUnitSeconds: resultAmount,
  averageHeldUnits: resultAmount.nullable(),
  observedUnitTurnover: resultAmount.nullable(),
  listedInventoryAskingValue: resultAmount,
  listedInventoryCount: z.number().int().nonnegative(),
});
export const factoryProjectionSchema = z.strictObject({
  calculationVersion: z.literal(factoryCalculationVersion),
  batchId: z.uuid(),
  asOf: instant,
  status: z.enum(['active', 'completed', 'cancelled']),
  completedAt: instant.nullable(),
  notes: note,
  metrics: factoryMetricsSchema,
  inventory: z.array(factoryInventorySchema).max(1000),
  sales: z.array(factorySaleSchema).max(1000),
  stock: z.array(
    z.strictObject({
      purchaseEventId: z.uuid(),
      resourceId: key,
      quantityPurchased: resultAmount,
      quantityAvailable: resultAmount,
      unitCost: resultAmount,
      costBasis: resultAmount,
    }),
  ),
  costs: z.array(
    z.strictObject({
      eventId: z.uuid(),
      category: key,
      amount: resultAmount,
      allocated: resultAmount,
      remaining: resultAmount,
    }),
  ),
  voidedEventIds: z.array(z.uuid()),
  warnings: z.array(z.string()),
  forecastComparison: z.strictObject({
    status: z.enum(['comparable', 'unavailable']),
    reason: z.string(),
    expectedCost: resultAmount.nullable(),
    expectedProfit: resultAmount.nullable(),
    actualCashOutlay: resultAmount,
    actualCashResult: resultAmount,
    costDifference: resultAmount.nullable(),
    profitDifference: resultAmount.nullable(),
  }),
});
export type FactoryBatch = z.infer<typeof factoryBatchSchema>;
export type FactoryEvent = z.infer<typeof factoryEventSchema>;
export type FactoryTransaction = z.infer<typeof factoryTransactionSchema>;
export type FactoryProjection = z.infer<typeof factoryProjectionSchema>;
export type FactoryInventory = z.infer<typeof factoryInventorySchema>;
export type FactorySale = z.infer<typeof factorySaleSchema>;
export class FactoryLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryLedgerError';
  }
}
const fail = (message: string): never => {
  throw new FactoryLedgerError(message);
};
const money = (value: Decimal) =>
  value.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed();
const exact = (value: Decimal) => value.toFixed();
export const factoryTransactionChaos = (tx: FactoryTransaction): string =>
  exact(new D(tx.quantity).mul(tx.unitPrice).mul(tx.chaosPerUnit));

/** Append order is authoritative. Corrections remove effects, never history; dependencies must still replay. */
export function projectFactoryBatch(
  rawBatch: FactoryBatch,
  rawEvents: FactoryEvent[],
  asOf: string,
): FactoryProjection {
  const batch = factoryBatchSchema.parse(rawBatch);
  const events = factoryEventsSchema.parse(rawEvents);
  instant.parse(asOf);
  if (Date.parse(asOf) < Date.parse(batch.startedAt))
    fail('Observation predates batch start');
  const ids = new Set<string>();
  const voided = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) fail('Duplicate event ID');
    if (
      Date.parse(event.occurredAt) < Date.parse(batch.startedAt) ||
      Date.parse(event.occurredAt) > Date.parse(asOf)
    )
      fail('Event timestamp outside batch observation window');
    if (event.payload.type === 'void') {
      if (!ids.has(event.payload.eventId) || voided.has(event.payload.eventId))
        fail('Correction must reference an earlier active event');
      const correctedId = event.payload.eventId;
      if (events.find((e) => e.id === correctedId)?.payload.type === 'void')
        fail('Corrections cannot void corrections');
      voided.add(event.payload.eventId);
    }
    ids.add(event.id);
  }
  const stock = new Map<
    string,
    {
      resourceId: string;
      purchased: Decimal;
      available: Decimal;
      unit: Decimal;
      occurredAt: string;
    }
  >();
  const costs = new Map<
    string,
    {
      category: string;
      amount: Decimal;
      allocated: Decimal;
      occurredAt: string;
    }
  >();
  const consumptions = new Map<
    string,
    { purchaseId: string; remaining: Decimal }
  >();
  const items = new Map<string, FactoryInventory>();
  const sales: FactorySale[] = [];
  let spending = new D(0),
    received = new D(0),
    recovery = new D(0),
    refunds = new D(0),
    refundedCost = new D(0),
    otherCredits = new D(0),
    attempts = 0,
    seconds = 0;
  let status: FactoryProjection['status'] = 'active',
    completedAt: string | null = null,
    notes = batch.notes;
  let statusChangedAt = batch.startedAt;
  const getItem = (id: string) =>
    items.get(id) ?? fail('Unknown inventory item');
  const mutableItem = (id: string) => {
    const item = getItem(id);
    if (!['held', 'listed'].includes(item.status))
      fail('Disposed or sold item is immutable; correct its history first');
    return item;
  };
  const allocate = (
    item: FactoryInventory,
    rows: z.infer<typeof allocations>,
    occurredAt: string,
  ) => {
    if (Date.parse(occurredAt) < Date.parse(item.producedAt))
      fail('Allocation predates item production');
    if (item.allocations.length + rows.length > 200)
      fail('Item allocation limit reached');
    for (const row of rows) {
      const cost =
        costs.get(row.costEventId) ??
        fail('Allocation references unknown cost');
      if (Date.parse(occurredAt) < Date.parse(cost.occurredAt))
        fail('Allocation predates its source cost');
      if (cost.allocated.add(row.amount).gt(cost.amount))
        fail('Cost allocation exceeds available production cost');
      cost.allocated = cost.allocated.add(row.amount);
      item.allocations.push(row);
      item.allocatedCost = exact(new D(item.allocatedCost).add(row.amount));
    }
  };
  for (const event of events) {
    if (voided.has(event.id) || event.payload.type === 'void') continue;
    const p = event.payload;
    if (
      status !== 'active' &&
      ['purchase', 'consume', 'produce', 'activity'].includes(p.type)
    )
      fail('Reopen the batch before recording new production');
    if (
      (p.type === 'list' && !new D(p.price.quantity).eq(1)) ||
      (p.type === 'sale' && !new D(p.transaction.quantity).eq(1))
    )
      fail('Inventory listings and sales must describe exactly one item');
    switch (p.type) {
      case 'purchase': {
        const total = new D(factoryTransactionChaos(p.transaction));
        spending = spending.add(total);
        stock.set(event.id, {
          resourceId: p.resourceId,
          purchased: new D(p.transaction.quantity),
          available: new D(p.transaction.quantity),
          unit: new D(p.transaction.unitPrice).mul(p.transaction.chaosPerUnit),
          occurredAt: event.occurredAt,
        });
        break;
      }
      case 'consume': {
        const lot =
          stock.get(p.purchaseEventId) ?? fail('Unknown purchase lot');
        if (Date.parse(event.occurredAt) < Date.parse(lot.occurredAt))
          fail('Material event predates its purchase');
        if (lot.available.lt(p.quantity))
          fail('Insufficient material inventory');
        lot.available = lot.available.sub(p.quantity);
        costs.set(event.id, {
          category: 'material',
          amount: lot.unit.mul(p.quantity),
          allocated: new D(0),
          occurredAt: event.occurredAt,
        });
        consumptions.set(event.id, {
          purchaseId: p.purchaseEventId,
          remaining: new D(p.quantity),
        });
        break;
      }
      case 'return-material': {
        const used =
          consumptions.get(p.consumeEventId) ??
          fail('Unknown material consumption');
        const lot = stock.get(used.purchaseId)!;
        const cost = costs.get(p.consumeEventId)!;
        if (Date.parse(event.occurredAt) < Date.parse(cost.occurredAt))
          fail('Return predates material consumption');
        if (used.remaining.lt(p.quantity))
          fail('Return exceeds consumed quantity');
        const remainingCost = cost.amount.sub(lot.unit.mul(p.quantity));
        if (remainingCost.lt(cost.allocated))
          fail('Return would remove allocated production cost');
        used.remaining = used.remaining.sub(p.quantity);
        lot.available = lot.available.add(p.quantity);
        cost.amount = remainingCost;
        break;
      }
      case 'refund': {
        const lot =
          stock.get(p.purchaseEventId) ?? fail('Unknown purchase lot');
        if (Date.parse(event.occurredAt) < Date.parse(lot.occurredAt))
          fail('Material event predates its purchase');
        if (lot.available.lt(p.quantity))
          fail('Refund exceeds unused material inventory');
        lot.available = lot.available.sub(p.quantity);
        const receipt = new D(factoryTransactionChaos(p.transaction));
        received = received.add(receipt);
        refunds = refunds.add(receipt);
        refundedCost = refundedCost.add(lot.unit.mul(p.quantity));
        break;
      }
      case 'expense': {
        const amount = new D(factoryTransactionChaos(p.transaction));
        spending = spending.add(amount);
        costs.set(event.id, {
          category: p.category,
          amount,
          allocated: new D(0),
          occurredAt: event.occurredAt,
        });
        break;
      }
      case 'credit': {
        const amount = new D(factoryTransactionChaos(p.transaction));
        received = received.add(amount);
        if (p.category === 'recovery') recovery = recovery.add(amount);
        else otherCredits = otherCredits.add(amount);
        break;
      }
      case 'produce': {
        if (items.has(p.itemId)) fail('Duplicate inventory item');
        if (items.size >= 1000) fail('Batch inventory limit reached');
        const declared = batch.forecast?.analysisInput.model.stages
          .flatMap((stage) => stage.outcomes)
          .find((outcome) => outcome.id === p.outcome);
        if (declared?.matching.kind === 'manual' && p.targetSignature !== null)
          fail(
            'Manual outcome matching cannot establish an exact output signature',
          );
        if (
          !declared &&
          p.targetSignature === batch.targetSignature &&
          !['target', 'premium'].includes(p.classification)
        )
          fail(
            'Only a confirmed target or premium output can use the recipe target signature',
          );
        const signature =
          declared?.matching.kind === 'exact-target'
            ? declared.matching.targetSignature
            : p.targetSignature;
        if (p.targetSignature !== null && signature !== p.targetSignature)
          fail('Produced output signature conflicts with the frozen outcome');
        if (
          declared &&
          p.classification !== 'unknown' &&
          p.classification !== declared.classification
        )
          fail('Produced classification conflicts with the frozen outcome');
        const item: FactoryInventory = {
          id: p.itemId,
          batchId: batch.id,
          recipeId: batch.recipeId,
          recipeTargetSignature: batch.targetSignature,
          targetSignature: signature,
          league: batch.league,
          outcomeClassification: declared?.classification ?? p.classification,
          statusChangedAt: event.occurredAt,
          description: p.description,
          modifiers: p.modifiers,
          outcome: p.outcome,
          producedAt: event.occurredAt,
          status: 'held',
          allocations: [],
          allocatedCost: '0',
          listingPrice: null,
          listedAt: null,
          saleEventId: null,
          soldAt: null,
          saleRevenue: null,
          transactionExpenses: null,
        };
        allocate(item, p.allocations, event.occurredAt);
        items.set(item.id, item);
        break;
      }
      case 'allocate':
        allocate(mutableItem(p.itemId), p.allocations, event.occurredAt);
        break;
      case 'list': {
        const item = mutableItem(p.itemId);
        if (Date.parse(event.occurredAt) < Date.parse(item.statusChangedAt))
          fail('Listing predates the latest item status');
        item.status = 'listed';
        item.statusChangedAt = event.occurredAt;
        item.listingPrice = p.price;
        item.listedAt ??= event.occurredAt;
        break;
      }
      case 'sale': {
        const item = mutableItem(p.itemId);
        if (Date.parse(event.occurredAt) < Date.parse(item.statusChangedAt))
          fail('Sale predates production or listing');
        const revenue = new D(factoryTransactionChaos(p.transaction));
        const fees = p.expenses.reduce(
          (v, tx) => v.add(factoryTransactionChaos(tx)),
          new D(0),
        );
        received = received.add(revenue);
        spending = spending.add(fees);
        item.status = 'sold';
        item.statusChangedAt = event.occurredAt;
        item.saleEventId = event.id;
        item.soldAt = event.occurredAt;
        item.saleRevenue = exact(revenue);
        item.transactionExpenses = exact(fees);
        sales.push({
          eventId: event.id,
          itemId: item.id,
          batchId: batch.id,
          recipeId: batch.recipeId,
          recipeTargetSignature: batch.targetSignature,
          targetSignature: item.targetSignature,
          outcomeClassification: item.outcomeClassification,
          league: batch.league,
          soldAt: event.occurredAt,
          transaction: p.transaction,
          expenses: p.expenses,
          revenue: exact(revenue),
          allocatedCost: item.allocatedCost,
          transactionExpenses: exact(fees),
          realizedProfit: exact(revenue.sub(item.allocatedCost).sub(fees)),
          timeToSellSeconds: item.listedAt
            ? (Date.parse(event.occurredAt) - Date.parse(item.listedAt)) / 1000
            : null,
          outcome: item.outcome,
        });
        break;
      }
      case 'item-status': {
        const item = mutableItem(p.itemId);
        if (Date.parse(event.occurredAt) < Date.parse(item.statusChangedAt))
          fail('Disposition predates the latest item status');
        item.status = p.status;
        item.statusChangedAt = event.occurredAt;
        if (p.status === 'held') {
          item.listedAt = null;
          item.listingPrice = null;
        }
        break;
      }
      case 'activity':
        attempts += p.attempts;
        seconds += p.craftingSeconds;
        break;
      case 'batch-status':
        if (Date.parse(event.occurredAt) < Date.parse(statusChangedAt))
          fail('Batch status predates the previous status');
        statusChangedAt = event.occurredAt;
        status = p.status;
        completedAt = p.status === 'active' ? null : event.occurredAt;
        break;
      case 'note':
        notes = p.text;
        break;
    }
  }
  const sum = (values: (Decimal | string)[]) =>
    values.reduce<Decimal>((total, value) => total.add(value), new D(0));
  const inventory = [...items.values()];
  const production = sum([...costs.values()].map((c) => c.amount));
  const allocated = sum([...costs.values()].map((c) => c.allocated));
  const unallocated = production.sub(allocated);
  const realized = sum(sales.map((s) => s.realizedProfit));
  const soldCost = sum(sales.map((s) => s.allocatedCost));
  const fees = sum(sales.map((s) => s.transactionExpenses));
  const times = sales.flatMap((s) =>
    s.timeToSellSeconds === null ? [] : [s.timeToSellSeconds],
  );
  const cash = received.sub(spending);
  const warnings: string[] = [];
  if (unallocated.gt(0))
    warnings.push(
      'Production costs remain unallocated; realized profit includes only traced sold-item allocations.',
    );
  if (recovery.gt(0))
    warnings.push(
      'Recovery credits are cash receipts, separate from item-sale profit and gross production cost.',
    );
  const allDisposed = inventory.every(
    (item) => !['held', 'listed'].includes(item.status),
  );
  const turnoverEnd =
    status !== 'active' && allDisposed && completedAt !== null
      ? new Date(
          Math.max(
            Date.parse(completedAt),
            ...inventory.map((item) => Date.parse(item.statusChangedAt)),
          ),
        ).toISOString()
      : asOf;
  const disposedCost = sum(
    inventory
      .filter((item) =>
        ['consumed', 'recycled', 'discarded'].includes(item.status),
      )
      .map((item) => item.allocatedCost),
  );
  const recognized = realized.sub(disposedCost);
  const recognizedCost = soldCost.add(fees).add(disposedCost);
  const windowSeconds = new D(
    Date.parse(turnoverEnd) - Date.parse(batch.startedAt),
  ).div(1000);
  const unitSeconds = sum(
    inventory.map((item) =>
      new D(
        Date.parse(
          ['held', 'listed'].includes(item.status)
            ? asOf
            : item.statusChangedAt,
        ) - Date.parse(item.producedAt),
      ).div(1000),
    ),
  );
  const averageUnits = windowSeconds.gt(0)
    ? unitSeconds.div(windowSeconds)
    : null;
  const listed = inventory.filter(
    (item) => item.status === 'listed' && item.listingPrice !== null,
  );
  const forecast = batch.forecast;
  const risk = forecast?.riskResult;
  const objective = risk?.objective;
  const closed =
    status === 'completed' &&
    inventory.every((i) =>
      ['sold', 'consumed', 'recycled', 'discarded'].includes(i.status),
    ) &&
    [...stock.values()].every((l) => l.available.eq(0)) &&
    unallocated.eq(0);
  const targetIds = new Set(
    forecast?.analysisInput.model.stages.flatMap((stage) =>
      stage.outcomes
        .filter((outcome) => outcome.targetSuccess)
        .map((outcome) => outcome.id),
    ) ?? [],
  );
  const objectiveMatches =
    objective?.kind === 'attempts'
      ? attempts === objective.count
      : objective
        ? inventory.filter((i) => targetIds.has(i.outcome)).length ===
          (objective.kind === 'single-target' ? 1 : objective.count)
        : false;
  // A completed target objective consumes its final base. First-run retained
  // probability therefore describes intermediate retries, not a leftover asset.
  const targetOutcomes =
    forecast?.analysisInput.model.stages.flatMap((stage) =>
      stage.outcomes.filter((outcome) => outcome.targetSuccess),
    ) ?? [];
  const completedTargetAssetBasis =
    objective !== undefined &&
    objective.kind !== 'attempts' &&
    targetOutcomes.length > 0 &&
    targetOutcomes.every(
      (outcome) =>
        outcome.nextStageId === null &&
        outcome.sellable &&
        outcome.baseDisposition === 'consumed',
    );
  const assetBasisComplete =
    forecast?.analysis.unvaluedRetainedBaseProbability === '0' ||
    completedTargetAssetBasis;
  const retrospectiveForecast =
    forecast !== null &&
    Date.parse(forecast.analysisInput.now) > Date.parse(batch.startedAt);
  const comparable = Boolean(
    !retrospectiveForecast &&
    closed &&
    risk?.status === 'complete' &&
    risk.currency === 'chaos' &&
    objectiveMatches &&
    inventory.length <= attempts &&
    forecast?.analysisInput.league === batch.league &&
    assetBasisComplete,
  );
  const expectedCost = comparable ? (risk?.meanCost ?? null) : null,
    expectedProfit = comparable ? (risk?.meanProfit ?? null) : null;
  return factoryProjectionSchema.parse({
    calculationVersion: factoryCalculationVersion,
    batchId: batch.id,
    asOf,
    status,
    completedAt,
    notes,
    inventory,
    sales,
    stock: [...stock].map(([id, l]) => ({
      purchaseEventId: id,
      resourceId: l.resourceId,
      quantityPurchased: exact(l.purchased),
      quantityAvailable: exact(l.available),
      unitCost: exact(l.unit),
      costBasis: money(l.available.mul(l.unit)),
    })),
    costs: [...costs].map(([id, c]) => ({
      eventId: id,
      category: c.category,
      amount: exact(c.amount),
      allocated: exact(c.allocated),
      remaining: exact(c.amount.sub(c.allocated)),
    })),
    voidedEventIds: [...voided],
    warnings,
    metrics: {
      realizedProfit: money(realized),
      recognizedItemResult: money(recognized),
      refundReceipts: money(refunds),
      refundedMaterialCost: money(refundedCost),
      otherCredits: money(otherCredits),
      saleRevenue: money(sum(sales.map((s) => s.revenue))),
      soldProductionCost: money(soldCost),
      transactionExpenses: money(fees),
      cashFlow: money(cash),
      grossSpending: money(spending),
      cashReceived: money(received),
      productionCost: money(production),
      inventoryCost: money(
        sum(
          inventory
            .filter((i) => ['held', 'listed'].includes(i.status))
            .map((i) => i.allocatedCost),
        ),
      ),
      unusedMaterialCost: money(
        sum([...stock.values()].map((l) => l.available.mul(l.unit))),
      ),
      unallocatedCost: money(unallocated),
      disposedCost: money(
        sum(
          inventory
            .filter((i) =>
              ['consumed', 'recycled', 'discarded'].includes(i.status),
            )
            .map((i) => i.allocatedCost),
        ),
      ),
      recoveryCredits: money(recovery),
      salvageSaleRevenue: money(
        sum(
          sales
            .filter((s) => s.outcomeClassification === 'salvage')
            .map((s) => s.revenue),
        ),
      ),
      actualRoiPercent:
        recognizedCost.gt(0) && unallocated.eq(0)
          ? money(recognized.div(recognizedCost).mul(100))
          : null,
      attempts,
      craftingSeconds: seconds,
      producedCount: inventory.length,
      soldCount: sales.length,
      timeToSellSampleSize: times.length,
      meanTimeToSellSeconds: times.length
        ? times.reduce((a, b) => a + b, 0) / times.length
        : null,
      observedSellThroughPercent:
        sales.length && inventory.length
          ? money(new D(sales.length).div(inventory.length).mul(100))
          : null,
      profitPerCraftingHour:
        seconds &&
        inventory.some((item) => !['held', 'listed'].includes(item.status)) &&
        unallocated.eq(0)
          ? money(recognized.mul(3600).div(seconds))
          : null,
      allocationComplete: unallocated.eq(0),
      turnoverWindowStart: batch.startedAt,
      turnoverWindowEnd: turnoverEnd,
      inventoryUnitSeconds: exact(unitSeconds),
      averageHeldUnits: averageUnits === null ? null : money(averageUnits),
      observedUnitTurnover:
        sales.length && averageUnits?.gt(0)
          ? money(new D(sales.length).div(averageUnits))
          : null,
      listedInventoryAskingValue: money(
        sum(listed.map((item) => factoryTransactionChaos(item.listingPrice!))),
      ),
      listedInventoryCount: listed.length,
    },
    forecastComparison: {
      status: comparable ? 'comparable' : 'unavailable',
      reason: comparable
        ? 'Completed batch matches the frozen simulation objective; cash comparison excludes unvalued assets.'
        : retrospectiveForecast
          ? 'Forecast was created after the batch started; retrospective estimates cannot measure forecast accuracy.'
          : 'Requires a completed, fully allocated batch with no remaining stock/inventory and a matching frozen chaos simulation objective. First-run cash EV is not a batch forecast.',
      expectedCost,
      expectedProfit,
      actualCashOutlay: money(spending),
      actualCashResult: money(cash),
      costDifference:
        expectedCost === null ? null : money(spending.sub(expectedCost)),
      profitDifference:
        expectedProfit === null ? null : money(cash.sub(expectedProfit)),
    },
  });
}

export type FactoryMetrics = z.infer<typeof factoryMetricsSchema>;
/** Aggregate only accounting amounts and observed samples; never average per-batch ROI percentages. */
export function summarizeFactoryBatches(
  projections: FactoryProjection[],
): FactoryMetrics {
  const total = (field: keyof FactoryMetrics) =>
    projections.reduce(
      (value, p) => value.add(String(p.metrics[field])),
      new D(0),
    );
  const amounts = [
    'realizedProfit',
    'recognizedItemResult',
    'refundReceipts',
    'refundedMaterialCost',
    'otherCredits',
    'saleRevenue',
    'soldProductionCost',
    'transactionExpenses',
    'cashFlow',
    'grossSpending',
    'cashReceived',
    'productionCost',
    'inventoryCost',
    'unusedMaterialCost',
    'unallocatedCost',
    'disposedCost',
    'recoveryCredits',
    'salvageSaleRevenue',
    'listedInventoryAskingValue',
    'inventoryUnitSeconds',
  ] as const;
  const summed = Object.fromEntries(
    amounts.map((field) => [field, money(total(field))]),
  );
  const counts = [
    'attempts',
    'craftingSeconds',
    'producedCount',
    'soldCount',
    'timeToSellSampleSize',
    'listedInventoryCount',
  ] as const;
  const count = Object.fromEntries(
    counts.map((field) => [field, total(field).toNumber()]),
  );
  const recognized = total('recognizedItemResult'),
    denominator = total('soldProductionCost')
      .add(total('transactionExpenses'))
      .add(total('disposedCost'));
  const complete = projections.every((p) => p.metrics.allocationComplete);
  const durationTotal = projections.reduce(
    (sum, p) =>
      sum +
      (p.metrics.meanTimeToSellSeconds ?? 0) * p.metrics.timeToSellSampleSize,
    0,
  );
  const starts = projections.flatMap((p) =>
    p.metrics.turnoverWindowStart ? [p.metrics.turnoverWindowStart] : [],
  );
  const ends = projections.flatMap((p) =>
    p.metrics.turnoverWindowEnd ? [p.metrics.turnoverWindowEnd] : [],
  );
  const start = starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const end = ends.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const windowSeconds =
    start && end
      ? new D(Date.parse(end) - Date.parse(start)).div(1000)
      : new D(0);
  const averageUnits = windowSeconds.gt(0)
    ? total('inventoryUnitSeconds').div(windowSeconds)
    : null;
  return factoryMetricsSchema.parse({
    ...summed,
    turnoverWindowStart: start,
    turnoverWindowEnd: end,
    averageHeldUnits: averageUnits === null ? null : money(averageUnits),
    observedUnitTurnover:
      count.soldCount && averageUnits?.gt(0)
        ? money(new D(count.soldCount).div(averageUnits))
        : null,
    ...count,
    allocationComplete: complete,
    actualRoiPercent:
      complete && denominator.gt(0)
        ? money(recognized.div(denominator).mul(100))
        : null,
    meanTimeToSellSeconds: count.timeToSellSampleSize
      ? durationTotal / count.timeToSellSampleSize
      : null,
    observedSellThroughPercent:
      count.soldCount && count.producedCount
        ? money(new D(count.soldCount).div(count.producedCount).mul(100))
        : null,
    profitPerCraftingHour:
      complete &&
      (count.soldCount || total('disposedCost').gt(0)) &&
      count.craftingSeconds
        ? money(recognized.mul(3600).div(count.craftingSeconds))
        : null,
  });
}
