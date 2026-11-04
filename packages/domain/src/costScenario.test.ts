import { describe, expect, it } from 'vitest';
import { calculateCostScenario } from './economics.js';

const input = {
  bases: '100',
  other: '10',
  sale: '132',
  materials: [{ quantity: '0', unitPrice: '' }],
};
describe('explicit spending scenarios', () => {
  it('includes donors and other spending, and uses profit/cost rather than sale/cost', () => {
    expect(calculateCostScenario(input)).toEqual({
      cost: '110',
      profit: '22',
      roi: '20',
    });
  });
  it('keeps decimal arithmetic exact and preserves losses', () => {
    expect(
      calculateCostScenario({
        ...input,
        bases: '0.1',
        other: '0.2',
        sale: '0.1',
        materials: [{ quantity: '3', unitPrice: '0.1' }],
      }),
    ).toEqual({ cost: '0.6', profit: '-0.5', roi: '-83.333333' });
  });
  it.each(['', '-1', 'NaN', 'Infinity', '1e3', '0x10', '1000000000001'])(
    'does not treat invalid or missing consumption %j as zero',
    (quantity) => {
      expect(
        calculateCostScenario({
          ...input,
          materials: [{ quantity, unitPrice: '5' }],
        }),
      ).toBeNull();
    },
  );
  it('requires a price only for consumed materials and never invents a sale', () => {
    expect(
      calculateCostScenario({
        ...input,
        materials: [{ quantity: '1', unitPrice: '' }],
      }),
    ).toBeNull();
    expect(calculateCostScenario({ ...input, sale: '' })).toEqual({
      cost: '110',
      profit: null,
      roi: null,
    });
    expect(calculateCostScenario({ ...input, bases: '' })).toBeNull();
    expect(calculateCostScenario({ ...input, other: '' })).toBeNull();
    expect(calculateCostScenario({ ...input, bases: '0', other: '0' })).toEqual(
      { cost: '0', profit: '132', roi: null },
    );
  });
});
