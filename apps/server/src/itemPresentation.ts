import { readFile } from 'node:fs/promises';

import type {
  ItemPresentationContractV1,
  PresentedModifier,
  PresentedProperty,
} from '@poe-worksmith/contracts';
import {
  DomainError,
  type CanonicalRecipeV2,
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
  recipe: CanonicalRecipeV2;
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
        value: null,
      },
    );
  }
  const modifiers = recipe.target.allOf.map((condition): PresentedModifier => {
    const canonicalId = condition.modId ?? condition.modFamilyId!;
    const metadata = required(catalog, canonicalId);
    return {
      canonicalId,
      generationType: metadata.generationType ?? generationType(condition.kind),
      label: metadata.name,
    };
  });
  const materials = (recipe.craft.resourceConsumption?.materials ?? []).map(
    ({ itemId, quantity }) => {
      const metadata = required(catalog, itemId);
      return {
        canonicalId: itemId,
        iconUrl: metadata.iconUrl ?? null,
        itemClass: metadata.itemClass ?? invalid(),
        name: metadata.name,
        quantity,
        role: 'material' as const,
        totalPrice: null,
        unitPrice: null,
      };
    },
  );
  return {
    base: {
      canonicalId: recipe.base.baseId,
      iconUrl: base.iconUrl ?? null,
      itemClass: base.itemClass ?? invalid(),
      itemLevel: recipe.base.itemLevel,
      modifiers: [],
      name: base.name,
      properties,
      rarity: recipe.base.rarity,
      role: 'base',
    },
    materials,
    target: {
      canonicalId: recipe.base.baseId,
      iconUrl: base.iconUrl ?? null,
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
  return catalog.get(canonicalId) ?? invalid();
}

function invalid(): never {
  throw new DomainError('RECIPE_INVALID');
}

function generationType(kind: string): PresentedModifier['generationType'] {
  return kind === 'implicit' || kind === 'enchant' ? kind : 'other';
}
