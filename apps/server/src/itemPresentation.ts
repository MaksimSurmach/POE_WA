import { readFile } from 'node:fs/promises';

import type {
  ItemPresentationContractV1,
  PresentedModifier,
  PresentedProperty,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type CanonicalRecipe,
  type RecipeEvaluation,
} from '@poe-worksmith/domain';
import { z } from 'zod';

const metadataSchema = z.strictObject({
  generationType: z
    .enum(['prefix', 'suffix', 'implicit', 'enchant', 'other'])
    .optional(),
  iconUrl: z.string().url().nullable().optional(),
  itemClass: z.string().min(1).optional(),
  name: z.string().min(1),
});

const manifestSchema = z.strictObject({
  gameDataVersion: z.string().min(1),
  metadata: z.record(z.string().min(1), metadataSchema),
  metadataVersion: z.literal('1'),
});

export type PresentationMetadata = z.infer<typeof metadataSchema>;

export interface ItemPresentationCatalog {
  get(canonicalId: string): PresentationMetadata | null;
  version(): string;
}

export async function loadItemPresentationCatalog(
  file: string,
): Promise<ItemPresentationCatalog> {
  const parsed = manifestSchema.safeParse(
    JSON.parse(await readFile(file, 'utf8')),
  );
  if (!parsed.success)
    throw new DomainError('RECIPE_INVALID', { cause: parsed.error });
  const metadata = new Map(Object.entries(parsed.data.metadata));
  return {
    get: (canonicalId) => metadata.get(canonicalId) ?? null,
    version: () => parsed.data.metadataVersion,
  };
}

