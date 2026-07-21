import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DomainError, validateRecipeDocument } from '@poe-worksmith/domain';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

import {
  createRecipeItemPresentation,
  loadItemPresentationCatalog,
  type ItemPresentationCatalog,
} from './itemPresentation.js';

const recipePath = fileURLToPath(
  new URL('../../../recipes/physical-large-cluster/recipe.md', import.meta.url),
);
const catalogPath = fileURLToPath(
  new URL(
    '../presentation/poe1/3.26.0/physical-large-cluster.json',
    import.meta.url,
  ),
);

async function recipe() {
  return validateRecipeDocument(
    matter(await readFile(recipePath, 'utf8')).data,
  );
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
      30, 30,
    ]);
    expect(presentation.target.modifiers.map(({ label }) => label)).toEqual([
      'Battle-Hardened',
      'Furious Assault',
      'Master the Fundamentals',
    ]);
    expect(presentation.base.iconUrl).toBeNull();
    expect(JSON.stringify(presentation)).toBe(
      JSON.stringify(createRecipeItemPresentation({ catalog, recipe: input })),
    );
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
