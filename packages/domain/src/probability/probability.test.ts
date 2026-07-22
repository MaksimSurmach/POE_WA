import { describe, expect, it } from 'vitest';

import {
  normalizeCanonicalCraftSetup,
  type CanonicalCraftSetup,
} from '../index.js';
import { createInMemoryRepositories } from '../inMemoryRepositories.js';
import { deriveCraftProbabilityCacheKey } from './cacheKey.js';
import { ExactRational } from './rational.js';
import { ProbabilityEngineRegistry } from './registry.js';
import { CraftProbabilityService } from './service.js';
import type { CraftMethodProbabilityEngine } from './types.js';

const setup: CanonicalCraftSetup = {
  base: {
    baseId: 'base:test',
    influences: [],
    itemLevel: 84,
    rarity: 'rare',
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: { kind: 'none' },
  },
  gameDataVersion: '3.26.0',
  method: { kind: 'harvest-reforge', tag: 'physical' },
  startingMods: [],
  target: { allOf: [], anyOf: [], minimumMatched: null },
};

function engine(probability: ExactRational): CraftMethodProbabilityEngine {
  return {
    id: 'fake',
    version: '1',
    methodKind: 'harvest-reforge',
    calculate: async () => ({ ok: true, probability }),
  };
}

function service(probability = ExactRational.of(1n, 4n)) {
  let calls = 0;
  const fake = engine(probability);
  const calculate = fake.calculate;
  fake.calculate = async (input) => {
    calls += 1;
    return calculate(input);
  };
  return {
    calls: () => calls,
    service: new CraftProbabilityService({
      engines: new ProbabilityEngineRegistry([fake]),
      repository: createInMemoryRepositories().craftProbabilities,
      rulesets: { resolve: async () => ({ id: 'ruleset:1', payload: {} }) },
    }),
  };
}

describe('ExactRational', () => {
  it('normalizes, calculates exactly, and rounds decimal half-up', () => {
    const value = ExactRational.of(-2n, -4n);
    expect(value.toJSON()).toEqual({ numerator: '1', denominator: '2' });
    expect(value.add(value).toJSON()).toEqual({
      numerator: '1',
      denominator: '1',
    });
    expect(ExactRational.of(1n, 8n).toDecimal(2)).toBe('0.13');
    expect(() => ExactRational.of(1n, 0n)).toThrow(RangeError);
    expect(() => ExactRational.zero().invert()).toThrow(RangeError);
  });
});

describe('CraftProbabilityService', () => {
  it('derives expected attempts and caches successful results', async () => {
    const fixture = service();
    const input = {
      setup,
      gameDataVersion: '3.26.0',
      now: new Date('2026-07-22T00:00:00Z'),
    };
    const first = await fixture.service.calculate(input);
    const second = await fixture.service.calculate(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        probability: { numerator: '1', denominator: '4' },
        expectedAttempts: { numerator: '4', denominator: '1' },
      },
    });
    expect(second).toMatchObject({ ok: true });
    expect(fixture.calls()).toBe(1);
  });

  it.each([ExactRational.zero(), ExactRational.of(-1n), ExactRational.of(2n)])(
    'rejects invalid engine probabilities',
    async (probability) => {
      const result = await service(probability).service.calculate({
        setup,
        gameDataVersion: '3.26.0',
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'PROBABILITY_RESULT_INVALID' }],
      });
    },
  );

  it('preserves engine failures and derives one attempt for certainty', async () => {
    const certain = await service(ExactRational.one()).service.calculate({
      setup,
      gameDataVersion: '3.26.0',
    });
    expect(certain).toMatchObject({
      ok: true,
      value: { expectedAttempts: { numerator: '1', denominator: '1' } },
    });
    const failed = engine(ExactRational.one());
    failed.calculate = async () => ({
      ok: false,
      diagnostics: [
        {
          code: 'PROBABILITY_ENGINE_FAILED',
          severity: 'error',
          message: 'fixture failure',
          path: [],
        },
      ],
    });
    const result = await new CraftProbabilityService({
      engines: new ProbabilityEngineRegistry([failed]),
      repository: createInMemoryRepositories().craftProbabilities,
      rulesets: { resolve: async () => ({ id: 'ruleset:1', payload: {} }) },
    }).calculate({ setup, gameDataVersion: '3.26.0' });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'PROBABILITY_ENGINE_FAILED' }],
    });
  });

  it('fails closed for unsupported methods, missing rulesets, and duplicate engines', async () => {
    const repositories = createInMemoryRepositories();
    const unsupported = new CraftProbabilityService({
      engines: new ProbabilityEngineRegistry([]),
      repository: repositories.craftProbabilities,
      rulesets: { resolve: async () => null },
    });
    expect(
      await unsupported.calculate({ setup, gameDataVersion: '3.26.0' }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'PROBABILITY_METHOD_UNSUPPORTED' }],
    });
    const missingRuleset = new CraftProbabilityService({
      engines: new ProbabilityEngineRegistry([engine(ExactRational.one())]),
      repository: repositories.craftProbabilities,
      rulesets: { resolve: async () => null },
    });
    expect(
      await missingRuleset.calculate({ setup, gameDataVersion: '3.26.0' }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'PROBABILITY_RULESET_MISSING' }],
    });
    expect(
      () =>
        new ProbabilityEngineRegistry([
          engine(ExactRational.one()),
          engine(ExactRational.one()),
        ]),
    ).toThrow(RangeError);
  });
});

describe('craft probability cache key', () => {
  it('changes only with contract inputs', async () => {
    const setupHash = await deriveCraftProbabilityCacheKey({
      setupHash: 'setup',
      gameDataVersion: '3.26.0',
      rulesetId: 'rules',
      engineId: 'engine',
      engineVersion: '1',
    });
    const changed = await Promise.all([
      deriveCraftProbabilityCacheKey({
        setupHash: 'setup-2',
        gameDataVersion: '3.26.0',
        rulesetId: 'rules',
        engineId: 'engine',
        engineVersion: '1',
      }),
      deriveCraftProbabilityCacheKey({
        setupHash: 'setup',
        gameDataVersion: '3.27.0',
        rulesetId: 'rules',
        engineId: 'engine',
        engineVersion: '1',
      }),
      deriveCraftProbabilityCacheKey({
        setupHash: 'setup',
        gameDataVersion: '3.26.0',
        rulesetId: 'rules-2',
        engineId: 'engine',
        engineVersion: '1',
      }),
      deriveCraftProbabilityCacheKey({
        setupHash: 'setup',
        gameDataVersion: '3.26.0',
        rulesetId: 'rules',
        engineId: 'engine',
        engineVersion: '2',
      }),
    ]);
    expect(changed).not.toContain(setupHash);
    expect(normalizeCanonicalCraftSetup(setup)).toEqual(setup);
  });
});
