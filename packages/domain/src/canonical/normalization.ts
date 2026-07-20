import {
  canonicalCraftSetupSchema,
  type CanonicalCraftSetup,
} from './setup.js';

function sortedUnique(values: readonly string[] | undefined) {
  return [...new Set(values ?? [])].sort();
}

function conditionKey(
  condition: CanonicalCraftSetup['target']['allOf'][number],
) {
  return JSON.stringify([
    condition.kind,
    condition.modId ?? '',
    condition.modFamilyId ?? '',
    condition.excluded,
    condition.exactTier ?? null,
    condition.minimumTier ?? null,
    condition.maximumTier ?? null,
    condition.minimumValue ?? null,
    condition.maximumValue ?? null,
  ]);
}

export function normalizeCanonicalCraftSetup(
  input: unknown,
): CanonicalCraftSetup {
  const setup = canonicalCraftSetupSchema.parse(input);
  const normalizeConditions = (
    conditions: CanonicalCraftSetup['target']['allOf'],
  ) =>
    [...conditions].sort((left, right) =>
      conditionKey(left).localeCompare(conditionKey(right)),
    );
  const method =
    setup.method.kind === 'fossil'
      ? { ...setup.method, fossils: sortedUnique(setup.method.fossils) }
      : setup.method;

  return {
    ...setup,
    base: {
      ...setup.base,
      ...(setup.base.enchantments === undefined
        ? {}
        : { enchantments: sortedUnique(setup.base.enchantments) }),
      ...(setup.base.implicits === undefined
        ? {}
        : { implicits: sortedUnique(setup.base.implicits) }),
      influences: sortedUnique(setup.base.influences),
    },
    method,
    startingMods: [...setup.startingMods].sort((left, right) =>
      `${left.modId}:${left.tier ?? ''}`.localeCompare(
        `${right.modId}:${right.tier ?? ''}`,
      ),
    ),
    target: {
      ...setup.target,
      allOf: normalizeConditions(setup.target.allOf),
      anyOf: normalizeConditions(setup.target.anyOf),
    },
  };
}

export function hashCanonicalCraftSetup(input: unknown) {
  const { base, method, startingMods, target } =
    normalizeCanonicalCraftSetup(input);
  const value = JSON.stringify({ base, method, startingMods, target });
  return `${fnv1a(value, 0xcbf29ce484222325n)}${fnv1a(value, 0x84222325cbf29ce4n)}`;
}

function fnv1a(value: string, seed: bigint) {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
