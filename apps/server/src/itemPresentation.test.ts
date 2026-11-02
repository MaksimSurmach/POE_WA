import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { validateRecipeDocument } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import {
  createRecipeItemPresentation,
  loadItemPresentationCatalog,
} from './itemPresentation.js';

const recipePath = fileURLToPath(
  new URL(
    '../../../recipes/cluster-jewel/physical-large-cluster-jagged.json',
    import.meta.url,
  ),
);
const alterationRecipePath = fileURLToPath(
  new URL(
    '../../../recipes/cluster-jewel/physical-large-cluster-alteration.json',
    import.meta.url,
  ),
);
const catalogPath = fileURLToPath(
  new URL(
    '../presentation/poe1/3.29.3.3/physical-large-cluster.json',
    import.meta.url,
  ),
);

async function recipe() {
  return validateRecipeDocument(JSON.parse(await readFile(recipePath, 'utf8')));
}

describe('recipe item presentation', () => {
  it('maps canonical data in deterministic source order', async () => {
    const input = await recipe();
    if (input.schemaVersion !== 3) throw new Error('expected V2 recipe');
    const catalog = await loadItemPresentationCatalog(catalogPath);
    const presentation = createRecipeItemPresentation({
      catalog,
      recipe: input,
    });

    expect(presentation.base).toMatchObject({
      itemLevel: 83,
      name: 'Large Cluster Jewel',
      rarity: 'normal',
    });
    expect(presentation.materials.map(({ quantity }) => quantity)).toEqual([
      1, 1,
    ]);
    expect(presentation.target.modifiers.map(({ label }) => label)).toEqual([
      'Battle-Hardened',
      'Master the Fundamentals',
      'Furious Assault',
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
    if (input.schemaVersion !== 3) throw new Error('expected V2 recipe');
    const catalog = await loadItemPresentationCatalog(catalogPath);
    const presentation = createRecipeItemPresentation({
      catalog,
      recipe: input,
    });

    expect(input.craft.steps[1]?.success?.probability).toBeCloseTo(0.00072, 8);
    expect(input.craft.expectedExecutions?.[1]?.count).toBe(1389);
    expect(
      presentation.materials.map(({ canonicalId, quantity }) => [
        canonicalId,
        quantity,
      ]),
    ).toEqual([
      ['orb-of-transmutation', 1],
      ['orb-of-alteration', 1],
    ]);
  });

  it('falls back to canonical identities when artwork metadata is unknown', async () => {
    const presentation = createRecipeItemPresentation({
      catalog: { get: () => null, version: () => '1' },
      recipe: await recipe(),
    });
    expect(presentation.target.iconUrl).toBeNull();
    expect(presentation.target.name).toContain('Metadata/');
  });
});
