import { describe, expect, it, vi } from 'vitest';
import {
  createCraftAnalysisService,
  resolveCraftAnalysisEvidence,
} from './craftAnalysis.js';
import { craftModelFixture, craftFixtureAt } from './testkit/craftAnalysis.js';
import type { CraftAnalysisRepository } from './repositories/craftAnalysisRepository.js';

type Row = Awaited<
  ReturnType<CraftAnalysisRepository['readValuationCandidates']>
>[number];
const now = new Date(craftFixtureAt);
function row(): Row {
  const model = craftModelFixture();
  return {
    recipe_id: model.recipeId,
    recipe_content_hash: model.recipeHash,
    target_signature: model.targetSignature,
    currency: 'chaos',
    estimated_sale_price: '20',
    evaluated_at: now,
    source_snapshot_dedupe_key: 'synthetic:snapshot',
    method_cost: {
      recipeContentHash: model.recipeHash,
      oldestInputAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      baseCost: { amount: '3', currency: 'chaos' },
      steps: [
        {
          materials: [
            {
              itemId: 'material',
              unitPrice: { amount: '2', currency: 'chaos' },
            },
          ],
        },
      ],
      source: {
        capturedAt: new Date(now.getTime() - 60_000).toISOString(),
        sampleSize: 2,
        coverage: 'complete',
        currencyAvailable: true,
      },
      saleEvidence: { status: 'accepted' },
      materialEvidence: {
        base: {
          league: model.league,
          source: 'poe-trade',
          capturedAt: new Date(now.getTime() - 60_000).toISOString(),
          sortedSampleComplete: true,
        },
        material: {
          league: model.league,
          source: 'poe.ninja',
          capturedAt: new Date(now.getTime() - 60_000).toISOString(),
          bulkSupported: true,
          priceBasis: 'economy-estimate',
        },
      },
    },
  };
}
describe('analysis evidence from existing market pipeline', () => {
  it('uses fresh comparable target evidence but never substitutes it for salvage', () => {
    const model = { ...craftModelFixture(), prices: {}, valuations: {} };
    const result = resolveCraftAnalysisEvidence(model, [row()], now, 120_000);
    expect(result.prices.base?.amount).toBe('3');
    expect(result.prices.material?.amount).toBe('2');
    expect(result.prices.material?.market?.independentSellers).toBeNull();
    expect(result.valuations.target?.min).toBe('20');
    expect(result.valuations.salvage).toBeUndefined();
  });
  it.each([
    'stale',
    'partial',
    'singleton',
    'signature',
    'revision',
    'blocked',
    'future',
  ])('rejects unsupported resale: %s', (failure) => {
    const model = { ...craftModelFixture(), prices: {}, valuations: {} };
    const value = row();
    const evidence = value.method_cost!;
    const source = evidence.source as Record<string, unknown>;
    if (failure === 'stale') evidence.expiresAt = craftFixtureAt;
    if (failure === 'partial') source.coverage = 'partial';
    if (failure === 'singleton') source.sampleSize = 1;
    if (failure === 'signature') value.target_signature = 'other-output';
    if (failure === 'revision') evidence.recipeContentHash = 'previous-recipe';
    if (failure === 'blocked')
      evidence.saleEvidence = { status: 'unverified_output_value' };
    if (failure === 'future')
      source.capturedAt = new Date(now.getTime() + 1000).toISOString();
    expect(
      resolveCraftAnalysisEvidence(model, [value], now, 120_000).valuations,
    ).toEqual({});
  });
  it('retains explicit manual ranges and rejects old or wrong-league input quotes', () => {
    const model = craftModelFixture();
    model.valuations.salvage!.max = '5';
    delete model.prices.material;
    const value = row();
    const inputs = value.method_cost!.materialEvidence as Record<
      string,
      Record<string, unknown>
    >;
    inputs.material!.league = 'Another League';
    const result = resolveCraftAnalysisEvidence(model, [value], now, 120_000);
    expect(result.prices.base?.amount).toBe('1');
    expect(result.prices.material).toBeUndefined();
    expect(result.valuations.salvage).toMatchObject({
      min: '2',
      max: '5',
      provenance: { kind: 'assumption' },
    });
  });
});

describe('craft analysis worker wake', () => {
  it('drains on startup and on a notification, not on a fast poll', async () => {
    let wake = () => {};
    const unlisten = vi.fn(async () => {});
    const withWorker = vi.fn(async () => true);
    const service = createCraftAnalysisService({
      repository: {
        withWorker,
        listen: async (onWake: () => void) => {
          wake = onWake;
          return unlisten;
        },
      } as unknown as CraftAnalysisRepository,
      recipes: {} as never,
      leagues: {} as never,
      maximumQuoteAgeMs: async () => 60_000,
    });
    service.start();
    await vi.waitFor(() => expect(withWorker).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(withWorker).toHaveBeenCalledTimes(1);
    wake();
    await vi.waitFor(() => expect(withWorker).toHaveBeenCalledTimes(2), {
      timeout: 300,
    });
    await service.close();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
