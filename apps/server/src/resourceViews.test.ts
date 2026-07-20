import { fileURLToPath } from 'node:url';

import {
  catalogResponseSchema,
  recipeResponseSchema,
} from '@poe-worksmith/contracts';
import {
  createInMemoryRepositories,
  transitionRefreshCycle,
} from '@poe-worksmith/domain';
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

  it('does not present a published catalog after its league rolls over', async () => {
    const repositories = createInMemoryRepositories();
    await synchronizeRecipeCatalog(recipesPath, repositories.recipes);
    const oldLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Old',
      isCurrent: true,
      metadata: {},
      name: 'Old',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date(),
    });
    const queued = await repositories.cycles.save({
      completedQueries: 0,
      completedRecipes: 0,
      errorMessage: null,
      failedQueries: 0,
      failedRecipes: 0,
      finishedAt: null,
      id: '11111111-1111-4111-8111-111111111111',
      leagueId: oldLeague.id,
      publishedAt: null,
      requestedAt: new Date(),
      startedAt: null,
      status: 'queued',
      totalQueries: 0,
      totalRecipes: 1,
    });
    const running = await repositories.cycles.save({
      ...transitionRefreshCycle(queued, 'running', new Date()),
      completedRecipes: 1,
    });
    await repositories.cycles.publish(running.id, new Date());
    const nextLeague = await repositories.leagues.upsert({
      endAt: null,
      game: 'poe1',
      gggId: 'Next',
      isCurrent: false,
      metadata: {},
      name: 'Next',
      realm: 'pc',
      startAt: null,
      syncedAt: new Date(),
    });
    await repositories.leagues.setCurrent(nextLeague.id, new Date());

    expect(
      await createResourceReaders(repositories).readCatalog(correlationId),
    ).toMatchObject({
      publishedAt: null,
      state: 'loading',
    });
  });
});
