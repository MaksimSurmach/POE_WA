import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  analyzeOutcomeModel,
  simulateCraftingRisk,
} from '@poe-worksmith/domain';
import {
  buildGuidedOutcomeInput,
  emptyGuidedOutcome,
  type GuidedOutcomeDraft,
} from './guidedOutcomeModel.js';
import {
  CraftEconomicsSummary,
  CraftRiskResult,
  OutcomeModelSummary,
} from './CraftRiskSummary.js';
import {
  parseAdvancedOutcomeInput,
  OutcomeActionComparison,
} from './CraftRiskSection.js';

const now = '2026-11-04T12:00:00.000Z';
const draft: GuidedOutcomeDraft = {
  currency: 'chaos',
  base: '10',
  materials: '2',
  costSource: 'Labelled synthetic test spending',
  assumptions:
    'Synthetic independent terminal outcomes for UI regression; no game observations.',
  exclusive: true,
  outcomes: [
    {
      ...emptyGuidedOutcome('target'),
      name: 'Exact target',
      probability: '0.25',
      probabilitySource: 'Synthetic quarter probability',
      targetSuccess: true,
      sellable: true,
      resaleMin: '100',
      resaleMax: '100',
      resaleSource: 'Synthetic resale assumption',
      finishing: '4',
      recovery: '0',
    },
    {
      ...emptyGuidedOutcome('salvage'),
      name: 'Saleable imperfect result',
      classification: 'salvage',
      probability: '0.5',
      probabilitySource: 'Synthetic half probability',
      sellable: true,
      resaleMin: '20',
      resaleMax: '20',
      resaleSource: 'Synthetic salvage assumption',
      finishing: '0',
      recovery: '1',
    },
    {
      ...emptyGuidedOutcome('waste'),
      name: 'Unusable result',
      classification: 'unusable',
      probability: '0.25',
      probabilitySource: 'Synthetic quarter probability',
      finishing: '0',
      recovery: '2',
    },
  ],
};

function input() {
  return buildGuidedOutcomeInput(draft, 'Fixture League', now);
}

describe('outcome model entry', () => {
  it('charges per-outcome finishing and recovery only on their branch', () => {
    const model = input();
    const result = analyzeOutcomeModel(model);
    expect(result).toMatchObject({
      expectedTotalCost: '14',
      expectedCosts: {
        base: '10',
        material: '2',
        finishing: '1',
        recovery: '1',
      },
      expectedSalvageRecovery: { min: '10', max: '10' },
      expectedNetProfit: { min: '21', max: '21' },
    });
    expect(
      model.model.stages[0]!.outcomes[0]!.probability.provenance?.reference,
    ).toBe('Synthetic quarter probability');
    expect(model.valuations.salvage?.provenance.kind).toBe('assumption');
  });
  it('preserves a missing probability instead of inventing the residual', () => {
    const unknown = buildGuidedOutcomeInput(
      {
        ...draft,
        outcomes: draft.outcomes.map((row) =>
          row.id === 'waste' ? { ...row, probability: '' } : row,
        ),
      },
      'Fixture League',
      now,
    );
    expect(analyzeOutcomeModel(unknown)).toMatchObject({
      status: 'unavailable',
      expectedNetProfit: null,
    });
    expect(unknown.model.stages[0]!.outcomes[2]!.probability).toEqual({
      value: null,
      provenance: null,
    });
    const html = renderToStaticMarkup(
      <CraftEconomicsSummary analysis={analyzeOutcomeModel(unknown)} />,
    );
    expect(html).toContain('EV unavailable');
    expect(html).toContain('missing outcome probability');
  });
  it('rejects incomplete costs, unsupported probability totals and unconfirmed exclusivity', () => {
    expect(() =>
      buildGuidedOutcomeInput(
        { ...draft, materials: '' },
        'Fixture League',
        now,
      ),
    ).toThrow();
    expect(() =>
      buildGuidedOutcomeInput(
        { ...draft, exclusive: false },
        'Fixture League',
        now,
      ),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      buildGuidedOutcomeInput(
        { ...draft, outcomes: draft.outcomes.slice(0, 2) },
        'Fixture League',
        now,
      ),
    ).toThrow(/sum exactly/);
    expect(() =>
      buildGuidedOutcomeInput(
        {
          ...draft,
          outcomes: draft.outcomes.map((row) => ({ ...row, resaleSource: '' })),
        },
        'Fixture League',
        now,
      ),
    ).toThrow();
  });
  it('validates advanced imports and binds them to the selected league and evaluation time', () => {
    const imported = parseAdvancedOutcomeInput(
      JSON.stringify({
        ...input(),
        league: 'Old League',
        now: '2025-01-01T00:00:00Z',
      }),
      'Selected League',
      now,
    );
    expect(imported.league).toBe('Selected League');
    expect(imported.now).toBe(now);
    expect(() =>
      parseAdvancedOutcomeInput('[]', 'Fixture League', now),
    ).toThrow(/object/);
    expect(() =>
      parseAdvancedOutcomeInput(
        ' '.repeat(128 * 1024 + 1),
        'Fixture League',
        now,
      ),
    ).toThrow(/128 KiB/);
  });
});

