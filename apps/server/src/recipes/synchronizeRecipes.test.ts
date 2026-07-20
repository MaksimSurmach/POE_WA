import {
  createInMemoryRepositories,
  validateRecipeV1,
} from '@poe-worksmith/domain';
import { validRecipeV1Fixture } from '@poe-worksmith/domain/fixtures';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { type LoadedRecipe, loadRecipeFile } from './loader.js';
import {
  computeRecipeContentHash,
  synchronizeRecipeCatalog,
  synchronizeRecipes,
} from './synchronizeRecipes.js';

const recipeCatalog = path.resolve(import.meta.dirname, '../../../../recipes');

function loadedRecipe(overrides: Partial<LoadedRecipe> = {}): LoadedRecipe {
  return {
    assets: [],
    definition: validateRecipeV1(validRecipeV1Fixture),
    markdown: '# Guide\n',
    sourcePath: 'physical-large-cluster/recipe.md',
    ...overrides,
  };
}

describe('recipe synchronization', () => {
  it('validates the authoring template and synchronizes the starter catalog', async () => {
    const template = await loadRecipeFile(
      path.join(recipeCatalog, 'recipe.template.md'),
      recipeCatalog,
    );
    expect(template.definition.id).toBe('your-recipe-id');

    const repositories = createInMemoryRepositories();
    const first = await synchronizeRecipeCatalog(
      recipeCatalog,
      repositories.recipes,
    );
    const second = await synchronizeRecipeCatalog(
      recipeCatalog,
      repositories.recipes,
    );

    expect(first.created).toEqual(['physical-large-cluster-jagged']);
    expect(second.unchanged).toEqual(['physical-large-cluster-jagged']);
  });

  it('hashes normalized recipe data and referenced asset bytes', async () => {
    const source = loadedRecipe({ assets: ['images/example.png'] });
    if (source.definition.schemaVersion !== 1) {
      throw new Error('Expected the legacy fixture to load as schema v1');
    }
    const definition = source.definition;
    const first = await computeRecipeContentHash(source, async () =>
      Buffer.from('image-one'),
    );
    const same = await computeRecipeContentHash(
      {
        ...source,
        definition: {
          ...definition,
          craftSteps: definition.craftSteps.map((step) => ({
            ...step,
            metadata: { notes: step.metadata?.notes ?? [], method: 'harvest' },
          })),
        },
      },
      async () => Buffer.from('image-one'),
    );
    const changedMarkdown = await computeRecipeContentHash(
      { ...source, markdown: '# Changed\n' },
      async () => Buffer.from('image-one'),
    );
    const changedDefinition = await computeRecipeContentHash(
      {
        ...source,
        definition: { ...source.definition, title: 'Changed title' },
      },
      async () => Buffer.from('image-one'),
    );
    const changedAsset = await computeRecipeContentHash(source, async () =>
      Buffer.from('image-two'),
    );

    expect(same).toBe(first);
    expect(changedMarkdown).not.toBe(first);
    expect(changedDefinition).not.toBe(first);
    expect(changedAsset).not.toBe(first);
  });

  it('creates, skips unchanged writes, updates, disables, and reactivates', async () => {
    const repositories = createInMemoryRepositories();
    const save = vi.spyOn(repositories.recipes, 'save');
    const source = loadedRecipe();
    const readAsset = vi.fn(async () => Buffer.from('unused'));

    expect(
      await synchronizeRecipes(repositories.recipes, [source], readAsset),
    ).toMatchObject({ created: [source.definition.id] });
    const firstWriteCount = save.mock.calls.length;

    expect(
      await synchronizeRecipes(repositories.recipes, [source], readAsset),
    ).toMatchObject({ unchanged: [source.definition.id] });
    expect(save).toHaveBeenCalledTimes(firstWriteCount);

    const changed = loadedRecipe({ markdown: '# Changed\n' });
    expect(
      await synchronizeRecipes(repositories.recipes, [changed], readAsset),
    ).toMatchObject({ updated: [source.definition.id] });

    expect(
      await synchronizeRecipes(repositories.recipes, [], readAsset),
    ).toMatchObject({ disabled: [source.definition.id] });
    expect(
      await repositories.recipes.findById(source.definition.id),
    ).toMatchObject({
      active: false,
    });

    expect(
      await synchronizeRecipes(repositories.recipes, [changed], readAsset),
    ).toMatchObject({ updated: [source.definition.id] });
    expect(
      await repositories.recipes.findById(source.definition.id),
    ).toMatchObject({
      active: true,
    });
  });

  it('reports a source failure without disabling its existing row', async () => {
    const repositories = createInMemoryRepositories();
    const source = loadedRecipe({ assets: ['images/example.png'] });
    await synchronizeRecipes(repositories.recipes, [source], async () =>
      Buffer.from('valid'),
    );

    const report = await synchronizeRecipes(
      repositories.recipes,
      [source],
      async () => {
        throw new Error('asset read failed');
      },
    );

    expect(report.failed).toEqual([
      {
        id: source.definition.id,
        message: 'asset read failed',
        operation: 'hash',
      },
    ]);
    expect(
      await repositories.recipes.findById(source.definition.id),
    ).toMatchObject({
      active: true,
    });
  });

  it('reports dry-run changes without writing them', async () => {
    const repositories = createInMemoryRepositories();
    const source = loadedRecipe();
    const readAsset = async () => Buffer.from('unused');

    const report = await synchronizeRecipes(
      repositories.recipes,
      [source],
      readAsset,
      { dryRun: true },
    );

    expect(report.created).toEqual([source.definition.id]);
    expect(await repositories.recipes.listAll()).toEqual([]);
  });
});
