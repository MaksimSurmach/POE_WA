import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  outcomeAnalysisInputSchema,
  isOutcomeAmount,
  outcomeCalculationVersion,
  type OutcomeCost,
  type OutcomeCredit,
  type OutcomeAnalysisInput,
  type OutcomeModel,
  type MethodOutcome,
} from './outcomeModel.js';
import {
  analyzeOutcomeModel,
  outcomeMoney,
  reachableOutcomeStages,
} from './outcomeEconomics.js';

const D = Decimal.clone({ precision: 50 });
const amount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,16})?$/)
  .max(40)
  .refine(isOutcomeAmount);
export const craftingObjectiveSchema = z
  .strictObject({
    kind: z.enum(['attempts', 'successes', 'single-target']),
    count: z.number().int().min(1).max(1000),
  })
  .refine(
    (v) => v.kind !== 'single-target' || v.count === 1,
    'One target requires count one',
  );
export const riskSimulationRequestSchema = z.strictObject({
  analysis: outcomeAnalysisInputSchema,
  objective: craftingObjectiveSchema,
  seed: z.string().min(1).max(100),
  trials: z.number().int().min(100).max(10000).default(1000),
  budget: amount,
  maxTransitions: z.number().int().min(1).max(100000).default(10000),
  reachWithinAttempts: z.number().int().min(1).max(1000000).default(100),
});
export const riskQuantilesSchema = z.strictObject({
  p50: z.string(),
  p75: z.string(),
  p90: z.string(),
  p95: z.string(),
  p99: z.string(),
});
export const methodRunDefinition =
  'A method run executes the declared graph until a terminal outcome; internal stage retries are not separate runs. Setup costs are paid once; initial base inputs are reacquired before another run after a terminal outcome consumes them.';
