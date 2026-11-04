import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  capitalPlanResponseSchema,
  opportunityViewSchema,
} from '@poe-worksmith/contracts';
import {
  intelligenceSettingsSchema,
  analyzeLiquidity,
  opportunitySignalSchema,
} from '@poe-worksmith/domain';
import { CapitalFields } from './CapitalFields.js';
import { consumeSignalEmissions } from './IntelligencePanel.js';
import { buildCapitalPlanInput, CapitalPlanView } from './CapitalAllocator.js';
import {
  LiquidityEvidence,
  OpportunityEvidence,
  objectiveLabel,
} from './IntelligenceEvidence.js';
import { createApiClient, ApiClientError } from './apiClient.js';

const now = '2026-11-04T12:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000001';
const cohort = {
  league: 'Synthetic League',
  targetSignature: 'synthetic-target-signature',
  currency: 'chaos' as const,
};
function requestForm() {
  const form = new FormData();
  Object.entries({
    capital: '10',
    reserve: '2',
    currency: 'divine',
    chaosPerUnit: '100',
    rateSource: 'Explicit synthetic planning assumption; not live',
    maxLossPercent: '20',
    maxExposurePercent: '50',
    horizonDays: '7',
  }).forEach(([key, value]) => form.set(key, value));
  return form;
}
function liquidity() {
  return analyzeLiquidity({
    cohort,
    now,
    settings: intelligenceSettingsSchema.parse({}),
    ownSales: [],
    ownInventory: [],
    ownCoverageComplete: true,
    snapshots: [
      {
        id: 'synthetic-snapshot',
        cohort,
        queryHash: 'synthetic-exact-query',
        capturedAt: now,
        expiresAt: '2026-11-04T13:00:00Z',
        coverage: 'complete',
        sortedSampleComplete: true,
        totalListings: 2,
        listings: [
          { id: 'a', seller: 'one', askChaos: '200', indexedAt: now },
          { id: 'b', seller: 'two', askChaos: '210', indexedAt: now },
        ],
      },
    ],
  });
}
function opportunity() {
  const assessment = liquidity();
  const signal = opportunitySignalSchema.parse({
    version: 'intelligence-1',
    recipeId: 'synthetic-recipe',
    recipeHash: 'revision-one',
    cohort,
    state: 'INSUFFICIENT_DATA',
    candidate: 'INSUFFICIENT_DATA',
    confirmations: 0,
    confirmationBasis: 'synthetic-evidence-revision',
    lastObservationId: assessment.snapshotId,
    lastObservedAt: now,
    lastEmittedAt: null,
    evaluatedAt: now,
    emit: false,
    triggers: [],
    reasons: ['Missing supported outcome probabilities'],
    evidenceIds: ['synthetic-snapshot'],
    metrics: {
      profit: null,
      materialCost: null,
      ask: '200',
      sellers: 2,
      listings: 2,
      riskAdjustedRoiPercent: null,
    },
  });
  return opportunityViewSchema.parse({
    recipeId: 'synthetic-recipe',
    title: 'Synthetic crafting recipe',
    category: 'wand',
    targetSignature: cohort.targetSignature,
    signal,
    liquidity: assessment,
    availableRiskOptions: [
      {
        id: 'synthetic-divine-risk',
        objective: { kind: 'successes', count: 3 },
        currency: 'divine',
        p90: '2',
        p95: '3',
        expectedProfit: '1',
      },
    ],
    reasons: [],
  });
}
function savedPlan(hold = false) {
  const request = buildCapitalPlanInput(requestForm(), cohort.league, id);
  const line = {
    recipeId: 'synthetic-recipe',
    title: 'Synthetic crafting recipe',
    targetSignature: cohort.targetSignature,
    riskRunId: id,
    objective: { kind: 'attempts', count: 4 },
    plannedCapital: '250',
    expectedProfit: '50',
    p90Budget: '200',
    p95Budget: '250',
    lossProbabilityUpperBound: 0.02,
    budgetExceedanceUpperBound: 0.05,
    combinedRiskUpperBound: 0.07,
    holdingDays: 1,
    ownSaleSamples: 3,
    liquidityCapacity: 4,
    reason: 'Labelled synthetic supported whole objective',
    stopCondition: 'Stop if evidence expires or costs exceed the saved budget',
  };
  return capitalPlanResponseSchema.parse({
    correlationId: id,
    data: {
      id,
      createdAt: now,
      plan: {
        version: 'intelligence-1',
        evaluatedAt: now,
        request: {
          league: request.league,
          capital: request.capital,
          reserve: request.reserve,
          maxRiskProbability: request.maxRiskProbability,
          maxExposurePercent: request.maxExposurePercent,
          horizonDays: request.horizonDays,
        },
        scenarios: ['conservative', 'balanced', 'aggressive'].map((name) => ({
          name,
          lines: hold ? [] : [line],
          allocatedCapital: hold ? '0' : '250',
          reservedCapital: hold ? '1000' : '750',
          expectedProfit: hold ? '0' : '50',
          unionRiskUpperBound: hold ? 0 : 0.07,
          statisticalConfidenceLowerBound: 0.95,
          status: hold ? 'hold' : 'plan',
          watchlist: hold
            ? [
                {
                  recipeId: 'missing-model',
                  reasons: ['Insufficient outcome probabilities'],
                },
              ]
            : [],
          sensitivity: {
            inputShockPercent: '10',
            plannedCapital: hold ? '0' : '275',
            expectedProfit: hold ? '0' : '25',
            fitsCapital: true,
            assumption: 'Labelled synthetic fixed-output sensitivity',
          },
          limitations: ['Synthetic display scenario; not live observations'],
        })),
        evidenceIds: ['synthetic-snapshot'],
      },
    },
  }).data;
}

