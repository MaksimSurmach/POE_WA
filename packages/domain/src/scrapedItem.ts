import { z } from 'zod';

import { canonicalItemSpecSchema } from './canonical/item.js';
import { hashCanonicalCraftSetup } from './canonical/normalization.js';
import { canonicalTargetConditionSchema } from './canonical/target.js';
import type { CanonicalRecipe } from './recipeSchema.js';

/** A base item is the starting item; an output item is the finished craft. */
export const scrapedItemRoleSchema = z.enum(['base', 'output']);
export type ScrapedItemRole = z.output<typeof scrapedItemRoleSchema>;

export const scrapedItemMarketCategories = [
  'accessory.ring',
  'armour.gloves',
  'armour.boots',
  'armour.helmet',
] as const;

/** Influences the Trade site can filter on. */
export const scrapedItemInfluences = [
  'shaper',
  'elder',
  'crusader',
  'redeemer',
  'hunter',
  'warlord',
] as const;

export const maximumScrapedItemConditions = 12;
const valueBound = 100_000;
const boundedValue = z.number().finite().min(-valueBound).max(valueBound);

/**
 * One typed modifier requirement. Excluded conditions are rejected: the Trade
 * compiler would only disable the filter, which silently weakens matching.
 */
export const scrapedItemConditionSchema = canonicalTargetConditionSchema
  .refine((condition) => !condition.excluded, {
    message: 'Excluded modifier requirements are not supported',
    path: ['excluded'],
  })
  .refine(
    (condition) =>
      [condition.minimumValue, condition.maximumValue].every(
        (value) => value === undefined || boundedValue.safeParse(value).success,
      ),
    {
      message: `Values must be between -${valueBound} and ${valueBound}`,
      path: ['minimumValue'],
    },
  );
export type ScrapedItemCondition = z.output<typeof scrapedItemConditionSchema>;

const scrapedItemItemSchema = canonicalItemSpecSchema.omit({
  implicits: true,
  enchantments: true,
});

export const scrapedItemSpecSchema = z
  .strictObject({
    conditions: z
      .array(scrapedItemConditionSchema)
      .max(maximumScrapedItemConditions),
    gameDataVersion: z.string().trim().min(1),
    item: scrapedItemItemSchema,
    marketEquivalent: z.boolean().optional(),
    marketSearchCategory: z.enum(scrapedItemMarketCategories).optional(),
    patch: z.string().trim().min(1),
  })
  .superRefine((spec, context) => {
    if (spec.marketSearchCategory && !spec.marketEquivalent)
      context.addIssue({
        code: 'custom',
        message: 'A category search requires finished-market equivalence',
        path: ['marketSearchCategory'],
      });
    const seen = new Set<string>();
    spec.conditions.forEach((condition, index) => {
      const identity = `${condition.kind}:${condition.modId ?? condition.modFamilyId}`;
      if (seen.has(identity))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate modifier requirement',
          path: ['conditions', index],
        });
      seen.add(identity);
    });
  });
export type ScrapedItemSpec = z.output<typeof scrapedItemSpecSchema>;

/** The fields that make an item the same item; only requirements are editable. */
export function scrapedItemIdentityChanged(
  current: ScrapedItemSpec,
  next: ScrapedItemSpec,
) {
  return (
    current.gameDataVersion !== next.gameDataVersion ||
    current.patch !== next.patch ||
    current.item.baseId !== next.item.baseId ||
    JSON.stringify(current.item.variant) !== JSON.stringify(next.item.variant)
  );
}

/**
 * Rules for owner edits. Authored recipe specs are read as written; an edit
 * must use only values the compiler and the Trade site both understand.
 */
export function scrapedItemEditIssues(
  role: ScrapedItemRole,
  spec: ScrapedItemSpec,
) {
  const issues: { path: string; message: string }[] = [];
  if (role === 'base') {
    if (spec.marketEquivalent !== undefined)
      issues.push({
        path: 'marketEquivalent',
        message: 'A starting base must retain its exact crafting requirements',
      });
    if (spec.marketSearchCategory !== undefined)
      issues.push({
        path: 'marketSearchCategory',
        message: 'A starting base cannot use a category-wide search',
      });
  }
  spec.item.influences.forEach((influence, index) => {
    if (!(scrapedItemInfluences as readonly string[]).includes(influence))
      issues.push({
        path: `item.influences.${index}`,
        message: `Unsupported influence "${influence}"`,
      });
  });
  spec.conditions.forEach((condition, index) => {
    const allowed =
      role === 'base'
        ? ['explicit', 'fractured', 'implicit']
        : ['explicit', 'fractured', 'implicit', 'enchant', 'pseudo'];
    if (!allowed.includes(condition.kind))
      issues.push({
        path: `conditions.${index}.kind`,
        message: `A ${role} item cannot require a ${condition.kind} modifier`,
      });
  });
  return issues;
}

/** The authored requirement for a recipe: its starting base or its output. */
export function scrapedItemSpecFromRecipe(
  recipe: CanonicalRecipe,
  role: ScrapedItemRole,
): ScrapedItemSpec {
  const item = role === 'base' ? recipe.startingBase : recipe.base;
  const category =
    recipe.category === 'ring' ? 'accessory.ring' : `armour.${recipe.category}`;
  return {
    conditions:
      role === 'base'
        ? recipe.craft.startingMods.map(
            ({ modId, tier, kind, minimumValue, maximumValue }) => ({
              kind: kind ?? 'explicit',
              modId,
              excluded: false,
              ...(tier ? { exactTier: tier } : {}),
              ...(minimumValue === undefined ? {} : { minimumValue }),
              ...(maximumValue === undefined ? {} : { maximumValue }),
            }),
          )
        : Object.values(recipe.target).flat(),
    gameDataVersion: recipe.gameDataVersion,
    item: item as ScrapedItemSpec['item'],
    ...(role === 'output'
      ? {
          marketEquivalent: true,
          ...(recipe.tags.includes('base-independent')
            ? {
                marketSearchCategory: z
                  .enum(scrapedItemMarketCategories)
                  .parse(category),
              }
            : {}),
        }
      : {}),
    patch: recipe.patch,
  };
}

function scrapedItemSetup(spec: ScrapedItemSpec) {
  return {
    base: spec.item,
    gameDataVersion: spec.gameDataVersion,
    method: { kind: 'currency' as const, currency: 'signature' },
    startingMods: [],
    target: { allOf: spec.conditions, anyOf: [], minimumMatched: null },
  };
}

/**
 * Identifies the finished-item requirements. For an unedited recipe output this
 * equals the recipe's own target signature.
 */
export function scrapedItemTargetSignature(spec: ScrapedItemSpec) {
  return `${spec.patch}:${hashCanonicalCraftSetup(scrapedItemSetup(spec))}`;
}

/** Order-insensitive digest; compares requirements without a provider query. */
export function scrapedItemDigest(
  role: ScrapedItemRole,
  spec: ScrapedItemSpec,
) {
  const identity = `${role}:${scrapedItemTargetSignature(spec)}`;
  return spec.marketEquivalent === undefined &&
    spec.marketSearchCategory === undefined
    ? identity
    : `${identity}:${JSON.stringify({ marketEquivalent: spec.marketEquivalent ?? false, marketSearchCategory: spec.marketSearchCategory ?? null })}`;
}
