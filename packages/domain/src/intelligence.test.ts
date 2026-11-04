import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { analyzeLiquidity } from './liquidity.js';
import { stepOpportunitySignal } from './opportunitySignals.js';
import {
  allocateCapital,
  allocationSamplingAllowance,
} from './capitalAllocation.js';
import {
  intelligenceSettingsSchema,
  liquiditySnapshotSchema,
  capitalAllocationRequestSchema,
  type LiquidityInput,
  type OpportunityEvidence,
  type CapitalCandidate,
  type IntelligenceRiskOption,
} from './intelligence.js';
import { factoryInventorySchema, factorySaleSchema } from './factoryLedger.js';
import { syntheticGeometricInput } from './fixtures/outcomes.js';
import { analyzeOutcomeModel } from './outcomeEconomics.js';
import {
  riskSimulationRequestSchema,
  simulateCraftingRisk,
} from './craftingRisk.js';
const now = '2026-11-04T01:30:00Z',
  settings = intelligenceSettingsSchema.parse({});
const cohort = {
  league: 'Synthetic League',
  targetSignature: 'synthetic-exact-target',
  currency: 'chaos' as const,
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tx = (price: string) => ({
  quantity: '1',
  unitPrice: price,
  currency: 'chaos' as const,
  chaosPerUnit: '1',
  rateSource: 'Labelled synthetic receipt',
});
function snapshot(
  key: string,
  capturedAt: string,
  listings = [
    {
      id: 'a',
      seller: 'seller-a',
      askChaos: '100',
      indexedAt: '2026-11-04T00:30:00Z',
    },
    {
      id: 'b',
      seller: 'seller-b',
      askChaos: '100',
      indexedAt: '2026-11-04T00:30:00Z',
    },
  ],
) {
  return liquiditySnapshotSchema.parse({
    id: key,
    cohort,
    queryHash: 'exact-query',
    capturedAt,
    expiresAt: '2026-11-04T02:00:00Z',
    coverage: 'complete',
    sortedSampleComplete: true,
    totalListings: listings.length,
    listings,
  });
}
function liquidityInput(): LiquidityInput {
  const ownInventory = [1, 2, 3].map((n) =>
    factoryInventorySchema.parse({
      id: id(n),
      batchId: id(10),
      recipeId: 'recipe',
      recipeTargetSignature: cohort.targetSignature,
      targetSignature: cohort.targetSignature,
      league: cohort.league,
      outcomeClassification: 'target',
      description: 'Labelled synthetic item',
      modifiers: [],
      outcome: 'target',
      producedAt: `2026-11-0${n}T00:00:00Z`,
      status: 'sold',
      statusChangedAt: `2026-11-0${n}T01:00:00Z`,
      allocations: [],
      allocatedCost: '12',
      listingPrice: tx('100'),
      listedAt: `2026-11-0${n}T00:30:00Z`,
      saleEventId: id(n + 20),
      soldAt: `2026-11-0${n}T01:00:00Z`,
      saleRevenue: '100',
      transactionExpenses: '0',
    }),
  );
  const ownSales = ownInventory.map((i) =>
    factorySaleSchema.parse({
      eventId: i.saleEventId,
      itemId: i.id,
      batchId: i.batchId,
      recipeId: i.recipeId,
      recipeTargetSignature: i.recipeTargetSignature,
      targetSignature: i.targetSignature,
      league: i.league,
      outcomeClassification: i.outcomeClassification,
      soldAt: i.soldAt,
      transaction: tx('100'),
      expenses: [],
      revenue: '100',
      allocatedCost: '12',
      transactionExpenses: '0',
      realizedProfit: '88',
      timeToSellSeconds: 1800,
      outcome: 'target',
    }),
  );
  return {
    cohort,
    now,
    settings,
    snapshots: [
      snapshot('old', '2026-11-04T01:10:00Z'),
      snapshot('new', '2026-11-04T01:20:00Z'),
    ],
    ownInventory,
    ownSales,
    ownCoverageComplete: true,
  };
}
async function evidence(): Promise<OpportunityEvidence> {
  const input = syntheticGeometricInput();
  input.now = now;
  input.model.stages[0]!.outcomes[0]!.probability.value = '1';
  input.model.stages[0]!.outcomes[1]!.probability.value = '0';
  input.model.stages[0]!.outcomes[0]!.matching = {
    kind: 'exact-target',
    targetSignature: cohort.targetSignature,
  };
  input.valuations.target!.matching = {
    kind: 'exact-target',
    targetSignature: cohort.targetSignature,
  };
  input.valuations.target!.provenance = {
    kind: 'market-observation',
    reference: 'evaluation:synthetic:old',
    recordedAt: '2026-11-04T01:10:00Z',
    notes: 'Labelled synthetic complete ask cohort, not live prices',
  };
  input.valuations.target!.market = {
    league: cohort.league,
    observedAt: '2026-11-04T01:10:00Z',
    expiresAt: '2026-11-04T02:00:00Z',
    coverage: 'complete',
    independentSellers: 2,
  };
  const request = riskSimulationRequestSchema.parse({
    analysis: input,
    objective: { kind: 'single-target', count: 1 },
    seed: 'synthetic-c',
    trials: 1000,
    budget: '100',
  });
  const risk: IntelligenceRiskOption = {
    id: 'risk-1',
    recipeId: 'recipe',
    recipeHash: 'revision',
    targetSignature: cohort.targetSignature,
    league: cohort.league,
    createdAt: now,
    request,
    result: await simulateCraftingRisk(request),
  };
  return {
    recipeId: 'recipe',
    recipeHash: 'revision',
    cohort,
    observationId: 'new',
    observedAt: '2026-11-04T01:20:00Z',
    analysisInput: input,
    analysis: analyzeOutcomeModel(input),
    risk,
    liquidity: analyzeLiquidity(liquidityInput()),
    additionalLiquidities: [],
  };
}
function confirm(e: OpportunityEvidence) {
  const first = stepOpportunitySignal({
    previous: null,
    evidence: e,
    settings,
    now,
  });
  const second = {
    ...e,
    observationId: 'next',
    observedAt: '2026-11-04T01:22:00Z',
    liquidity: {
      ...e.liquidity,
      snapshotId: 'next',
      observedAt: '2026-11-04T01:22:00Z',
      evidenceIds: [...e.liquidity.evidenceIds, 'next'],
    },
  };
  return stepOpportunitySignal({
    previous: first,
    evidence: second,
    settings,
    now,
  });
}
const request = () =>
  capitalAllocationRequestSchema.parse({
    league: cohort.league,
    capital: tx('100'),
    reserve: tx('20'),
    maxRiskProbability: 0.25,
    maxExposurePercent: 100,
    horizonDays: 30,
  });
const candidate = (e: OpportunityEvidence): CapitalCandidate => ({
  recipeId: e.recipeId,
  recipeHash: e.recipeHash,
  title: 'Synthetic craft',
  category: 'wand',
  targetSignature: cohort.targetSignature,
  league: cohort.league,
  signal: confirm(e),
  analysisInput: e.analysisInput,
  analysis: e.analysis,
  liquidity: e.liquidity,
  additionalLiquidities: [],
  options: [e.risk!],
});
describe('listing liquidity and own-sale evidence', () => {
  it('deduplicates listing IDs and seller identities without losing concentration or depth', () => {
    const input = liquidityInput();
    const offers = [
      {
        id: 'a',
        seller: 'Alice',
        askChaos: '0.000000001',
        indexedAt: '2026-11-04T00:30:00Z',
      },
      {
        id: 'b',
        seller: 'alice',
        askChaos: '2',
        indexedAt: '2026-11-04T00:30:00Z',
      },
      {
        id: 'c',
        seller: 'Bob',
        askChaos: '3',
        indexedAt: '2026-11-04T00:30:00Z',
      },
    ];
    input.snapshots = [snapshot('current', '2026-11-04T01:20:00Z', offers)];
    input.snapshots[0]!.listings.push(offers[0]!);
    const l = analyzeLiquidity(input);
    expect(l).toMatchObject({
      sellers: 2,
      listings: 3,
      largestSellerShare: 2 / 3,
      asking: { min: '0.000000001', median: '2' },
      depth: [
        { ask: '0.000000001', listings: 1 },
        { ask: '2', listings: 2 },
        { ask: '3', listings: 3 },
      ],
    });
  });
  it('keeps missing/reappeared listings as supply observations, never sales', () => {
    const input = liquidityInput();
    const a = {
        id: 'a',
        seller: 'a',
        askChaos: '100',
        indexedAt: '2026-11-04T00:30:00Z',
      },
      b = { ...a, id: 'b', seller: 'b' },
      c = { ...a, id: 'c', seller: 'c' };
    input.snapshots = [
      snapshot('older', '2026-11-04T01:00:00Z', [a, c]),
      snapshot('old', '2026-11-04T01:10:00Z', [b, c]),
      snapshot('new', '2026-11-04T01:20:00Z', [a, b]),
    ];
    const l = analyzeLiquidity(input);
    expect(l.changes).toMatchObject({ new: 0, reappeared: 1, missing: 1 });
    expect(l.own.confirmedSales).toHaveLength(3);
  });
  it('separates listing duration from production holding time and excludes unknown/different outputs', () => {
    const input = liquidityInput();
    input.ownSales[0]!.timeToSellSeconds = null;
    input.ownSales.push({
      ...input.ownSales[0]!,
      eventId: id(90),
      targetSignature: null,
    });
    input.ownSales.push({
      ...input.ownSales[0]!,
      eventId: id(91),
      league: 'Other League',
    });
    const l = analyzeLiquidity(input);
    expect(l.own).toMatchObject({
      sampleSize: 3,
      saleTimeSampleSize: 2,
      medianSellSeconds: 1800,
      medianHoldingSeconds: 3600,
      p75HoldingSeconds: 3600,
    });
  });
  it('rejects stale/partial coverage and does not count changed-query snapshots as confirmations', () => {
    const input = liquidityInput();
    input.snapshots[0]!.queryHash = 'different';
    expect(analyzeLiquidity(input).independentObservations).toBe(1);
    input.snapshots[1]!.totalListings = 100;
    expect(analyzeLiquidity(input).status).toBe('partial');
    input.now = '2026-11-04T03:00:00Z';
    expect(analyzeLiquidity(input).reasons).toContain(
      'Listing evidence is stale',
    );
  });
  it('rejects a listing indexed after its snapshot was captured', () => {
    const input = liquidityInput();
    input.snapshots[1]!.listings[0]!.indexedAt = '2026-11-04T01:25:00Z';
    expect(analyzeLiquidity(input).status).toBe('partial');
  });
});
describe('persisted opportunity decisions', () => {
  it('requires distinct observations, deduplicates refreshes and reaches CRAFT with supported evidence', async () => {
    const e = await evidence();
    const first = stepOpportunitySignal({
      previous: null,
      evidence: e,
      settings,
      now,
    });
    expect(first.state).toBe('WATCH');
    expect(
      stepOpportunitySignal({ previous: first, evidence: e, settings, now }),
    ).toMatchObject({ state: 'WATCH', confirmations: 1, emit: false });
    expect(confirm(e)).toMatchObject({ state: 'CRAFT', confirmations: 2 });
  });
  it('does not emit unchanged price/supply moves at a zero change threshold', async () => {
    const e = await evidence();
    const zero = {
      ...settings,
      materialMovePercent: '0',
      askMovePercent: '0',
      sellerMovePercent: '0',
      supplyGrowthPercent: '0',
    };
    const first = stepOpportunitySignal({
      previous: null,
      evidence: e,
      settings: zero,
      now,
    });
    const repeated = stepOpportunitySignal({
      previous: first,
      evidence: e,
      settings: zero,
      now,
    });
    expect(repeated.triggers).not.toContain('SUPPLY_GROWTH');
    expect(repeated.triggers).not.toContain('MATERIAL_PRICE_CHANGED');
    expect(repeated.emit).toBe(false);
  });
  it('immediately downgrades stale evidence during alert cooldown', async () => {
    const e = await evidence();
    const prior = confirm(e);
    prior.lastEmittedAt = '2026-11-04T01:59:59Z';
    const stale = stepOpportunitySignal({
      previous: prior,
      evidence: e,
      settings,
      now: '2026-11-04T02:00:01Z',
    });
    expect(stale).toMatchObject({ state: 'INSUFFICIENT_DATA', emit: false });
  });
  it('resets confirmations for changed thresholds, risk models and league', async () => {
    const e = await evidence(),
      prior = confirm(e);
    expect(
      stepOpportunitySignal({
        previous: prior,
        evidence: e,
        settings: { ...settings, enterProfitChaos: '20' },
        now,
      }),
    ).toMatchObject({ state: 'WATCH', confirmations: 1 });
    const changed = structuredClone(e);
    changed.risk!.id = 'new-model-risk';
    expect(
      stepOpportunitySignal({
        previous: prior,
        evidence: changed,
        settings,
        now,
      }).state,
    ).toBe('WATCH');
    changed.cohort.league = 'Other';
    expect(
      stepOpportunitySignal({
        previous: prior,
        evidence: changed,
        settings,
        now,
      }).state,
    ).toBe('INSUFFICIENT_DATA');
  });
  it('preserves the exit band for established crafts while changed math reconfirms, then resets below exit', async () => {
    const e = await evidence();
    const prior = confirm(e);
    expect(prior.hysteresisArmed).toBe(true);
    const lower = structuredClone(e);
    lower.analysisInput!.valuations.target!.min = '17';
    lower.analysisInput!.valuations.target!.max = '17';
    lower.risk!.request.analysis = lower.analysisInput!;
    lower.risk!.id = 'risk-lower-margin';
    lower.risk!.result = await simulateCraftingRisk(lower.risk!.request);
    lower.analysis = analyzeOutcomeModel(lower.analysisInput!);
    lower.liquidity.asking = {
      min: '17',
      p25: '17',
      median: '17',
      p75: '17',
      max: '17',
    };
    lower.observationId = 'lower-1';
    lower.observedAt = '2026-11-04T01:24:00Z';
    lower.liquidity.snapshotId = lower.observationId;
    lower.liquidity.observedAt = lower.observedAt;
    const first = stepOpportunitySignal({
      previous: prior,
      evidence: lower,
      settings,
      now,
    });
    expect(first).toMatchObject({
      state: 'WATCH',
      candidate: 'CRAFT',
      confirmations: 1,
      hysteresisArmed: true,
    });
    lower.observationId = 'lower-2';
    lower.observedAt = '2026-11-04T01:26:00Z';
    lower.liquidity.snapshotId = lower.observationId;
    lower.liquidity.observedAt = lower.observedAt;
    const reconfirmed = stepOpportunitySignal({
      previous: first,
      evidence: lower,
      settings,
      now,
    });
    expect(reconfirmed).toMatchObject({
      state: 'CRAFT',
      hysteresisArmed: true,
      metrics: { profit: '5' },
    });
    const current = candidate(lower);
    current.signal = reconfirmed;
    expect(
      allocateCapital({
        request: request(),
        candidates: [current],
        settings,
        now,
      }).scenarios[2]!.lines[0]?.riskRunId,
    ).toBe('risk-lower-margin');
    current.options = [
      { ...current.options[0]!, id: 'different-unconfirmed-option' },
    ];
    expect(
      allocateCapital({
        request: request(),
        candidates: [current],
        settings,
        now,
      }).scenarios[2]!.status,
    ).toBe('hold');
    expect(
      stepOpportunitySignal({
        previous: reconfirmed,
        evidence: lower,
        settings: { ...settings, exitProfitChaos: '6' },
        now,
      }),
    ).toMatchObject({ state: 'WATCH', hysteresisArmed: false });
  });
  it('tightening owner policy clears the old exit-band authorization', async () => {
    const e = await evidence(),
      prior = confirm(e),
      tightened = { ...settings, enterProfitChaos: '100' };
    e.observationId = 'policy-1';
    e.observedAt = '2026-11-04T01:24:00Z';
    e.liquidity.snapshotId = e.observationId;
    e.liquidity.observedAt = e.observedAt;
    const first = stepOpportunitySignal({
      previous: prior,
      evidence: e,
      settings: tightened,
      now,
    });
    expect(first).toMatchObject({
      state: 'WATCH',
      candidate: 'WATCH',
      hysteresisArmed: false,
      confirmations: 0,
    });
    e.observationId = 'policy-2';
    e.observedAt = '2026-11-04T01:26:00Z';
    e.liquidity.snapshotId = e.observationId;
    e.liquidity.observedAt = e.observedAt;
    expect(
      stepOpportunitySignal({
        previous: first,
        evidence: e,
        settings: tightened,
        now,
      }),
    ).toMatchObject({ state: 'WATCH', hysteresisArmed: false });
  });
  it('does not re-emit unchanged negative EV when its cooldown expires', async () => {
    const e = await evidence();
    e.analysisInput!.prices.orb!.amount = '200';
    e.risk!.request.analysis = e.analysisInput!;
    e.risk!.result = await simulateCraftingRisk(e.risk!.request);
    e.analysis = analyzeOutcomeModel(e.analysisInput!);
    const policy = { ...settings, cooldownSeconds: 60 };
    const stopped = stepOpportunitySignal({
      previous: null,
      evidence: e,
      settings: policy,
      now,
    });
    expect(stopped).toMatchObject({ state: 'STOP', emit: true });
    const repeated = stepOpportunitySignal({
      previous: stopped,
      evidence: e,
      settings: policy,
      now: '2026-11-04T01:32:00Z',
    });
    expect(repeated).toMatchObject({
      state: 'STOP',
      emit: false,
      lastEmittedAt: now,
    });
    expect(repeated.triggers).not.toContain('NEGATIVE_EV');
  });
  it('never promotes assumed resale or an unrelated high quote into a market-supported craft', async () => {
    const e = await evidence();
    e.analysisInput!.valuations.target!.provenance.kind = 'assumption';
    e.risk!.request.analysis = e.analysisInput!;
    expect(confirm(e).state).toBe('INSUFFICIENT_DATA');
    const high = await evidence();
    high.analysisInput!.valuations.target!.min = '1000';
    high.analysisInput!.valuations.target!.max = '1000';
    high.risk!.request.analysis = high.analysisInput!;
    expect(confirm(high).reasons.join(' ')).toContain('median asking');
  });
  it('stops negative EV and recognizes changed material prices without counting the view as new evidence', async () => {
    const e = await evidence();
    e.analysisInput!.prices.orb!.amount = '200';
    const r = riskSimulationRequestSchema.parse({
      ...e.risk!.request,
      analysis: e.analysisInput,
    });
    e.risk = { ...e.risk!, request: r, result: await simulateCraftingRisk(r) };
    e.analysis = analyzeOutcomeModel(e.analysisInput!);
    expect(confirm(e).state).toBe('STOP');
  });
});
describe('whole-objective capital allocation', () => {
  it('provides a positive feasible integer plan with exact capital, reserve and no scaled quantiles', async () => {
    const c = candidate(await evidence());
    const req = request();
    req.capital = tx('100.000000001');
    const result = allocateCapital({
      request: req,
      candidates: [c],
      settings,
      now,
    });
    for (const scenario of result.scenarios) {
      expect(scenario.status).toBe('plan');
      expect(scenario.lines[0]).toMatchObject({
        objective: { kind: 'single-target', count: 1 },
        plannedCapital: '12',
        p95Budget: '12',
        expectedProfit: '88',
      });
      expect(scenario.reservedCapital).toBe('88.000000001');
      expect(
        new Decimal(scenario.allocatedCapital)
          .add(scenario.reservedCapital)
          .eq('100.000000001'),
      ).toBe(true);
      expect(scenario.unionRiskUpperBound).toBe(0);
    }
  });
  it('preserves the full exact converted capital for a bounded extreme hold plan', () => {
    const bound = '999999999999.9999999999999999';
    const req = request();
    req.capital = {
      quantity: bound,
      unitPrice: bound,
      currency: 'divine',
      chaosPerUnit: bound,
      rateSource: 'Synthetic bounded arithmetic scenario',
    };
    req.reserve = { ...req.capital, quantity: '1', unitPrice: '0' };
    const digits = ((10n ** 28n - 1n) ** 3n).toString(),
      expected = digits.slice(0, -48) + '.' + digits.slice(-48);
    const plan = allocateCapital({
      request: req,
      candidates: [],
      settings,
      now,
    });
    for (const scenario of plan.scenarios)
      expect(scenario).toMatchObject({
        status: 'hold',
        allocatedCapital: '0',
        reservedCapital: expected,
      });
  });
  it('holds rather than inventing holding-time evidence or forcing negative EV/oversized batches', async () => {
    const c = candidate(await evidence());
    c.liquidity.own.confirmedSales = [];
    c.liquidity.own.sampleSize = 0;
    expect(
      allocateCapital({
        request: request(),
        candidates: [c],
        settings,
        now,
      }).scenarios.every((s) => s.status === 'hold'),
    ).toBe(true);
    const low = request();
    low.capital = tx('10');
    low.reserve = tx('1');
    expect(
      allocateCapital({
        request: low,
        candidates: [candidate(await evidence())],
        settings,
        now,
      }).scenarios[2]!.status,
    ).toBe('hold');
  });
  it('shares concentration limits across crafting methods for the same exact output', async () => {
    const first = candidate(await evidence());
    const second = structuredClone(first);
    second.recipeId = 'other-method';
    second.options[0]!.recipeId = 'other-method';
    second.options[0]!.id = 'risk-2';
    second.signal.recipeId = 'other-method';
    const req = request();
    req.maxExposurePercent = 15;
    const result = allocateCapital({
      request: req,
      candidates: [first, second],
      settings,
      now,
    });
    expect(result.scenarios[2]!.lines).toHaveLength(1);
  });
  it('uses one whole saved objective per recipe and rejects saleable retry output quantities', async () => {
    const e = await evidence(),
      c = candidate(e);
    c.options.push({ ...c.options[0]!, id: 'duplicate-option' });
    expect(
      allocateCapital({ request: request(), candidates: [c], settings, now })
        .scenarios[2]!.lines,
    ).toHaveLength(1);
    const failure = c.analysisInput!.model.stages[0]!.outcomes[1]!;
    failure.probability.value = '0.5';
    failure.sellable = true;
    failure.baseDisposition = 'consumed';
    failure.matching = {
      kind: 'exact-target',
      targetSignature: 'salvage-exact',
    };
    c.analysisInput!.model.stages[0]!.outcomes[0]!.probability.value = '0.5';
    c.analysisInput!.valuations[failure.id] = {
      ...c.analysisInput!.valuations.target!,
      matching: failure.matching,
    };
    c.additionalLiquidities = [
      {
        ...c.liquidity,
        cohort: { ...cohort, targetSignature: 'salvage-exact' },
      },
    ];
    c.options = c.options.slice(0, 1);
    c.options[0]!.request.analysis = c.analysisInput!;
    c.options[0]!.result = await simulateCraftingRisk(c.options[0]!.request);
    expect(
      allocateCapital({
        request: request(),
        candidates: [c],
        settings,
        now,
      }).scenarios[2]!.watchlist[0]!.reasons.join(' '),
    ).toContain('output-quantity risk model');
  });
  it('does not let a large profitable objective authorize an older marginal and riskier option', async () => {
    const e = await evidence(),
      input = e.analysisInput!;
    input.model.initialCosts = [
      {
        ...input.model.initialCosts[0]!,
        kind: 'material',
        resourceId: 'setup',
      },
    ];
    input.prices.setup = { ...input.prices.base!, amount: '40' };
    input.prices.orb!.amount = '6';
    input.model.stages[0]!.outcomes[0]!.probability.value = '0.6';
    input.model.stages[0]!.outcomes[1]!.probability.value = '0.4';
    input.valuations.target!.min = '50.5';
    input.valuations.target!.max = '50.5';
    const one = riskSimulationRequestSchema.parse({
      ...e.risk!.request,
      analysis: input,
      objective: { kind: 'single-target', count: 1 },
    });
    const ten = riskSimulationRequestSchema.parse({
      ...one,
      objective: { kind: 'successes', count: 10 },
    });
    const older = {
      ...e.risk!,
      id: 'older-one',
      request: one,
      result: await simulateCraftingRisk(one),
    };
    e.risk = {
      ...e.risk!,
      id: 'latest-ten',
      request: ten,
      result: await simulateCraftingRisk(ten),
    };
    e.analysis = analyzeOutcomeModel(input);
    expect(older.result).toMatchObject({
      meanProfit: '0.5',
      probabilityOfLoss: 0.4,
    });
    const c = candidate(e);
    expect(c.signal.state).toBe('CRAFT');
    c.options = [e.risk, older];
    const req = request();
    req.maxRiskProbability = 1;
    req.reserve = tx('0');
    const plan = allocateCapital({
      request: req,
      candidates: [c],
      settings,
      now,
    });
    expect(plan.scenarios.every((s) => s.status === 'hold')).toBe(true);
    const reasons = plan.scenarios[2]!.watchlist[0]!.reasons.join(' ');
    expect(reasons).toContain('configured profit threshold');
    expect(reasons).toContain('risk-adjusted ROI threshold');
    expect(reasons).toContain('cash-loss probability limit');
  });
  it.each(['initial', 'stage', 'outcome'] as const)(
    'protects rounded P95 budgets when a %s cost exceeds eight-decimal precision',
    async (position) => {
      const e = await evidence(),
        input = e.analysisInput!;
      const source = input.model.stages[0]!.costs[0]!.provenance;
      input.model.initialCosts = [];
      input.model.stages[0]!.costs = [
        {
          kind: 'material',
          resourceId: 'orb',
          quantity: '1',
          provenance: source,
        },
      ];
      input.prices.orb!.amount = '10';
      if (position === 'stage') input.prices.orb!.amount = '10.0000000049';
      else {
        input.prices.fraction = {
          ...input.prices.orb!,
          amount: '0.0000000049',
        };
        const term = {
          kind: 'finishing' as const,
          resourceId: 'fraction',
          quantity: '1',
          provenance: source,
        };
        if (position === 'initial') input.model.initialCosts = [term];
        else input.model.stages[0]!.outcomes[0]!.costs = [term];
      }
      e.risk!.request.analysis = input;
      e.risk!.result = await simulateCraftingRisk(e.risk!.request);
      e.analysis = analyzeOutcomeModel(input);
      expect(e.risk!.result.costQuantiles!.p95).toBe('10');
      const c = candidate(e),
        req = request();
      req.reserve = tx('0');
      req.capital = tx('10');
      expect(
        allocateCapital({ request: req, candidates: [c], settings, now })
          .scenarios[2]!.status,
      ).toBe('hold');
      req.capital = tx('10.0000000049');
      expect(
        allocateCapital({ request: req, candidates: [c], settings, now })
          .scenarios[2]!.status,
      ).toBe('hold');
      req.capital = tx('10.000000005');
      const plan = allocateCapital({
        request: req,
        candidates: [c],
        settings,
        now,
      }).scenarios[2]!;
      expect(plan.lines[0]).toMatchObject({
        plannedCapital: '10.000000005',
        p95Budget: '10',
      });
      expect(plan.lines[0]!.reason).toContain('eight-decimal cost quantile');
      expect(plan.allocatedCapital).toBe('10.000000005');
      expect(plan.reservedCapital).toBe('0');
      input.model.initialCosts = [];
      input.model.stages[0]!.outcomes[0]!.costs = [];
      input.prices.orb!.amount = '10';
      e.risk!.result = await simulateCraftingRisk(e.risk!.request);
      e.analysis = analyzeOutcomeModel(input);
      req.capital = tx('10');
      expect(
        allocateCapital({
          request: req,
          candidates: [candidate(e)],
          settings,
          now,
        }).scenarios[2]!.lines[0]?.plannedCapital,
      ).toBe('10');
    },
  );
  it('uses simultaneous sampling uncertainty and never lets aggressive exceed the user risk cap', async () => {
    const e = await evidence(),
      c = candidate(e);
    const r = riskSimulationRequestSchema.parse({
      ...e.risk!.request,
      objective: { kind: 'attempts', count: 1 },
    });
    c.options = [
      { ...e.risk!, request: r, result: await simulateCraftingRisk(r) },
    ];
    const one = allocationSamplingAllowance(c.options[0]!, 1),
      many = allocationSamplingAllowance(c.options[0]!, 20);
    expect(many).toBeGreaterThan(one);
    const req = request();
    req.maxRiskProbability = 0.01;
    expect(
      allocateCapital({
        request: req,
        candidates: [c],
        settings,
        now,
      }).scenarios.every((s) => s.status === 'hold'),
    ).toBe(true);
    req.maxRiskProbability = 0.25;
    const plan = allocateCapital({
      request: req,
      candidates: [c],
      settings,
      now,
    });
    for (const scenario of plan.scenarios)
      expect(scenario.unionRiskUpperBound).toBeLessThanOrEqual(0.25);
    expect(plan.scenarios[2]!.statisticalConfidenceLowerBound).toBe(0.95);
  });
});