export const riskSimulationResultSchema = z.strictObject({
  calculationVersion: z.literal(outcomeCalculationVersion),
  status: z.enum(['complete', 'unavailable', 'cancelled']),
  reasons: z.array(z.string()),
  method: z.enum(['seeded-monte-carlo', 'analytical-geometric']),
  dataKind: z.literal('modelled'),
  attemptDefinition: z.literal(methodRunDefinition),
  objective: craftingObjectiveSchema,
  currency: z.string(),
  seed: z.string(),
  trialsRequested: z.number().int(),
  trialsCompleted: z.number().int(),
  censoredTrials: z.number().int(),
  meanMethodRuns: z.number().nullable(),
  meanStageExecutions: z.number().nullable(),
  meanCost: z.string().nullable(),
  medianCost: z.string().nullable(),
  costQuantiles: riskQuantilesSchema.nullable(),
  meanProfit: z.string().nullable(),
  profitQuantiles: riskQuantilesSchema.nullable(),
  probabilityOverBudget: z.number().min(0).max(1).nullable(),
  probabilityOfLoss: z.number().min(0).max(1).nullable(),
  // First target only, not completion of an objective requiring multiple target items.
  atLeastOneTargetWithinRunsProbability: z.number().min(0).max(1).nullable(),
  reachWithinAttempts: z.number().int(),
  expectedShortfall95Cost: z.string().nullable(),
  expectedShortfall95Loss: z.string().nullable(),
  riskAdjustedRoiPercent: z.string().nullable(),
  capitalRequirements: z.array(
    z.strictObject({ confidence: z.number(), budget: z.string() }),
  ),
  percentileRankError95: z.number().nullable(),
  histogram: z.array(
    z.strictObject({
      lower: z.string(),
      upper: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type RiskSimulationRequest = z.infer<typeof riskSimulationRequestSchema>;
export type RiskSimulationResult = z.infer<typeof riskSimulationResultSchema>;

export function createCraftingRandom(seed: string) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
function quantile(sorted: Decimal[], q: number) {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}
function quantiles(sorted: Decimal[]) {
  return {
    p50: outcomeMoney(quantile(sorted, 0.5)),
    p75: outcomeMoney(quantile(sorted, 0.75)),
    p90: outcomeMoney(quantile(sorted, 0.9)),
    p95: outcomeMoney(quantile(sorted, 0.95)),
    p99: outcomeMoney(quantile(sorted, 0.99)),
  };
}
function mean(values: Decimal[]) {
  return values
    .reduce((total, value) => total.add(value), new D(0))
    .div(values.length);
}
function costOf(
  costs: (OutcomeCost | OutcomeCredit)[],
  input: OutcomeAnalysisInput,
) {
  return costs.reduce(
    (total, cost) =>
      new D(cost.quantity!).eq(0)
        ? total
        : total.add(
            new D(cost.quantity!).mul(input.prices[cost.resourceId]!.amount),
          ),
    new D(0),
  );
}

const geometricInputSchema = z.strictObject({
  successProbability: amount.refine(
    (p) => isOutcomeAmount(p) && new D(p).gt(0) && new D(p).lte(1),
  ),
  perAttemptCost: amount,
  setupCost: amount,
  saleValue: amount,
  budget: amount,
  withinAttempts: z.number().int().min(1).max(1000000),
});
/** Exact independent geometric benchmark; its assumptions are intentionally narrower than the stage graph. */
export function analyzeIndependentGeometric(
  raw: z.infer<typeof geometricInputSchema>,
) {
  const input = geometricInputSchema.parse(raw);
  const p = new D(input.successProbability);
  const failure = new D(1).sub(p);
  const setup = new D(input.setupCost);
  const unit = new D(input.perAttemptCost);
  const k = (q: string) =>
    p.eq(1)
      ? new D(1)
      : D.max(1, new D(1).sub(q).ln().div(failure.ln()).ceil());
  const over = (budget: string) => {
    if (setup.gt(budget)) return 1;
    if (unit.eq(0)) return 0;
    const attempts = new D(budget).sub(setup).div(unit).floor();
    return attempts.lt(1) ? 1 : failure.pow(attempts).toNumber();
  };
  const costs = {
    p50: outcomeMoney(setup.add(unit.mul(k('.5')))),
    p75: outcomeMoney(setup.add(unit.mul(k('.75')))),
    p90: outcomeMoney(setup.add(unit.mul(k('.9')))),
    p95: outcomeMoney(setup.add(unit.mul(k('.95')))),
    p99: outcomeMoney(setup.add(unit.mul(k('.99')))),
  };
  const tail = failure.pow(k('.95')).div(p).div('.05');
  return {
    meanCost: outcomeMoney(setup.add(unit.div(p))),
    costQuantiles: costs,
    probabilityOverBudget: over(input.budget),
    probabilityOfLoss: over(input.saleValue),
    atLeastOneTargetWithinRunsProbability: new D(1)
      .sub(failure.pow(input.withinAttempts))
      .toNumber(),
    expectedShortfall95Cost: outcomeMoney(
      setup.add(unit.mul(k('.95').add(tail))),
    ),
  };
}

export async function simulateCraftingRisk(
  raw: RiskSimulationRequest,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: {
      completed: number;
      total: number;
    }) => void | Promise<void>;
  } = {},
): Promise<RiskSimulationResult> {
  const request = riskSimulationRequestSchema.parse(raw);
  const input = request.analysis;
  const analysis = analyzeOutcomeModel(input);
  const result: RiskSimulationResult = {
    calculationVersion: outcomeCalculationVersion,
    status: 'unavailable',
    reasons: [...analysis.reasons],
    method: 'seeded-monte-carlo',
    dataKind: 'modelled',
    attemptDefinition: methodRunDefinition,
    objective: request.objective,
    currency: input.currency,
    seed: request.seed,
    trialsRequested: request.trials,
    trialsCompleted: 0,
    censoredTrials: 0,
    meanMethodRuns: null,
    meanStageExecutions: null,
    meanCost: null,
    medianCost: null,
    costQuantiles: null,
    meanProfit: null,
    profitQuantiles: null,
    probabilityOverBudget: null,
    probabilityOfLoss: null,
    atLeastOneTargetWithinRunsProbability: null,
    reachWithinAttempts: request.reachWithinAttempts,
    expectedShortfall95Cost: null,
    expectedShortfall95Loss: null,
    riskAdjustedRoiPercent: null,
    capitalRequirements: [],
    percentileRankError95: null,
    histogram: [],
  };
  if (options.signal?.aborted)
    return {
      ...result,
      status: 'cancelled',
      reasons: ['Simulation cancelled'],
    };
  if (analysis.status !== 'complete') return result;
  const stages = reachableOutcomeStages(input);
  for (const outcome of stages.flatMap((s) => s.outcomes))
    if (outcome.sellable && new D(outcome.probability.value!).gt(0)) {
      const quote = input.valuations[outcome.id]!;
      if (!new D(quote.min).eq(quote.max))
        result.reasons.push(
          `${outcome.id}: resale range has no justified probability distribution; risk simulation unavailable`,
        );
    }
  if (
    request.objective.kind !== 'attempts' &&
    new D(analysis.targetProbability!).eq(0)
  )
    result.reasons.push('Target cannot be reached by this model');
  if (result.reasons.length) return result;
  const geometric = independentGeometricResult(request, result, stages);
  if (geometric) {
    await options.onProgress?.({
      completed: request.trials,
      total: request.trials,
    });
    return options.signal?.aborted
      ? { ...result, status: 'cancelled', reasons: ['Simulation cancelled'] }
      : geometric;
  }
  const random = createCraftingRandom(
    `${outcomeCalculationVersion}:${request.seed}`,
  );
  const byId = new Map(stages.map((s) => [s.id, s]));
  const stageCosts = new Map(stages.map((s) => [s.id, costOf(s.costs, input)]));
  const transitionValues = new Map(
    stages.flatMap((s) =>
      s.outcomes
        .filter((o) => new D(o.probability.value!).gt(0))
        .map(
          (o) =>
            [
              o.id,
              {
                cost: costOf(o.costs, input),
                credit: costOf(o.credits, input),
              },
            ] as const,
        ),
    ),
  );
  const setupCost = costOf(input.model.initialCosts, input);
  const replacementBaseCost = costOf(
    input.model.initialCosts.filter((c) => c.kind === 'base'),
    input,
  );
  const costs: Decimal[] = [];
  const profits: Decimal[] = [];
  let totalMethodRuns = 0;
  let totalStageExecutions = 0;
  let transitions = 0;
  let cancellation = false;
  const maximumOperations = 2_000_000;
  for (let trial = 0; trial < request.trials; trial++) {
    let cost = setupCost;
    let revenue = new D(0);
    let successes = 0;
    let runs = 0;
    let trialTransitions = 0;
    let nextStage: string | null = input.model.startStageId;
    while (nextStage !== null) {
      if (
        trialTransitions >= request.maxTransitions ||
        transitions >= maximumOperations
      )
        break;
      if ((transitions & 511) === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await options.onProgress?.({ completed: trial, total: request.trials });
        if (options.signal?.aborted) {
          cancellation = true;
          break;
        }
      }
      transitions++;
      trialTransitions++;
      const stage: OutcomeModel['stages'][number] = byId.get(nextStage)!;
      cost = cost.add(stageCosts.get(stage.id)!);
      // Two 32-bit draws retain resolution below the smallest supported probability (1e-16).
      const draw = new D(Math.floor(random() * 4294967296))
        .mul(4294967296)
        .add(Math.floor(random() * 4294967296))
        .add('.5')
        .div('18446744073709551616');
      let cumulative = new D(0);
      const outcome: MethodOutcome = stage.outcomes.find((candidate) => {
        cumulative = cumulative.add(candidate.probability.value!);
        return draw.lt(cumulative);
      })!;
      const transition = transitionValues.get(outcome.id)!;
      cost = cost.add(transition.cost);
      revenue = revenue.add(transition.credit);
      if (outcome.nextStageId !== null) nextStage = outcome.nextStageId;
      else {
        runs++;
        if (outcome.sellable)
          revenue = revenue.add(input.valuations[outcome.id]!.min);
        if (outcome.targetSuccess) successes++;
        const finished =
          request.objective.kind === 'attempts'
            ? runs >= request.objective.count
            : successes >= request.objective.count;
        if (!finished && outcome.baseDisposition === 'consumed')
          cost = cost.add(replacementBaseCost);
        nextStage = finished ? null : input.model.startStageId;
      }
    }
    if (cancellation) break;
    if (nextStage !== null) result.censoredTrials++;
    else {
      costs.push(cost);
      profits.push(revenue.sub(cost));
      totalMethodRuns += runs;
      totalStageExecutions += trialTransitions;
    }
    result.trialsCompleted = trial + 1;
    if ((trial + 1) % 100 === 0 || trial + 1 === request.trials)
      await options.onProgress?.({
        completed: trial + 1,
        total: request.trials,
      });
    if (transitions >= maximumOperations) {
      result.censoredTrials += request.trials - trial - 1;
      break;
    }
  }
  if (cancellation || options.signal?.aborted)
    return {
      ...result,
      status: 'cancelled',
      reasons: ['Simulation cancelled; no incomplete distribution is reported'],
    };
  if (result.censoredTrials > 0 || costs.length !== request.trials)
    return {
      ...result,
      reasons: [
        'Simulation resource limit reached; censored trials prevent defensible tail and loss estimates',
      ],
    };
  costs.sort((a, b) => a.comparedTo(b));
  profits.sort((a, b) => a.comparedTo(b));
  const loss = profits
    .map((p) => D.max(p.neg(), 0))
    .sort((a, b) => a.comparedTo(b));
  const costMean = mean(costs);
  const profitMean = mean(profits);
  const cq = quantiles(costs);
  const tailCount = Math.max(1, Math.ceil(request.trials * 0.05));
  const minimum = costs[0]!;
  const maximum = costs[costs.length - 1]!;
  const width = maximum.sub(minimum).div(12);
  const bins = Array.from({ length: width.eq(0) ? 1 : 12 }, (_, i) => ({
    lower: outcomeMoney(minimum.add(width.mul(i))),
    upper: outcomeMoney(width.eq(0) ? maximum : minimum.add(width.mul(i + 1))),
    count: 0,
  }));
  for (const cost of costs)
    bins[
      width.eq(0)
        ? 0
        : Math.min(11, cost.sub(minimum).div(width).floor().toNumber())
    ]!.count++;
  const targetP = new D(analysis.targetProbability!);
  return {
    ...result,
    status: 'complete',
    meanMethodRuns: totalMethodRuns / request.trials,
    meanStageExecutions: totalStageExecutions / request.trials,
    meanCost: outcomeMoney(costMean),
    medianCost: cq.p50,
    costQuantiles: cq,
    meanProfit: outcomeMoney(profitMean),
    profitQuantiles: quantiles(profits),
    probabilityOverBudget:
      costs.filter((v) => v.gt(request.budget)).length / request.trials,
    probabilityOfLoss: profits.filter((v) => v.lt(0)).length / request.trials,
    atLeastOneTargetWithinRunsProbability: new D(1)
      .sub(new D(1).sub(targetP).pow(request.reachWithinAttempts))
      .toNumber(),
    expectedShortfall95Cost: outcomeMoney(mean(costs.slice(-tailCount))),
    expectedShortfall95Loss: outcomeMoney(mean(loss.slice(-tailCount))),
    riskAdjustedRoiPercent: new D(cq.p95).gt(0)
      ? outcomeMoney(profitMean.div(cq.p95).mul(100))
      : null,
    capitalRequirements: [
      { confidence: 0.5, budget: cq.p50 },
      { confidence: 0.75, budget: cq.p75 },
      { confidence: 0.9, budget: cq.p90 },
      { confidence: 0.95, budget: cq.p95 },
      { confidence: 0.99, budget: cq.p99 },
    ],
    percentileRankError95: Math.sqrt(Math.log(40) / (2 * request.trials)),
    histogram: bins,
  };
}

function independentGeometricResult(
  request: RiskSimulationRequest,
  empty: RiskSimulationResult,
  stages: OutcomeModel['stages'],
): RiskSimulationResult | null {
  if (
    request.objective.kind === 'attempts' ||
    request.objective.count !== 1 ||
    stages.length !== 1
  )
    return null;
  const stage = stages[0]!;
  const outcomes = stage.outcomes.filter((o) =>
    new D(o.probability.value!).gt(0),
  );
  const successes = outcomes.filter((o) => o.targetSuccess && o.sellable);
  if (
    successes.length !== 1 ||
    outcomes.some(
      (o) =>
        o.nextStageId !== null ||
        o.credits.length ||
        (!o.targetSuccess && (o.sellable || o.costs.length)),
    )
  )
    return null;
  const success = successes[0]!;
  const input = request.analysis;
  const initialBaseCost = costOf(
    input.model.initialCosts.filter((c) => c.kind === 'base'),
    input,
  );
  const failures = outcomes.filter((o) => !o.targetSuccess);
  const dispositions = new Set(failures.map((o) => o.baseDisposition));
  if (initialBaseCost.gt(0) && dispositions.size > 1) return null;
  const replacement =
    failures.length > 0 && dispositions.has('consumed')
      ? initialBaseCost
      : new D(0);
  const setup = costOf(input.model.initialCosts, input)
    .add(costOf(success.costs, input))
    .sub(replacement);
  const unit = costOf(stage.costs, input).add(replacement);
  if (setup.gt('1e12') || unit.gt('1e12')) return null;
  const sale = new D(input.valuations[success.id]!.min);
  const p = Number(success.probability.value);
  const exact = analyzeIndependentGeometric({
    successProbability: success.probability.value!,
    perAttemptCost: setup.eq(0) && unit.eq(0) ? '0' : unit.toFixed(),
    setupCost: setup.toFixed(),
    saleValue: sale.toFixed(),
    budget: request.budget,
    withinAttempts: request.reachWithinAttempts,
  });
  const profitAt = (q: number) => {
    const k =
      p === 1
        ? new D(1)
        : D.max(
            1,
            new D(1)
              .add(
                new D(q)
                  .ln()
                  .div(new D(1).sub(success.probability.value!).ln()),
              )
              .floor(),
          );
    return outcomeMoney(sale.sub(setup).sub(unit.mul(k)));
  };
  const threshold = D.max(exact.costQuantiles.p95, sale);
  let excess = new D(0);
  if (unit.gt(0)) {
    const n = D.max(0, threshold.sub(setup).div(unit).floor());
    const probability = new D(1).sub(success.probability.value!).pow(n);
    excess = setup
      .add(unit.mul(new D(n).add(new D(1).div(success.probability.value!))))
      .sub(threshold)
      .mul(probability);
  }
  const expectedLossTail = D.max(
    new D(exact.costQuantiles.p95).sub(sale),
    0,
  ).add(excess.div('.05'));
  const profitMean = sale.sub(exact.meanCost);
  return {
    ...empty,
    ...exact,
    status: 'complete',
    method: 'analytical-geometric',
    meanMethodRuns: 1 / p,
    meanStageExecutions: 1 / p,
    medianCost: exact.costQuantiles.p50,
    meanProfit: outcomeMoney(profitMean),
    profitQuantiles: {
      p50: profitAt(0.5),
      p75: profitAt(0.75),
      p90: profitAt(0.9),
      p95: profitAt(0.95),
      p99: profitAt(0.99),
    },
    expectedShortfall95Loss: outcomeMoney(expectedLossTail),
    riskAdjustedRoiPercent: new D(exact.costQuantiles.p95).gt(0)
      ? outcomeMoney(profitMean.div(exact.costQuantiles.p95).mul(100))
      : null,
    percentileRankError95: 0,
    capitalRequirements: [
      { confidence: 0.5, budget: exact.costQuantiles.p50 },
      { confidence: 0.75, budget: exact.costQuantiles.p75 },
      { confidence: 0.9, budget: exact.costQuantiles.p90 },
      { confidence: 0.95, budget: exact.costQuantiles.p95 },
      { confidence: 0.99, budget: exact.costQuantiles.p99 },
    ],
  };
}