describe('production intelligence UI', () => {
  it('keeps capital and reserve conversion identical and percentages in probability units', () => {
    const form = requestForm();
    form.append('recipeIds', 'synthetic-recipe');
    const request = buildCapitalPlanInput(form, cohort.league, id);
    expect(request).toMatchObject({
      capital: { unitPrice: '10', currency: 'divine', chaosPerUnit: '100' },
      reserve: { unitPrice: '2', currency: 'divine', chaosPerUnit: '100' },
      maxRiskProbability: 0.2,
      maxExposurePercent: 50,
      horizonDays: 7,
      recipeIds: ['synthetic-recipe'],
    });
    form.set('maxLossPercent', '');
    expect(() => buildCapitalPlanInput(form, cohort.league, id)).toThrow(
      /explicitly/,
    );
    form.set('maxLossPercent', '101');
    expect(() => buildCapitalPlanInput(form, cohort.league, id)).toThrow();
  });
  it('shows listing proxies without inventing sale duration or market demand', () => {
    const assessment = liquidity();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiquidityEvidence liquidity={assessment} />
      </MemoryRouter>,
    );
    expect(html).toContain('0 own confirmed-sale observations');
    expect(html).toContain('Median: Unavailable');
    expect(html).toContain('listing-to-sale timing sample: 0');
    expect(html).toContain('missing listings are not inferred sales');
    expect(html).toContain('200 c');
    expect(html).toContain('210 c');
    expect(html).not.toContain('Median: 0 sec');
    expect(html).toContain('exact output signature');
  });
  it('keeps saved risk currencies and objective horizons explicit', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OpportunityEvidence opportunity={opportunity()} />
      </MemoryRouter>,
    );
    expect(html).toContain('INSUFFICIENT DATA');
    expect(html).toContain('Missing supported outcome probabilities');
    expect(html).toContain('3 target items');
    expect(html).toContain('2 div');
    expect(html).toContain('3 div');
    expect(html).toContain('1 div');
    expect(objectiveLabel({ kind: 'attempts', count: 4 })).toBe(
      '4 complete method runs',
    );
    expect(objectiveLabel({ kind: 'single-target', count: 1 })).toBe(
      'One target item',
    );
  });
  it('renders a whole-objective production plan with reserve, risk bound, source and stop condition', () => {
    const saved = savedPlan();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CapitalPlanView saved={saved} />
      </MemoryRouter>,
    );
    expect(html).toContain('4 complete method runs');
    expect(html).toContain('250 c');
    expect(html).toContain('750 c');
    expect(html).toContain('3 own sale observations');
    expect(html).toContain('not a portfolio P95 estimate');
    expect(html).toContain('Modelled cash-loss bound');
    expect(html).toContain('all outputs sell at their stored valuations');
    expect(html).toContain('outside these probabilities');
    expect(html).toContain('Stop if evidence expires');
    expect(html).toContain('Explicit synthetic planning assumption');
    expect(html).toContain('Start this batch');
    expect(html).toContain('Allocation scenario');
  });
  it('recommends holding capital when no objective qualifies, with an explicit watchlist', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CapitalPlanView saved={savedPlan(true)} />
      </MemoryRouter>,
    );
    expect(html).toContain('Hold capital.');
    expect(html).toContain('Insufficient outcome probabilities');
    expect(html).not.toContain('Start this batch');
    expect(html).toContain('1,000 c');
  });
  it('describes the combined risk constraint rather than treating it as only chance of loss', () => {
    const html = renderToStaticMarkup(<CapitalFields />);
    expect(html).toContain('Maximum combined risk (%)');
    expect(html).toContain('cash loss or exceeding the planned P95 bankroll');
  });
  it('announces durable worker emissions once even after GET clears emit, with current state and session dedup', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const value = opportunity();
    value.recipeId = 'synthetic-notification';
    // The worker emitted; a subsequent GET recomputed this unchanged decision.
    value.signal.emit = false;
    value.signal.lastEmittedAt = now;
    expect(consumeSignalEmissions([value], storage)).toEqual([
      'Synthetic crafting recipe: signal update available; current state INSUFFICIENT DATA',
    ]);
    expect(consumeSignalEmissions([value], storage)).toEqual([]);
    value.signal.state = 'WATCH';
    value.signal.emit = false;
    // Cooldown permits current-state changes without a new emission timestamp.
    expect(value.signal.lastEmittedAt).toBe(now);
    expect(consumeSignalEmissions([value], storage)).toEqual([]);
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <OpportunityEvidence opportunity={value} />
        </MemoryRouter>,
      ),
    ).toContain('WATCH');
    value.signal.lastEmittedAt = '2026-11-04T12:01:00Z';
    expect(consumeSignalEmissions([value], storage)).toEqual([
      'Synthetic crafting recipe: signal update available; current state WATCH',
    ]);
    const restored = opportunity();
    restored.recipeId = 'synthetic-restored-notification';
    restored.signal.emit = false;
    restored.signal.lastEmittedAt = now;
    values.set(
      `worksmith:intelligence:emission:${cohort.league}:${restored.recipeId}`,
      now,
    );
    expect(consumeSignalEmissions([restored], storage)).toEqual([]);
  });
  it('keeps intelligence API requests owner-only, encoded, and idempotent', async () => {
    const denied = {
      correlationId: id,
      error: {
        category: 'internal',
        code: 'OPERATOR_AUTH_REQUIRED',
        disposition: 'permanent',
        message: 'Operator authentication is required.',
        retryable: false,
      },
    };
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(denied), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = createApiClient('', fetcher);
    await expect(
      client.getOpportunities('Synthetic League'),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetcher.mock.calls[0]![0]).toBe(
      '/api/admin/intelligence/opportunities?league=Synthetic%20League',
    );
    await expect(
      client.getOpportunityHistory('recipe/id', cohort.league),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetcher.mock.calls[1]![0]).toContain(
      '/recipes/recipe%2Fid/history?league=Synthetic%20League',
    );
    const input = buildCapitalPlanInput(requestForm(), cohort.league, id);
    await expect(client.createCapitalPlan(input)).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual(input);
  });
});
