import { describe, expect, it } from 'vitest';
import {
  analyzeOutcomeModel,
  recommendOutcomeAction,
} from './outcomeEconomics.js';
import {
  outcomeModelSchema,
  outcomeAnalysisInputSchema,
} from './outcomeModel.js';
import {
  syntheticOutcomeInput,
  syntheticOutcome,
  syntheticOutcomeSource as source,
} from './fixtures/outcomes.js';

describe('outcome economics', () => {
  it('keeps salvage in gross proceeds once and preserves negative EV', () => {
    expect(analyzeOutcomeModel(syntheticOutcomeInput())).toMatchObject({
      status: 'complete',
      expectedCosts: {
        base: '10',
        material: '2',
        finishing: '0',
        recovery: '0',
      },
      expectedBaseAcquisition: '1',
      expectedTotalCost: '12',
      expectedGrossResale: { min: '7.5', max: '7.5' },
      expectedSalvageRecovery: { min: '1.5', max: '1.5' },
      expectedNetProfit: { min: '-4.5', max: '-4.5' },
      expectedRoiPercent: { min: '-37.5', max: '-37.5' },
      targetProbability: '0.2',
      expectedSaleableItems: '0.5',
      breakEvenOutputPrice: { min: '52.5', max: '52.5' },
      breakEvenMaterialCost: { min: '-2.5', max: '-2.5' },
      sensitivity: expect.arrayContaining([
        expect.objectContaining({
          label: 'Materials +10%',
          netProfit: { min: '-4.7', max: '-4.7' },
        }),
      ]),
    });
  });
  it('solves retries and conditional finishing without multiplying finishing by rerolls', () => {
    const input = syntheticOutcomeInput();
    input.model.initialCosts = [input.model.stages[0]!.costs.shift()!];
    const stage = input.model.stages[0]!;
    stage.outcomes = [
      { ...syntheticOutcome('ready', '0.5'), nextStageId: 'finish' },
      { ...syntheticOutcome('retry', '0.5'), nextStageId: 'roll' },
    ];
    input.model.stages.push({
      id: 'finish',
      name: 'One finishing stage',
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
    const result = analyzeOutcomeModel(input);
    expect(result).toMatchObject({
      status: 'complete',
      expectedTotalCost: '17',
      expectedBaseAcquisition: '1',
      expectedCosts: { material: '4', finishing: '3' },
      expectedNetProfit: { min: '13', max: '13' },
      targetProbability: '1',
    });
    expect(result.stageValues.find((s) => s.stageId === 'roll')).toMatchObject({
      cost: '7',
    });
  });
  it('reports initial base acquisition even when the completed run retains that base', () => {
    const input = syntheticOutcomeInput();
    input.model.initialCosts = [input.model.stages[0]!.costs.shift()!];
    input.model.stages[0]!.outcomes = [
      { ...syntheticOutcome('retained', '1'), baseDisposition: 'retained' },
    ];
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'complete',
      expectedBaseAcquisition: '1',
      expectedCosts: { base: '10' },
    });
  });
  it('counts transition recovery costs and returned-resource credits separately', () => {
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
    expect(analyzeOutcomeModel(input)).toMatchObject({
      expectedCosts: { recovery: '2' },
      expectedTotalCost: '14',
      expectedRecoveryCredit: '1',
      expectedGrossResale: { min: '7.5', max: '7.5' },
      expectedNetProfit: { min: '-5.5', max: '-5.5' },
    });
  });
  it('carries value ranges through profit, break-even and sensitivity without inventing a midpoint', () => {
    const input = syntheticOutcomeInput();
    input.valuations.salvage!.max = '10';
    expect(analyzeOutcomeModel(input)).toMatchObject({
      expectedGrossResale: { min: '7.5', max: '9' },
      expectedNetProfit: { min: '-4.5', max: '-3' },
      breakEvenOutputPrice: { min: '45', max: '52.5' },
    });
  });
  it('rejects unnormalised probability mass and duplicate IDs', () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes.pop();
    expect(() => outcomeModelSchema.parse(input.model)).toThrow(/sum exactly/);
    input.model.stages[0]!.outcomes.push(syntheticOutcome('target', '0.5'));
    expect(() => outcomeModelSchema.parse(input.model)).toThrow(/unique/);
  });
  it('rejects malformed decimals as validation errors and overlapping exact targets', () => {
    const input = syntheticOutcomeInput();
    input.prices.base!.amount = 'not-money';
    expect(outcomeAnalysisInputSchema.safeParse(input).success).toBe(false);
    input.model.stages[0]!.outcomes[0]!.probability.value = 'not-a-rate';
    expect(outcomeModelSchema.safeParse(input.model).success).toBe(false);
    const overlap = syntheticOutcomeInput().model;
    overlap.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'same',
    };
    overlap.stages[0]!.outcomes[1]!.matching = {
      kind: 'exact-target',
      targetSignature: 'same',
    };
    expect(() => outcomeModelSchema.parse(overlap)).toThrow(/overlap/);
  });
  it('leaves explicit residual probability, missing quantity and nonabsorbing cycles unavailable', () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes[2]!.probability = {
      value: null,
      provenance: null,
    };
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'unavailable',
      expectedNetProfit: null,
      reasons: expect.arrayContaining(['waste: missing outcome probability']),
    });
    input.model.stages[0]!.outcomes = [
      { ...syntheticOutcome('loop', '1'), nextStageId: 'roll' },
    ];
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'unavailable',
      expectedTotalCost: null,
    });
    input.model.stages[0]!.costs[0]!.quantity = null;
    expect(analyzeOutcomeModel(input).reasons.join(' ')).toContain(
      'missing material quantity',
    );
  });
  it.each([
    'wrong-league',
    'stale',
    'single-seller',
    'partial',
    'wrong-target',
    'missing-market',
    'future-source',
    'mixed-currency',
  ])('does not value an outcome using %s evidence', (problem) => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'target-a',
    };
    input.valuations.target = {
      ...input.valuations.target!,
      matching: {
        kind: 'exact-target',
        targetSignature: problem === 'wrong-target' ? 'target-b' : 'target-a',
      },
      provenance: {
        ...source,
        kind: 'market-observation',
        recordedAt:
          problem === 'future-source'
            ? '2026-11-05T00:00:00Z'
            : source.recordedAt,
      },
      market: {
        league: problem === 'wrong-league' ? 'Other' : input.league,
        observedAt: source.recordedAt,
        expiresAt:
          problem === 'stale' ? source.recordedAt : '2026-11-04T02:00:00Z',
        coverage: problem === 'partial' ? 'partial' : 'complete',
        independentSellers: problem === 'single-seller' ? 1 : 2,
      },
    };
    if (problem === 'missing-market') delete input.valuations.target.market;
    if (problem === 'mixed-currency')
      input.valuations.target.currency = 'divine';
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'unavailable',
      expectedNetProfit: null,
    });
  });
  it('does not demand quotes on impossible paths and accepts honest partial purchase samples', () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes[0]!.probability.value = '0';
    input.model.stages[0]!.outcomes[2]!.probability.value = '0.7';
    delete input.valuations.target;
    input.prices.base = {
      ...input.prices.base!,
      provenance: { ...source, kind: 'market-observation' },
      market: {
        league: input.league,
        observedAt: source.recordedAt,
        expiresAt: '2026-11-04T02:00:00Z',
        coverage: 'partial',
        independentSellers: 1,
      },
    };
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'complete',
      targetProbability: '0',
      breakEvenOutputPrice: null,
    });
  });
  it('rejects retaining a base that is now a sellable or completed item', () => {
    const model = syntheticOutcomeInput().model;
    model.stages[0]!.outcomes[0]!.baseDisposition = 'retained';
    expect(() => outcomeModelSchema.parse(model)).toThrow(/consumes its base/);
  });
  it('accepts unknown seller counts for cost estimates but never for resale evidence', () => {
    const input = syntheticOutcomeInput();
    const market = {
      league: input.league,
      observedAt: source.recordedAt,
      expiresAt: '2026-11-04T02:00:00Z',
      coverage: 'complete' as const,
      independentSellers: null,
    };
    input.prices.base = {
      ...input.prices.base!,
      provenance: { ...source, kind: 'market-observation' },
      market,
    };
    expect(analyzeOutcomeModel(input).status).toBe('complete');
    input.model.stages[0]!.outcomes[0]!.matching = {
      kind: 'exact-target',
      targetSignature: 'target-a',
    };
    input.valuations.target = {
      ...input.valuations.target!,
      matching: { kind: 'exact-target', targetSignature: 'target-a' },
      provenance: { ...source, kind: 'market-observation' },
      market,
    };
    expect(analyzeOutcomeModel(input)).toMatchObject({
      status: 'unavailable',
      reasons: expect.arrayContaining([
        'target: insufficient independent sellers',
      ]),
    });
  });
  it('reports an unvalued retained base acquired inside a stage as well as in setup', () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes = [
      { ...syntheticOutcome('retained', '1'), baseDisposition: 'retained' },
    ];
    expect(analyzeOutcomeModel(input)).toMatchObject({
      valueBasis: 'cash-proceeds-minus-gross-outlay',
      unvaluedRetainedBaseProbability: '1',
    });
  });
  it('keeps tiny known probabilities instead of rounding them to zero', () => {
    const input = syntheticOutcomeInput();
    input.model.stages[0]!.outcomes = [
      syntheticOutcome('target', '0.0000000001', true, true),
      syntheticOutcome('waste', '0.9999999999'),
    ];
    expect(analyzeOutcomeModel(input).targetProbability).toBe('0.0000000001');
  });
  it('requires complete non-overlapping incremental action value evidence', () => {
    const values = {
      'keep-crafting': { min: '5', max: '10' },
      sell: { min: '12', max: '15' },
      recover: { min: '2', max: '4' },
      stop: { min: '0', max: '0' },
    };
    expect(recommendOutcomeAction(values).action).toBe('sell');
    expect(
      recommendOutcomeAction({ ...values, recover: null }).action,
    ).toBeNull();
    expect(
      recommendOutcomeAction({ ...values, sell: { min: '6', max: '15' } })
        .action,
    ).toBeNull();
    expect(
      recommendOutcomeAction({
        ...values,
        sell: { min: 'not-money', max: '15' },
      }).action,
    ).toBeNull();
  });
});
