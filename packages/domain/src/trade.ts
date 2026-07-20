import type { CanonicalItemSpec } from './canonical/item.js';
import type {
  CanonicalTargetCondition,
  CanonicalTargetSpec,
} from './canonical/target.js';
import type {
  ResolutionDiagnostic,
  ResolutionResult,
} from './canonical/setup.js';
import type { CanonicalCraftSetup } from './canonical/setup.js';

export type ResolvedTradeBase = {
  discriminator?: string;
  filters?: TradeFilterFragment;
  id: string;
  mappingVersion: string;
};
export type ResolvedTradeTarget = {
  id: string;
  maximum?: number;
  minimum?: number;
};
export interface TradeMappingCatalog {
  resolveBase(input: {
    baseId: string;
    gameDataVersion: string;
    variant: CanonicalItemSpec['variant'];
  }): Promise<ResolutionResult<ResolvedTradeBase>>;
  resolveTarget(input: {
    gameDataVersion: string;
    target: CanonicalTargetCondition;
  }): Promise<ResolutionResult<ResolvedTradeTarget>>;
}
export type TradeFilterFragment = Record<string, unknown>;
export interface TradeItemVariantTranslator {
  supports(kind: string): boolean;
  translate(
    input: CanonicalItemSpec['variant'],
  ): ResolutionResult<TradeFilterFragment>;
}
export interface TradeTargetTranslator {
  supports(condition: CanonicalTargetCondition): boolean;
  translate(input: {
    condition: CanonicalTargetCondition;
    mapping: ResolvedTradeTarget;
  }): ResolutionResult<TradeFilterFragment>;
}
export type GeneratedTradeQuery = {
  diagnostics: { gameDataVersion: string; mappingVersion: string };
  hash: string;
  query: Record<string, unknown>;
};
export interface TradeQueryGenerator {
  generate(input: {
    league: string;
    setup: CanonicalCraftSetup;
  }): Promise<ResolutionResult<GeneratedTradeQuery>>;
}

const error = (
  code: string,
  message: string,
  entityId?: string,
): ResolutionDiagnostic => ({
  code,
  message,
  path: [],
  severity: 'error',
  ...(entityId ? { entityId } : {}),
});
const failed = <T>(
  diagnostics: readonly ResolutionDiagnostic[],
): ResolutionResult<T> => ({ diagnostics, ok: false });
const success = <T>(
  value: T,
  diagnostics: readonly ResolutionDiagnostic[] = [],
): ResolutionResult<T> => ({ diagnostics, ok: true, value });

export class RegisteredTradeQueryGenerator implements TradeQueryGenerator {
  constructor(
    private readonly mappings: TradeMappingCatalog,
    private readonly variants: readonly TradeItemVariantTranslator[],
    private readonly targets: readonly TradeTargetTranslator[],
  ) {}

  async generate({
    league,
    setup,
  }: {
    league: string;
    setup: CanonicalCraftSetup;
  }): Promise<ResolutionResult<GeneratedTradeQuery>> {
    if (!league.trim())
      return failed([error('TRADE_LEAGUE_REQUIRED', 'League is required')]);
    const base = await this.mappings.resolveBase({
      baseId: setup.base.baseId,
      gameDataVersion: setup.gameDataVersion,
      variant: setup.base.variant,
    });
    if (!base.ok) return base;
    const variant = this.variants.find((translator) =>
      translator.supports(setup.base.variant.kind),
    );
    if (!variant)
      return failed([
        error(
          'TRADE_VARIANT_UNSUPPORTED',
          `No translator for ${setup.base.variant.kind}`,
        ),
      ]);
    const variantFilter = variant.translate(setup.base.variant);
    if (!variantFilter.ok) return variantFilter;
    const diagnostics: ResolutionDiagnostic[] = [
      ...base.diagnostics,
      ...variantFilter.diagnostics,
    ];
    const filters = await this.translateTarget(
      setup.target,
      setup.gameDataVersion,
      diagnostics,
    );
    if (!filters.ok) return filters;
    const query = {
      query: {
        filters: {
          misc_filters: {
            filters: {
              ilvl: { min: setup.base.itemLevel },
              ...(base.value.filters ?? {}),
              ...variantFilter.value,
            },
          },
          type_filters: {
            filters: {
              type: { option: base.value.id },
              ...(base.value.discriminator
                ? { category: { option: base.value.discriminator } }
                : {}),
            },
          },
        },
        stats: filters.value,
        status: { option: 'securable' },
      },
      sort: { price: 'asc' },
    };
    const normalized = JSON.stringify(query);
    return success(
      {
        diagnostics: {
          gameDataVersion: setup.gameDataVersion,
          mappingVersion: base.value.mappingVersion,
        },
        hash: stableHash(normalized),
        query,
      },
      diagnostics,
    );
  }

  private async translateTarget(
    target: CanonicalTargetSpec,
    gameDataVersion: string,
    diagnostics: ResolutionDiagnostic[],
  ): Promise<ResolutionResult<unknown[]>> {
    const translate = async (condition: CanonicalTargetCondition) => {
      const mapping = await this.mappings.resolveTarget({
        gameDataVersion,
        target: condition,
      });
      if (!mapping.ok) return mapping;
      const translator = this.targets.find((candidate) =>
        candidate.supports(condition),
      );
      if (!translator)
        return failed<TradeFilterFragment>([
          error(
            'TRADE_TARGET_UNSUPPORTED',
            `No translator for ${condition.kind}`,
          ),
        ]);
      const result = translator.translate({
        condition,
        mapping: mapping.value,
      });
      diagnostics.push(...mapping.diagnostics, ...result.diagnostics);
      return result;
    };
    const all = await Promise.all(target.allOf.map(translate));
    const any = await Promise.all(target.anyOf.map(translate));
    const failures = [...all, ...any].filter((result) => !result.ok);
    if (failures.length)
      return failed<unknown[]>(
        failures.flatMap((result) => result.diagnostics),
      );
    const group = (
      type: 'and' | 'count' | 'or',
      values: ResolutionResult<TradeFilterFragment>[],
      value?: number,
    ) =>
      values.length
        ? [
            {
              type,
              filters: values.map(
                (entry) => (entry as { value: TradeFilterFragment }).value,
              ),
              ...(value ? { value: { min: value } } : {}),
            },
          ]
        : [];
    return success([
      ...group('and', all),
      ...group(
        target.minimumMatched ? 'count' : 'or',
        any,
        target.minimumMatched ?? undefined,
      ),
    ]);
  }
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const noVariantFilter: TradeItemVariantTranslator = {
  supports: (kind) => kind === 'none',
  translate: () => success({}),
};
export const clusterJewelVariantFilter: TradeItemVariantTranslator = {
  supports: (kind) => kind === 'cluster-jewel',
  translate: (input) =>
    input.kind === 'cluster-jewel'
      ? success({})
      : failed([
          error('TRADE_VARIANT_INVALID', 'Expected a cluster jewel variant'),
        ]),
};
export const mappedTargetFilter: TradeTargetTranslator = {
  supports: () => true,
  translate: ({ condition, mapping }) =>
    success({
      id: mapping.id,
      ...(condition.excluded ? { disabled: true } : {}),
      ...((mapping.minimum ?? condition.minimumValue)
        ? { value: { min: mapping.minimum ?? condition.minimumValue } }
        : {}),
      ...((mapping.maximum ?? condition.maximumValue)
        ? { value: { max: mapping.maximum ?? condition.maximumValue } }
        : {}),
    }),
};
