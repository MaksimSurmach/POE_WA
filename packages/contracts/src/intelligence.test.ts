import { describe, it, expect } from 'vitest';
import { capitalPlanCreateInputSchema } from './intelligence.js';
import { intelligenceSettingsSchema } from '@poe-worksmith/domain';
const tx = (currency: 'chaos' | 'divine', rate: string, price: string) => ({
  quantity: '1',
  unitPrice: price,
  currency,
  chaosPerUnit: rate,
  rateSource: 'Owner planning conversion assumption',
});
describe('intelligence planning contracts', () => {
  it('preserves selected denomination and rejects mismatched reserve conversion', () => {
    const request = {
      league: 'Synthetic League',
      capital: tx('divine', '150', '10'),
      reserve: tx('divine', '150', '2'),
      maxRiskProbability: 0.1,
      maxExposurePercent: 25,
      horizonDays: 14,
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    };
    expect(capitalPlanCreateInputSchema.parse(request).capital.currency).toBe(
      'divine',
    );
    expect(
      capitalPlanCreateInputSchema.safeParse({
        ...request,
        reserve: tx('divine', '151', '2'),
      }).success,
    ).toBe(false);
    expect(
      capitalPlanCreateInputSchema.safeParse({
        ...request,
        maxRiskProbability: 1.01,
      }).success,
    ).toBe(false);
    expect(
      capitalPlanCreateInputSchema.safeParse({ ...request, horizonDays: 1.5 })
        .success,
    ).toBe(false);
  });
  it('rejects an unfunded reserve using exact original-currency totals', () => {
    const input = {
      league: 'Synthetic League',
      capital: tx('divine', '150', '1'),
      reserve: tx('divine', '150', '1.0000000000000001'),
      maxRiskProbability: 0.1,
      maxExposurePercent: 25,
      horizonDays: 14,
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    };
    const result = capitalPlanCreateInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some(
          (issue) =>
            issue.message === 'Reserve cannot exceed available capital',
        ),
      ).toBe(true);
    expect(
      capitalPlanCreateInputSchema.safeParse({
        ...input,
        reserve: tx('divine', '150', '1'),
      }).success,
    ).toBe(true);
  });
  it('enforces independent evidence, ordered hysteresis and conservative scenario ceilings', () => {
    expect(intelligenceSettingsSchema.parse({})).toMatchObject({
      minIndependentSellers: 2,
      minConfirmations: 2,
      minOwnSaleSamples: 3,
    });
    expect(
      intelligenceSettingsSchema.safeParse({ minIndependentSellers: 1 })
        .success,
    ).toBe(false);
    expect(
      intelligenceSettingsSchema.safeParse({
        enterProfitChaos: '1',
        exitProfitChaos: '2',
      }).success,
    ).toBe(false);
    expect(
      intelligenceSettingsSchema.safeParse({ inputShockPercent: '1001' })
        .success,
    ).toBe(false);
    expect(
      intelligenceSettingsSchema.safeParse({
        conservativeRiskFraction: 0.9,
        balancedRiskFraction: 0.5,
      }).success,
    ).toBe(false);
  });
});
