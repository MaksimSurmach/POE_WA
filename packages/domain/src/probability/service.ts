import {
  hashCanonicalCraftSetup,
  normalizeCanonicalCraftSetup,
} from '../canonical/normalization.js';
import type { CanonicalCraftSetup } from '../canonical/setup.js';
import {
  deriveCraftProbabilityCacheKey,
  calculatorContractVersion,
} from './cacheKey.js';
import { ExactRational } from './rational.js';
import type {
  CraftProbabilityRepository,
  CraftProbabilityResult,
  ProbabilityDiagnostic,
  ProbabilityRulesetCatalog,
} from './types.js';
import type { ProbabilityEngineRegistry } from './registry.js';

const decimalScale = 12;

function diagnostic(
  code: ProbabilityDiagnostic['code'],
  message: string,
): ProbabilityDiagnostic {
  return { code, severity: 'error', message, path: [] };
}

function isValidProbability(probability: ExactRational) {
  return (
    probability.compare(ExactRational.zero()) > 0 &&
    probability.compare(ExactRational.one()) <= 0
  );
}

export class CraftProbabilityService {
  constructor(
    private readonly dependencies: {
      engines: ProbabilityEngineRegistry;
      repository: CraftProbabilityRepository;
      rulesets: ProbabilityRulesetCatalog;
    },
  ) {}

  async calculate(input: {
    setup: CanonicalCraftSetup;
    gameDataVersion: string;
    now?: Date;
  }): Promise<CraftProbabilityResult> {
    const setup = normalizeCanonicalCraftSetup(input.setup);
    const setupHash = hashCanonicalCraftSetup(setup);
    const engine = this.dependencies.engines.get(setup.method.kind);
    if (!engine) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PROBABILITY_METHOD_UNSUPPORTED',
            `No probability engine for ${setup.method.kind}`,
          ),
        ],
      };
    }
    const ruleset = await this.dependencies.rulesets.resolve({
      gameDataVersion: input.gameDataVersion,
      methodKind: setup.method.kind,
    });
    if (!ruleset) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PROBABILITY_RULESET_MISSING',
            `No ruleset for ${setup.method.kind}`,
          ),
        ],
      };
    }
    const cacheKey = await deriveCraftProbabilityCacheKey({
      setupHash,
      gameDataVersion: input.gameDataVersion,
      rulesetId: ruleset.id,
      engineId: engine.id,
      engineVersion: engine.version,
    });
    const cached = await this.dependencies.repository.findByCacheKey(cacheKey);
    if (cached) {
      try {
        const probability = ExactRational.of(
          BigInt(cached.probability.numerator),
          BigInt(cached.probability.denominator),
        );
        const expectedAttempts = ExactRational.of(
          BigInt(cached.expectedAttempts.numerator),
          BigInt(cached.expectedAttempts.denominator),
        );
        if (
          isValidProbability(probability) &&
          expectedAttempts.compare(probability.invert()) === 0
        ) {
          return { ok: true, value: cached, diagnostics: cached.diagnostics };
        }
      } catch {
        // Invalid persisted rationals must fail closed.
      }
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PROBABILITY_RESULT_INVALID',
            'Cached probability is outside (0, 1]',
          ),
        ],
      };
    }
    let calculated;
    try {
      calculated = await engine.calculate({ setup, ruleset });
    } catch {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PROBABILITY_ENGINE_FAILED',
            `Probability engine ${engine.id} failed`,
          ),
        ],
      };
    }
    if (!calculated.ok) return calculated;
    if (!isValidProbability(calculated.probability)) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'PROBABILITY_RESULT_INVALID',
            'Engine probability must be within (0, 1]',
          ),
        ],
      };
    }
    const expectedAttempts = calculated.probability.invert();
    const calculatedAt = input.now ?? new Date();
    const stored = await this.dependencies.repository.save({
      cacheKey,
      setupHash,
      gameDataVersion: input.gameDataVersion,
      rulesetId: ruleset.id,
      engineId: engine.id,
      engineVersion: engine.version,
      calculatorContractVersion,
      calculatorVersion: String(calculatorContractVersion),
      probability: calculated.probability.toJSON(),
      probabilityDecimal: calculated.probability.toDecimal(decimalScale),
      expectedAttempts: expectedAttempts.toJSON(),
      expectedAttemptsDecimal: expectedAttempts.toDecimal(decimalScale),
      diagnostics: calculated.diagnostics ?? [],
      calculatedAt,
      createdAt: calculatedAt,
    });
    return { ok: true, value: stored, diagnostics: stored.diagnostics };
  }
}
