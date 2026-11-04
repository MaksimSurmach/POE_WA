import { Decimal } from 'decimal.js';
import {
  capitalAllocationRequestSchema,
  capitalCandidateSchema,
  capitalAllocationPlanSchema,
  intelligenceSettingsSchema,
  intelligenceVersion,
  type CapitalAllocationRequest,
  type CapitalCandidate,
  type CapitalAllocationPlan,
  type IntelligenceSettings,
  type IntelligenceRiskOption,
  type LiquidityAssessment,
} from './intelligence.js';
import { factoryTransactionChaos } from './factoryLedger.js';
import {
  intelligenceRiskIssues,
  saleableCohortIssues,
  signalPolicyMatches,
  signalConfirmsRiskOption,
} from './opportunitySignals.js';
const D = Decimal.clone({ precision: 120 }),
  money = (v: Decimal) => v.toFixed();
/** Saved risk costs use HALF_UP to eight decimals. A half-unit buffer bounds
 * the original quantile whenever a charged term can exceed that precision. */
function quantileRoundingGuard(option: IntelligenceRiskOption): Decimal {
  const input = option.request.analysis;
  const costs = [
    ...input.model.initialCosts,
    ...input.model.stages.flatMap((stage) => [
      ...stage.costs,
      ...stage.outcomes.flatMap((outcome) => outcome.costs),
    ]),
  ];
  const needsGuard = costs.some(
    (cost) =>
      cost.quantity !== null &&
      input.prices[cost.resourceId] !== undefined &&
      new D(cost.quantity)
        .mul(input.prices[cost.resourceId]!.amount)
        .decimalPlaces() > 8,
  );
  return new D(needsGuard ? '0.000000005' : '0');
}
/** Simultaneous 95% DKW coverage across both cost and profit CDFs of every examined option (Bonferroni). */
export const allocationSamplingConfidence = 0.95;
export function allocationSamplingAllowance(
  option: IntelligenceRiskOption,
  examinedOptions: number,
): number {
  return option.result.method === 'analytical-geometric'
    ? 0
    : Math.min(
        1,
        Math.sqrt(
          Math.log(
            (4 * Math.max(1, examinedOptions)) /
              (1 - allocationSamplingConfidence),
          ) /
            (2 * Math.max(1, option.result.trialsCompleted)),
        ),
      );
}
function holdingCapacity(
  liquidity: LiquidityAssessment,
  horizonDays: number,
  minimumSamples: number,
  now: string,
): { reasons: string[]; capacity: number; holdingDays: number } {
  const reasons: string[] = [];
  const horizonSeconds = horizonDays * 86400;
  if (
    liquidity.status !== 'supported' ||
    !liquidity.expiresAt ||
    Date.parse(liquidity.expiresAt) <= Date.parse(now)
  )
    reasons.push('Listing evidence is stale or incomplete');
  if (!liquidity.own.coverageComplete)
    reasons.push('Own factory observations are incomplete');
  const start = Date.parse(now) - horizonSeconds * 1000;
  const recent = liquidity.own.confirmedSales.filter(
    (s) =>
      Date.parse(s.soldAt) >= start &&
      Date.parse(s.soldAt) <= Date.parse(now) &&
      s.holdingSeconds !== null,
  );
  const times = recent.map((s) => s.holdingSeconds!).sort((a, b) => a - b);
  const holding = times.length
    ? times[Math.ceil(times.length * 0.75) - 1]!
    : Infinity;
  if (times.length < minimumSamples)
    reasons.push(
      `At least ${minimumSamples} own confirmed holding-time samples within the investment horizon are required`,
    );
  if (holding > horizonSeconds)
    reasons.push('Observed holding time exceeds the investment horizon');
  if ((liquidity.own.oldestUnsoldSeconds ?? 0) > horizonSeconds)
    reasons.push(
      'Existing unsold inventory already exceeds the investment horizon',
    );
  const capacity = Math.max(0, recent.length - liquidity.own.unsoldCount);
  if (capacity === 0)
    reasons.push('No observed sales capacity remains after unsold inventory');
  return {
    reasons,
    capacity,
    holdingDays: Number.isFinite(holding) ? holding / 86400 : 0,
  };
}
export function allocateCapital(raw: {
  request: CapitalAllocationRequest;
  candidates: CapitalCandidate[];
  settings: IntelligenceSettings;
  now: string;
}): CapitalAllocationPlan {
  const request = capitalAllocationRequestSchema.parse(raw.request),
    candidates = raw.candidates.map((c) => capitalCandidateSchema.parse(c)),
    settings = intelligenceSettingsSchema.parse(raw.settings),
    now = raw.now;
  if (candidates.length > 100)
    throw new RangeError('At most 100 recipe candidates are supported');
  const capital = new D(factoryTransactionChaos(request.capital)),
    reserve = new D(factoryTransactionChaos(request.reserve));
  const spendable = D.max(0, capital.sub(reserve));
  const exposure = capital.mul(request.maxExposurePercent).div(100);
  const examined = Math.max(
    1,
    candidates.reduce((n, c) => n + c.options.length, 0),
  );
  type Option = {
    candidate: CapitalCandidate;
    option: IntelligenceRiskOption;
    bankroll: Decimal;
    roundingGuard: Decimal;
    profit: Decimal;
    loss: number;
    overrun: number;
    combined: number;
    holdingDays: number;
    capacity: number;
    cohortUnits: Map<string, number>;
    score: Decimal;
    mc: boolean;
  };
  const eligible: Option[] = [],
    rejected = new Map<string, string[]>();
  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (candidate.league !== request.league) reasons.push('Different league');
    if (request.recipeIds && !request.recipeIds.includes(candidate.recipeId))
      reasons.push('Recipe is outside selected restrictions');
    if (request.categories && !request.categories.includes(candidate.category))
      reasons.push('Category is outside selected restrictions');
    if (!signalPolicyMatches(candidate.signal, settings))
      reasons.push('Signal confirmations belong to different policy settings');
    if (candidate.signal.state !== 'CRAFT')
      reasons.push(`Current opportunity state is ${candidate.signal.state}`);
    if (!candidate.analysisInput)
      reasons.push('Outcome model or economic evidence is missing');
    if (!candidate.options.length)
      reasons.push('Simulate the desired whole batch to provide a risk option');
    const liquidities = [
      candidate.liquidity,
      ...candidate.additionalLiquidities,
    ];
    if (candidate.analysisInput)
      reasons.push(
        ...saleableCohortIssues(candidate.analysisInput, liquidities),
      );
    if (reasons.length) {
      rejected.set(candidate.recipeId, [...new Set(reasons)]);
      continue;
    }
    let accepted = false;
    const optionReasons: string[] = [];
    for (const option of candidate.options) {
      const issues = intelligenceRiskIssues(
        option,
        candidate.analysisInput!,
        candidate,
        now,
      );
      const result = option.result;
      if (issues.length) {
        optionReasons.push(...issues);
        continue;
      }
      const outcomes = candidate
        .analysisInput!.model.stages.flatMap((s) => s.outcomes)
        .filter((o) => o.sellable && o.probability.value !== '0');
      if (
        result.objective.kind !== 'attempts' &&
        outcomes.some((o) => !o.targetSuccess)
      ) {
        optionReasons.push(
          'Target-success objectives with saleable retry outcomes need an output-quantity risk model before allocation',
        );
        continue;
      }
      const units = new Map<string, number>();
      for (const outcome of outcomes) {
        if (outcome.matching.kind === 'exact-target')
          units.set(outcome.matching.targetSignature, result.objective.count);
      }
      if (!units.size) {
        optionReasons.push('No exactly valued saleable output cohort');
        continue;
      }
      let capacity = Number.MAX_SAFE_INTEGER,
        holdingDays = 0;
      for (const [signature, count] of units) {
        const liquidity = liquidities.find(
          (l) =>
            l.cohort.targetSignature === signature &&
            l.cohort.league === request.league,
        )!;
        const holding = holdingCapacity(
          liquidity,
          request.horizonDays,
          settings.minOwnSaleSamples,
          now,
        );
        issues.push(...holding.reasons);
        if (count > holding.capacity)
          issues.push(
            'Whole simulated batch exceeds the observed cohort sales capacity',
          );
        capacity = Math.min(capacity, holding.capacity);
        holdingDays = Math.max(holdingDays, holding.holdingDays);
      }
      const roundingGuard = quantileRoundingGuard(option);
      const bankroll = new D(result.costQuantiles!.p95).add(roundingGuard),
        profit = new D(result.meanProfit!);
      if (!bankroll.gt(0))
        issues.push('A positive supported bankroll is required');
      if (!profit.gt(0)) issues.push('Expected profit is not positive');
      const confirmedExitBand = signalConfirmsRiskOption(
        candidate.signal,
        settings,
        option.id,
      );
      const requiredProfit = confirmedExitBand
        ? settings.exitProfitChaos
        : settings.enterProfitChaos;
      const requiredRoi = confirmedExitBand
        ? settings.exitRiskAdjustedRoiPercent
        : settings.enterRiskAdjustedRoiPercent;
      if (profit.lt(requiredProfit))
        issues.push(
          'This risk option is below the configured profit threshold',
        );
      if (bankroll.gt(0) && profit.div(bankroll).mul(100).lt(requiredRoi))
        issues.push(
          'This risk option is below the configured risk-adjusted ROI threshold',
        );
      if (result.probabilityOfLoss! > settings.maxLossProbability)
        issues.push(
          'This risk option exceeds the configured cash-loss probability limit',
        );
      if (bankroll.gt(spendable))
        issues.push('Whole batch exceeds available capital after reserve');
      if (bankroll.gt(exposure))
        issues.push('Whole batch exceeds maximum recipe exposure');
      const epsilon = allocationSamplingAllowance(option, examined);
      const loss = Math.min(1, result.probabilityOfLoss! + epsilon);
      // Exact deterministic geometric success has no bankroll tail; otherwise P95 contributes a 5% model tail.
      const deterministic =
        result.method === 'analytical-geometric' &&
        candidate.analysisInput!.model.stages.length === 1 &&
        candidate.analysisInput!.model.stages[0]!.outcomes.some(
          (o) =>
            o.targetSuccess &&
            o.probability.value !== null &&
            new D(o.probability.value).eq(1),
        );
      const overrun = deterministic ? 0 : Math.min(1, 0.05 + epsilon);
      const combined = Math.min(1, loss + overrun);
      if (combined > request.maxRiskProbability)
        issues.push(
          'Combined cash-loss and bankroll-overrun bound exceeds the user risk limit',
        );
      if (issues.length) {
        optionReasons.push(...issues);
        continue;
      }
      eligible.push({
        candidate,
        option,
        bankroll,
        roundingGuard,
        profit,
        loss,
        overrun,
        combined,
        holdingDays,
        capacity,
        cohortUnits: units,
        score: profit.div(bankroll).mul(1 - combined),
        mc: result.method !== 'analytical-geometric',
      });
      accepted = true;
    }
    if (!accepted)
      rejected.set(candidate.recipeId, [...new Set(optionReasons)]);
  }
  eligible.sort(
    (a, b) =>
      b.score.cmp(a.score) ||
      b.profit.cmp(a.profit) ||
      a.candidate.recipeId.localeCompare(b.candidate.recipeId) ||
      a.option.id.localeCompare(b.option.id),
  );
  const scenarios = (
    [
      ['conservative', settings.conservativeRiskFraction],
      ['balanced', settings.balancedRiskFraction],
      ['aggressive', 1],
    ] as const
  ).map(([name, fraction]) => {
    const chosen: Option[] = [],
      recipes = new Set<string>(),
      targetCapital = new Map<string, Decimal>(),
      targetUnits = new Map<string, number>();
    let spent = new D(0),
      profit = new D(0),
      risk = 0;
    for (const option of eligible) {
      if (
        recipes.has(option.candidate.recipeId) ||
        spent.add(option.bankroll).gt(spendable) ||
        risk + option.combined > request.maxRiskProbability * fraction
      )
        continue;
      if (
        (targetCapital.get(option.candidate.targetSignature) ?? new D(0))
          .add(option.bankroll)
          .gt(exposure)
      )
        continue;
      if (
        [...option.cohortUnits].some(
          ([signature, count]) =>
            (targetUnits.get(signature) ?? 0) + count >
            holdingCapacity(
              [
                option.candidate.liquidity,
                ...option.candidate.additionalLiquidities,
              ].find((l) => l.cohort.targetSignature === signature)!,
              request.horizonDays,
              settings.minOwnSaleSamples,
              now,
            ).capacity,
        )
      )
        continue;
      chosen.push(option);
      recipes.add(option.candidate.recipeId);
      spent = spent.add(option.bankroll);
      profit = profit.add(option.profit);
      risk += option.combined;
      targetCapital.set(
        option.candidate.targetSignature,
        (targetCapital.get(option.candidate.targetSignature) ?? new D(0)).add(
          option.bankroll,
        ),
      );
      for (const [signature, count] of option.cohortUnits)
        targetUnits.set(signature, (targetUnits.get(signature) ?? 0) + count);
    }
    const shock = new D(settings.inputShockPercent).div(100),
      stressedCapital = spent.mul(shock.add(1)),
      stressedProfit = profit.sub(
        chosen
          .reduce((total, o) => total.add(o.option.result.meanCost!), new D(0))
          .mul(shock),
      );
    return {
      name,
      lines: chosen.map((o) => ({
        recipeId: o.candidate.recipeId,
        title: o.candidate.title,
        targetSignature: o.candidate.targetSignature,
        riskRunId: o.option.id,
        objective: o.option.result.objective,
        plannedCapital: money(o.bankroll),
        expectedProfit: money(o.profit),
        p90Budget: o.option.result.costQuantiles!.p90,
        p95Budget: o.option.result.costQuantiles!.p95,
        lossProbabilityUpperBound: o.loss,
        budgetExceedanceUpperBound: o.overrun,
        combinedRiskUpperBound: o.combined,
        holdingDays: o.holdingDays,
        ownSaleSamples: o.candidate.liquidity.own.sampleSize,
        liquidityCapacity: o.capacity,
        reason:
          'Whole simulated objective fits capital, concentration, observed holding capacity and the combined risk budget.' +
          (o.roundingGuard.gt(0)
            ? ' Planned bankroll includes a 0.000000005 chaos guard for the saved eight-decimal cost quantile.'
            : '') +
          (o.candidate.analysis?.basis !== 'observations'
            ? ' Probabilities or input costs include explicitly declared model assumptions; inspect the linked saved risk evidence.'
            : ''),
        stopCondition:
          'Stop if the signal leaves CRAFT, any used evidence expires, input prices change, or unsold inventory exceeds the observed capacity.',
      })),
      allocatedCapital: money(spent),
      reservedCapital: money(capital.sub(spent)),
      expectedProfit: money(profit),
      unionRiskUpperBound: Math.min(1, risk),
      statisticalConfidenceLowerBound: chosen.some((o) => o.mc)
        ? allocationSamplingConfidence
        : 1,
      status: chosen.length ? ('plan' as const) : ('hold' as const),
      watchlist: candidates
        .filter((c) => !recipes.has(c.recipeId))
        .map((c) => ({
          recipeId: c.recipeId,
          reasons: rejected.get(c.recipeId) ?? [
            'A whole saved objective does not fit this scenario after diversification, liquidity and risk constraints',
          ],
        })),
      sensitivity: {
        inputShockPercent: settings.inputShockPercent,
        plannedCapital: money(stressedCapital),
        expectedProfit: money(stressedProfit),
        fitsCapital: stressedCapital.lte(spendable),
        assumption:
          'All crafting input spending increases by the stated percentage; proceeds and outcome probabilities are unchanged. This is a scenario, not a new market quote.',
      },
      limitations: [
        'Advisory model, not executed trades or historical investment returns.',
        'Per-option P95 budgets are not a portfolio P95. The displayed risk is a union bound for cash loss or bankroll overrun; no independence is assumed.',
        'Sampling bounds simultaneously cover examined Monte Carlo cost/profit distributions at the displayed confidence, conditional on the declared model.',
        'Own completed sales bound trial production capacity; asking supply and missing listings are not sales or demand.',
        'Greedy selection is feasible and deterministic; it does not claim a globally optimal portfolio.',
      ],
    };
  });
  return capitalAllocationPlanSchema.parse({
    version: intelligenceVersion,
    evaluatedAt: now,
    request,
    scenarios,
    evidenceIds: [
      ...new Set(
        candidates.flatMap((c) => [
          ...c.signal.evidenceIds,
          ...c.options.map((o) => o.id),
        ]),
      ),
    ],
  });
}
