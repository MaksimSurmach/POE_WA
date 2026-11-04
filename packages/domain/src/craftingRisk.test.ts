import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  analyzeIndependentGeometric,
  simulateCraftingRisk,
  type RiskSimulationRequest,
} from './craftingRisk.js';
import {
  syntheticGeometricInput,
  syntheticOutcomeInput,
  syntheticOutcome,
  syntheticOutcomeSource as source,
} from './fixtures/outcomes.js';

function request(analysis = syntheticGeometricInput()): RiskSimulationRequest {
  return {
    analysis,
    objective: { kind: 'single-target', count: 1 },
    seed: 'labelled-synthetic-42',
    trials: 1000,
    budget: '20',
    maxTransitions: 10000,
    reachWithinAttempts: 5,
  };
}
describe('crafting risk', () => {
  it('uses exact independent geometric results for one target with a reusable base', async () => {
    const result = await simulateCraftingRisk(request());
    expect(result).toMatchObject({
      status: 'complete',
      method: 'analytical-geometric',
      dataKind: 'modelled',
      meanCost: '18',
      meanProfit: '82',
      meanMethodRuns: 4,
      meanStageExecutions: 4,
      costQuantiles: { p50: '16', p75: '20', p90: '28', p95: '32', p99: '44' },
      probabilityOverBudget: new Decimal('.75').pow(5).toNumber(),
      targetWithinRunsProbability: new Decimal(1)
        .sub(new Decimal('.75').pow(5))
        .toNumber(),
    });
    expect(Number(result.expectedShortfall95Cost)).toBeCloseTo(
      10 + 2 * (11 + 0.75 ** 11 / 0.25 / 0.05),
      7,
    );
    expect(result.histogram).toEqual([]);
  });
  it('charges a replacement base on each declared new attempt, not once per target', async () => {
    const result = await simulateCraftingRisk(
      request(syntheticGeometricInput(false)),
    );
    expect(result).toMatchObject({
      method: 'analytical-geometric',
      meanCost: '48',
      costQuantiles: { p90: '108', p95: '132' },
    });
  });
  it('replaces initial bases after destruction or salvage, but not after the final produced item', async () => {
    const destroyed = syntheticGeometricInput();
    destroyed.model.stages[0]!.outcomes[1]!.baseDisposition = 'consumed';
    expect(await simulateCraftingRisk(request(destroyed))).toMatchObject({
      meanCost: '48',
    });
    const sold = syntheticGeometricInput();
    sold.model.stages[0]!.outcomes = [
      syntheticOutcome('target', '1', true, true),
    ];
    expect(
      await simulateCraftingRisk({
        ...request(sold),
        objective: { kind: 'successes', count: 2 },
      }),
    ).toMatchObject({ meanCost: '24', meanProfit: '176', meanMethodRuns: 2 });
    sold.model.stages[0]!.outcomes = [
      syntheticOutcome('salvage', '1', false, true),
    ];
    sold.valuations.salvage = {
      ...sold.valuations.target!,
      matching: { kind: 'manual', description: 'Synthetic salvage' },
      min: '5',
      max: '5',
    };
    expect(
      await simulateCraftingRisk({
        ...request(sold),
        objective: { kind: 'attempts', count: 2 },
      }),
    ).toMatchObject({ meanCost: '24', meanProfit: '-14' });
  });
  it('distinguishes a fixed batch of attempts from producing a batch of targets', async () => {
    const runs = await simulateCraftingRisk({
      ...request(),
      objective: { kind: 'attempts', count: 2 },
    });
    expect(runs).toMatchObject({
      status: 'complete',
      method: 'seeded-monte-carlo',
      meanMethodRuns: 2,
      meanStageExecutions: 2,
      costQuantiles: { p50: '14', p99: '24' },
    });
    // Replacement is needed only when the first of two runs produced an item: 14 + .25×10.
    expect(Math.abs(Number(runs.meanCost) - 16.5)).toBeLessThan(
      6 * Math.sqrt(18.75 / 1000),
    );
    const successes = await simulateCraftingRisk({
      ...request(),
      trials: 10000,
      objective: { kind: 'successes', count: 2 },
    });
    expect(successes.status).toBe('complete');
    // Negative binomial r=2, p=1/4: mean 2 bases+2r/p=36, variance 2²r(1-p)/p²=96.
    expect(Math.abs(Number(successes.meanCost) - 36)).toBeLessThan(
      6 * Math.sqrt(96 / 10000),
    );
    expect(Number(successes.costQuantiles!.p90)).toBeGreaterThan(36);
    const k90 = (Number(successes.costQuantiles!.p90) - 20) / 2;
    const cdf = (k: number) => 1 - 0.75 ** k - k * 0.25 * 0.75 ** (k - 1);
    expect(cdf(k90)).toBeGreaterThanOrEqual(
      0.9 - successes.percentileRankError95!,
    );
    expect(cdf(k90 - 1)).toBeLessThanOrEqual(
      0.9 + successes.percentileRankError95!,
    );
    expect(
      successes.capitalRequirements.find((c) => c.confidence === 0.95)?.budget,
    ).toBe(successes.costQuantiles!.p95);
  });
  it('reproduces multistep conditional costs with the same model and seed', async () => {
    const input = syntheticGeometricInput();
    input.model.stages[0]!.outcomes = [
      { ...syntheticOutcome('advance', '0.5'), nextStageId: 'finish' },
      { ...syntheticOutcome('retry', '0.5'), nextStageId: 'roll' },
    ];
    input.model.stages.push({
      id: 'finish',
      name: 'Synthetic finish',
      exclusivity: { mode: 'disjoint', provenance: source },
      costs: [
        {
          kind: 'finishing',
          resourceId: 'orb',
          quantity: '1.5',
          provenance: source,
        },
      ],
      outcomes: [syntheticOutcome('target', '1', true, true)],
    });
    const a = await simulateCraftingRisk(request(input));
    const b = await simulateCraftingRisk(request(input));
    expect(a).toEqual(b);
    expect(a.status).toBe('complete');
    expect(a.meanMethodRuns).toBe(1);
    expect(a.meanStageExecutions).toBeGreaterThan(2);
    // Geometric roll count p=.5: expected 17, cost variance 2²(1-p)/p²=8.
    expect(Math.abs(Number(a.meanCost) - 17)).toBeLessThan(
      6 * Math.sqrt(8 / 1000),
    );
    expect(a.histogram.reduce((n, bin) => n + bin.count, 0)).toBe(1000);
    expect(a.percentileRankError95).toBeCloseTo(Math.sqrt(Math.log(40) / 2000));
  });
  it('includes multiple salvage outcomes, recovery costs and credits in a negative-EV batch', async () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes[2]!.costs = [
      {
        kind: 'recovery',
        resourceId: 'orb',
        quantity: '2',
        provenance: source,
      },
    ];
    input.model.stages[0]!.outcomes[2]!.credits = [
      { resourceId: 'orb', quantity: '1', provenance: source },
    ];
    const result = await simulateCraftingRisk({
      ...request(input),
      trials: 10000,
      objective: { kind: 'attempts', count: 1 },
    });
    expect(result.status).toBe('complete');
    expect(Number(result.meanCost)).toBeCloseTo(14, 0);
    expect(Number(result.meanProfit)).toBeCloseTo(-5.5, 0);
    expect(result.probabilityOfLoss).toBeCloseTo(0.8, 1);
    expect(Number(result.expectedShortfall95Loss)).toBe(14);
  });
  it('never samples an invented distribution for resale ranges or missing probabilities', async () => {
    const input = syntheticOutcomeInput();
    input.valuations.salvage!.max = '7';
    const ranged = await simulateCraftingRisk(request(input));
    expect(ranged).toMatchObject({
      status: 'unavailable',
      probabilityOfLoss: null,
      costQuantiles: null,
    });
    expect(ranged.reasons.join(' ')).toContain(
      'no justified probability distribution',
    );
    input.model.stages[0]!.outcomes[2]!.probability = {
      value: null,
      provenance: null,
    };
    expect(await simulateCraftingRisk(request(input))).toMatchObject({
      status: 'unavailable',
      meanCost: null,
    });
  });
  it('does not drop censored trials and report optimistic cost or loss quantiles', async () => {
    const result = await simulateCraftingRisk({
      ...request(),
      objective: { kind: 'successes', count: 2 },
      maxTransitions: 1,
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      costQuantiles: null,
      probabilityOfLoss: null,
    });
    expect(result.censoredTrials).toBe(1000);
  });
  it('supports progress and cooperative cancellation without publishing partial distributions', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    const result = await simulateCraftingRisk(
      { ...request(), objective: { kind: 'attempts', count: 1 } },
      {
        signal: controller.signal,
        onProgress: ({ completed }) => {
          progress.push(completed);
          controller.abort();
        },
      },
    );
    expect(progress[0]).toBe(0);
    expect(result).toMatchObject({
      status: 'cancelled',
      meanCost: null,
      costQuantiles: null,
    });
  });
  it('handles deterministic success and zero spending without division-by-zero ROI', async () => {
    const input = syntheticGeometricInput();
    input.model.initialCosts = [];
    input.model.stages[0]!.costs = [];
    input.model.stages[0]!.outcomes = [
      syntheticOutcome('target', '1', true, true),
    ];
    expect(await simulateCraftingRisk(request(input))).toMatchObject({
      status: 'complete',
      meanCost: '0',
      probabilityOfLoss: 0,
      probabilityOverBudget: 0,
      riskAdjustedRoiPercent: null,
      expectedShortfall95Loss: '0',
    });
    expect(
      analyzeIndependentGeometric({
        successProbability: '1',
        perAttemptCost: '2',
        setupCost: '10',
        saleValue: '11',
        budget: '12',
        withinAttempts: 1,
      }),
    ).toMatchObject({
      meanCost: '12',
      probabilityOverBudget: 0,
      probabilityOfLoss: 1,
    });
  });
  it('keeps a rare positive target probability and rejects oversized simulation requests', async () => {
    const input = syntheticGeometricInput();
    input.model.stages[0]!.outcomes[0]!.probability.value = '0.0000000001';
    input.model.stages[0]!.outcomes[1]!.probability.value = '0.9999999999';
    expect(await simulateCraftingRisk(request(input))).toMatchObject({
      status: 'complete',
      method: 'analytical-geometric',
      meanCost: '20000000010',
    });
    await expect(
      simulateCraftingRisk({ ...request(), trials: 100000 }),
    ).rejects.toThrow();
  });
});