export function createRecipeItemPresentation(input: {
  catalog: ItemPresentationCatalog;
  evaluation?: RecipeEvaluation;
  recipe: CanonicalRecipe;
}): ItemPresentationContractV1 {
  const { catalog, recipe } = input;
  const base = required(catalog, recipe.base.baseId);
  const properties: PresentedProperty[] = [
    {
      id: 'item-level',
      label: 'Item Level',
      value: String(recipe.base.itemLevel),
    },
  ];
  properties.push(
    {
      id: 'influences',
      label: 'Influence',
      value:
        recipe.base.influences.length > 0
          ? recipe.base.influences.map(titleCase).join(', ')
          : 'None',
    },
    {
      id: 'corrupted',
      label: 'Corrupted',
      value: recipe.base.state.corrupted ? 'Yes' : 'No',
    },
    {
      id: 'fractured',
      label: 'Fractured',
      value: recipe.base.state.fractured ? 'Yes' : 'No',
    },
  );
  if (recipe.base.variant.kind === 'cluster-jewel') {
    properties.push(
      {
        id: 'passive-count',
        label: 'Passive Skills',
        value: String(recipe.base.variant.passiveCount),
      },
      {
        id: recipe.base.variant.smallPassiveStatId,
        label: required(catalog, recipe.base.variant.smallPassiveStatId).name,
        value: 'Required',
      },
    );
  }
  const modifiers = Object.values(recipe.target)
    .flat()
    .map((condition): PresentedModifier => {
      const canonicalId = condition.modId ?? condition.modFamilyId!;
      const metadata = required(catalog, canonicalId);
      return {
        canonicalId,
        generationType:
          metadata.generationType ?? generationType(condition.kind),
        label: [
          condition.excluded ? `Not ${metadata.name}` : metadata.name,
          condition.exactTier !== undefined
            ? `Tier ${condition.exactTier}`
            : condition.minimumTier !== undefined ||
                condition.maximumTier !== undefined
              ? `Tier ${condition.minimumTier ?? 1}–${condition.maximumTier ?? 'any'}`
              : null,
          condition.minimumValue !== undefined
            ? `≥ ${condition.minimumValue}`
            : null,
          condition.maximumValue !== undefined
            ? `≤ ${condition.maximumValue}`
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join(' · '),
      };
    });
  const materials = [
    ...new Set(
      recipe.craft.steps.flatMap((step) =>
        step.materials.map(({ itemId }) => itemId),
      ),
    ),
  ].map((itemId) => {
    const metadata = catalog.get(itemId);
    return {
      canonicalId: itemId,
      iconUrl: metadata?.iconUrl ?? null,
      itemClass: metadata?.itemClass ?? 'Currency',
      name: metadata?.name ?? itemId,
      quantity: 1,
      role: 'material' as const,
      totalPrice: null,
      unitPrice: null,
    };
  });
  return {
    base: {
      canonicalId: recipe.base.baseId,
      iconUrl: recipe.imageUrl ?? base.iconUrl ?? null,
      itemClass: base.itemClass ?? invalid(),
      itemLevel: recipe.base.itemLevel,
      modifiers: [],
      name: base.name,
      properties,
      rarity: recipe.startingBase.rarity,
      role: 'base',
    },
    materials,
    target: {
      canonicalId: recipe.base.baseId,
      iconUrl: recipe.imageUrl ?? base.iconUrl ?? null,
      itemClass: base.itemClass ?? invalid(),
      itemLevel: recipe.base.itemLevel,
      modifiers,
      name: base.name,
      properties,
      rarity: recipe.base.rarity,
      role: 'target',
    },
    version: 1,
  };
}

function required(
  catalog: ItemPresentationCatalog,
  canonicalId: string,
): PresentationMetadata {
  return (
    catalog.get(canonicalId) ?? { name: canonicalId, itemClass: 'Unknown' }
  );
}

function invalid(): never {
  throw new DomainError('RECIPE_INVALID');
}

function generationType(kind: string): PresentedModifier['generationType'] {
  return kind === 'implicit' || kind === 'enchant' ? kind : 'other';
}

function titleCase(value: string) {
  return value
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const observedMod = z.union([
  z.string(),
  z.object({
    description: z.string(),
    flags: z
      .object({
        crafted: z.boolean().optional(),
        fractured: z.boolean().optional(),
      })
      .optional(),
    mods: z.array(z.object({ tier: z.string().optional() })).optional(),
  }),
]);
const observedItem = z.object({
  baseType: z.string().optional(),
  typeLine: z.string().optional(),
  name: z.string().optional(),
  icon: z.string().optional(),
  ilvl: z.number().int().positive().optional(),
  rarity: z.enum(['normal', 'magic', 'rare', 'unique']).optional(),
  quality: z.number().optional(),
  corrupted: z.boolean().optional(),
  fractured: z.boolean().optional(),
  synthesised: z.boolean().optional(),
  influences: z.array(z.string()).optional(),
  explicitMods: z.array(observedMod).optional(),
  implicitMods: z.array(observedMod).optional(),
  enchantMods: z.array(observedMod).optional(),
  craftedMods: z.array(observedMod).optional(),
  fracturedMods: z.array(observedMod).optional(),
});

export function createObservedItemPresentation(
  value: unknown,
): import('@poe-worksmith/contracts').PresentedItem | null {
  const result = observedItem.safeParse(value);
  if (!result.success) return null;
  const item = result.data;
  const name = item.baseType ?? item.typeLine;
  if (!name) return null;
  const icon = item.icon ? URL.parse(item.icon) : null;
  const modifiers: PresentedModifier[] = [];
  for (const [origin, lines] of [
    ['implicit', item.implicitMods],
    ['enchant', item.enchantMods],
    ['explicit', item.explicitMods],
    ['crafted', item.craftedMods],
    ['fractured', item.fracturedMods],
  ] as const) {
    for (const [index, mod] of (lines ?? []).entries()) {
      const tier =
        typeof mod === 'string' ? null : (mod.mods?.[0]?.tier ?? null);
      const kind =
        origin === 'implicit' || origin === 'enchant'
          ? origin
          : tier?.startsWith('P')
            ? 'prefix'
            : tier?.startsWith('S')
              ? 'suffix'
              : 'other';
      modifiers.push({
        canonicalId: `${origin}-${index}`,
        generationType: kind,
        label: [
          typeof mod === 'string' ? mod : mod.description,
          origin === 'crafted' ||
          (typeof mod !== 'string' && mod.flags?.crafted)
            ? '(crafted)'
            : null,
          origin === 'fractured' ||
          (typeof mod !== 'string' && mod.flags?.fractured)
            ? '(fractured)'
            : null,
          tier ? `Tier ${tier}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
    }
  }
  return {
    canonicalId: name,
    name: item.name ? `${item.name} · ${name}` : name,
    itemClass: 'Listed item',
    itemLevel: item.ilvl ?? null,
    rarity: item.rarity ?? null,
    role: 'listing',
    iconUrl:
      icon?.protocol === 'https:' && icon.hostname === 'web.poecdn.com'
        ? icon.href
        : null,
    modifiers,
    properties: [
      {
        id: 'influence',
        label: 'Influences',
        value: item.influences?.join(', ') || 'None',
      },
      ...(['corrupted', 'fractured', 'synthesised'] as const).map((key) => ({
        id: key,
        label: key,
        value: item[key] === undefined ? 'Unknown' : item[key] ? 'Yes' : 'No',
      })),
      {
        id: 'quality',
        label: 'Quality',
        value: item.quality === undefined ? 'Unknown' : `${item.quality}%`,
      },
    ],
  };
}
