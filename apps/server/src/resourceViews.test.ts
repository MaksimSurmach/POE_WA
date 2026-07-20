import { fileURLToPath } from 'node:url';

import {
  catalogResponseSchema,
  recipeResponseSchema,
} from '@poe-worksmith/contracts';
import { createInMemoryRepositories } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import { synchronizeRecipeCatalog } from './recipes/synchronizeRecipes.js';
import { createResourceReaders } from './resourceViews.js';

const correlationId = '44444444-4444-4444-8444-444444444444';
const recipesPath = fileURLToPath(new URL('../../../recipes', import.meta.url));

describe('repository-backed resource views', () => {
  it('serves only active recipes synchronized from the Git catalog', async () => {
    const repositories = createInMemoryRepositories();
    const report = await synchronizeRecipeCatalog(
      recipesPath,
      repositories.recipes,
    );
    const readers = createResourceReaders(repositories);

    expect(report).toMatchObject({ created: ['physical-large-cluster'] });
    const catalog = catalogResponseSchema.parse(
      await readers.readCatalog(correlationId),
    );
    expect(catalog.state).toBe('loading');
    expect(catalog.data?.entries).toHaveLength(1);
    expect(catalog.data?.entries[0]).toMatchObject({
      evaluation: { status: 'loading' },
      recipe: {
        id: 'physical-large-cluster',
        minimumCapital: null,
        title: 'Physical Large Cluster Jewel',
      },
    });

    const detail = recipeResponseSchema.parse(
      await readers.readRecipe(correlationId, 'physical-large-cluster'),
    );
    expect(detail.data).toMatchObject({
      materials: [
        {
          costPerAttempt: null,
          name: 'Primal Crystallised Lifeforce',
          unitPrice: null,
        },
      ],
      recipe: { id: 'physical-large-cluster' },
    });
  });
});