describe('risk presentation', () => {
  it('preserves uncertain salvage ranges instead of showing a fabricated midpoint', () => {
    const model = input();
    model.valuations.salvage!.max = '40';
    const analysis = analyzeOutcomeModel(model);
    const html = renderToStaticMarkup(
      <CraftEconomicsSummary analysis={analysis} />,
    );
    expect(html).toContain('10 c – 20 c');
    expect(html).toContain('21 c – 31 c');
    expect(html).toContain('Modelled assumptions; not observed sales');
    const outcomes = renderToStaticMarkup(
      <OutcomeModelSummary model={model.model} />,
    );
    expect(outcomes).toContain('conditional on entering their stage');
  });
  it('shows unavailable censored results without drawing an apparently complete distribution', async () => {
    const risk = await simulateCraftingRisk({
      analysis: input(),
      objective: { kind: 'single-target', count: 1 },
      seed: 'ui-censored',
      trials: 100,
      budget: '100',
      maxTransitions: 1,
      reachWithinAttempts: 10,
    });
    expect(risk.status).toBe('unavailable');
    const html = renderToStaticMarkup(<CraftRiskResult result={risk} />);
    expect(html).toContain('Risk estimate unavailable');
    expect(html).toContain('Incomplete trials are not silently excluded');
    expect(html).not.toContain('<svg');
  });
  it('shows exact analytical quantiles without presenting fabricated histogram samples', async () => {
    const model = input();
    const stage = model.model.stages[0]!;
    stage.outcomes = [
      { ...stage.outcomes[0]!, costs: [] },
      {
        ...stage.outcomes[2]!,
        probability: { ...stage.outcomes[2]!.probability, value: '0.75' },
        costs: [],
      },
    ];
    const risk = await simulateCraftingRisk({
      analysis: model,
      objective: { kind: 'single-target', count: 1 },
      seed: 'analytic-ui',
      trials: 100,
      budget: '100',
      maxTransitions: 100,
      reachWithinAttempts: 10,
    });
    expect(risk.method).toBe('analytical-geometric');
    expect(risk.histogram).toEqual([]);
    const html = renderToStaticMarkup(<CraftRiskResult result={risk} />);
    expect(html).toContain('Analytical crafting budget by confidence level');
    expect(html).toContain('budgets, not simulated trial counts');
    expect(html).not.toContain('100 simulated trials');
  });

  it('explains deterministic costs instead of drawing a full-width histogram rectangle', async () => {
    const model = input();
    model.model.stages[0]!.outcomes.forEach((outcome) => {
      outcome.costs = [];
    });
    const risk = await simulateCraftingRisk({
      analysis: model,
      objective: { kind: 'attempts', count: 1 },
      seed: 'constant-cost-ui',
      trials: 100,
      budget: '12',
      maxTransitions: 100,
      reachWithinAttempts: 10,
    });
    expect(risk.histogram).toEqual([{ lower: '12', upper: '12', count: 100 }]);
    const html = renderToStaticMarkup(<CraftRiskResult result={risk} />);
    expect(html).toContain('Every modelled trial costs 12 c');
    expect(html).toContain('resale and profit can still vary');
    expect(html).not.toContain('<svg');
  });

  it('does not recommend a next action before every alternative and its evidence are entered', () => {
    const html = renderToStaticMarkup(
      <OutcomeActionComparison currency="chaos" />,
    );
    expect(html).toContain('No recommendation');
    expect(html).toContain('document the source');
    expect(html).toContain('exclude money already spent');
  });
});
