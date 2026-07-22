import type { CanonicalCraftSetup } from '../canonical/setup.js';
import type { ExactRational, ExactRationalJson } from './rational.js';

export type ProbabilityDiagnostic = {
  code:
    | 'PROBABILITY_METHOD_UNSUPPORTED'
    | 'PROBABILITY_RULESET_MISSING'
    | 'PROBABILITY_ENGINE_FAILED'
    | 'PROBABILITY_RESULT_INVALID';
  severity: 'error' | 'warning';
  message: string;
  path: readonly (string | number)[];
};

export type CraftProbabilityValue = {
  probability: ExactRationalJson;
  probabilityDecimal: string;
  expectedAttempts: ExactRationalJson;
  expectedAttemptsDecimal: string;
  calculatorVersion: string;
  engineId: string;
  engineVersion: string;
  rulesetId: string;
  setupHash: string;
  calculatedAt: Date;
};

export type CraftProbabilityResult =
  | {
      ok: true;
      value: CraftProbabilityValue;
      diagnostics: readonly ProbabilityDiagnostic[];
    }
  | { ok: false; diagnostics: readonly ProbabilityDiagnostic[] };

export interface ProbabilityRulesetCatalog {
  resolve(input: {
    gameDataVersion: string;
    methodKind: CanonicalCraftSetup['method']['kind'];
  }): Promise<{ id: string; payload: unknown } | null>;
}

export interface CraftMethodProbabilityEngine {
  readonly id: string;
  readonly version: string;
  readonly methodKind: CanonicalCraftSetup['method']['kind'];
  calculate(input: {
    setup: CanonicalCraftSetup;
    ruleset: { id: string; payload: unknown };
  }): Promise<
    | {
        ok: true;
        probability: ExactRational;
        diagnostics?: readonly ProbabilityDiagnostic[];
      }
    | { ok: false; diagnostics: readonly ProbabilityDiagnostic[] }
  >;
}

export type StoredCraftProbability = CraftProbabilityValue & {
  cacheKey: string;
  gameDataVersion: string;
  calculatorContractVersion: number;
  createdAt: Date;
  diagnostics: readonly ProbabilityDiagnostic[];
};

export interface CraftProbabilityRepository {
  findByCacheKey(cacheKey: string): Promise<StoredCraftProbability | null>;
  save(result: StoredCraftProbability): Promise<StoredCraftProbability>;
}
