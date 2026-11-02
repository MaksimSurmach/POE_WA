import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DomainError, validateRecipeDocument } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import {
  createRecipeItemPresentation,
  loadItemPresentationCatalog,
  type ItemPresentationCatalog,
} from './itemPresentation.js';

const recipePath = fileURLToPath(
  new URL(
    '../../../recipes/physical-large-cluster/recipe.json',
    import.meta.url,
  ),
);
const alterationRecipePath = fileURLToPath(
  new URL(
    '../../../recipes/physical-large-cluster-alteration/recipe.json',
    import.meta.url,
  ),
);
const catalogPath = fileURLToPath(
  new URL(
    '../presentation/poe1/3.26.0/physical-large-cluster.json',
    import.meta.url,
  ),
);

async function recipe() {
  return validateRecipeDocument(JSON.parse(await readFile(recipePath, 'utf8')));
}

describe('recipe item presentation', () => {
  it('maps canonical data in deterministic source order', async () => {
    const input = await recipe();
    if (input.schemaVersion !== 2) throw new Error('expected V2 recipe');
    const catalog = await loadItemPresentationCatalog(catalogPath);
    const presentation = createRecipeItemPresentation({
      catalog,
      recipe: input,
    });

    expect(presentation.base).toMatchObject({
      itemLevel: 83,
      name: 'Large Cluster Jewel',
      rarity: 'rare',
    });
    expect(presentation.materials.map(({ quantity }) => quantity)).toEqual([
      172, 172,
    ]);
    expect(presentation.target.modifiers.map(({ label }) => label)).toEqual([
      'Battle-Hardened',
      'Furious Assault',
      'Master the Fundamentals',
    ]);
    expect(presentation.base.iconUrl).toBe(
      'https://web.poecdn.com/image/Art/2DItems/Jewels/NewGemBase3.png',
    );
    expect(JSON.stringify(presentation)).toBe(
      JSON.stringify(createRecipeItemPresentation({ catalog, recipe: input })),
    );
  });

  it('loads the separate currency crafting target with its priced materials', async () => {
    const input = validateRecipeDocument(
      JSON.parse(await readFile(alterationRecipePath, 'utf8')),
    );
    if (input.schemaVersion !== 2) throw new Error('expected V2 recipe');
    const catalog = await loadItemPresentationCatalog(catalogPath);
    const presentation = createRecipeItemPresentation({
      catalog,
      recipe: input,
    });

    expect(input.craft.variants?.[0]?.steps[1]?.success?.probability).toBeCloseTo(
      1 / 2409,
    );
    expect(presentation.materials.map(({ canonicalId, quantity }) => [canonicalId, quantity])).toEqual([
      ['orb-of-transmutation', 1],
      ['orb-of-alteration', 2409],
    ]);
  });

  it('fails explicitly when required metadata is missing', async () => {
    const input = await recipe();
    if (input.schemaVersion !== 2) throw new Error('expected V2 recipe');
    const catalog: ItemPresentationCatalog = {
      get: () => null,
      version: () => '1',
    };

    expect(() =>
      createRecipeItemPresentation({ catalog, recipe: input }),
    ).toThrow(DomainError);
    expect(() =>
      createRecipeItemPresentation({ catalog, recipe: input }),
    ).toThrow(/recipe/i);
  });
});
