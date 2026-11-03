import { describe, expect, it } from 'vitest';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import {
  RegisteredTradeQueryGenerator,
  noVariantFilter,
  mappedTargetFilter,
} from '@poe-worksmith/domain';
import { createRecipeMarketDependencies } from './recipeMarket.js';

const trade = new RegisteredTradeQueryGenerator(
  {
    async resolveBase({ baseId }) {
      return {
        ok: true,
        diagnostics: [],
        value: { id: baseId, mappingVersion: 'fixture' },
      };
    },
    async resolveTarget({ target }) {
      return {
        ok: true,
        diagnostics: [],
        value: {
          id:
            target.modId === 'different'
              ? 'explicit.stat_2'
              : 'explicit.stat_1',
        },
      };
    },
  },
  [noVariantFilter],
  [mappedTargetFilter],
);
const dependencies = createRecipeMarketDependencies({
  trade,
  resolveResource: async (id) => id,
});
const query = async (
  recipe: typeof canonicalRecipeFixture,
  league = 'Fixture League',
) =>
  (await dependencies({ recipe, league })).find((d) => d.kind === 'target')
    ?.query;
describe('recipe market dependencies', () => {
  it('shares exact finished searches across methods and isolates different output modifiers', async () => {
    const first = canonicalRecipeFixture;
    const second = fixtureRecipe({
      ...first,
      id: 'second',
      craft: {
        ...first.craft,
        method: { kind: 'currency', currency: 'chaos-orb' },
      },
    });
    expect(await query(first)).toEqual(await query(second));
    const third = fixtureRecipe({
      ...first,
      target: {
        ...first.target,
        prefixes: [{ kind: 'explicit', modId: 'different' }],
      },
    });
    expect(await query(third)).not.toEqual(await query(first));
  });
  it('collects each sole-method material once and uses explicit starting conditions', async () => {
    const result = await dependencies({
      recipe: canonicalRecipeFixture,
      league: 'Fixture League',
    });
    expect(result.map((d) => d.kind)).toEqual(['base', 'material', 'target']);
    expect(result.find((d) => d.kind === 'base')?.query?.query).toMatchObject({
      query: {
        filters: {
          type_filters: { filters: { rarity: { option: 'normal' } } },
        },
      },
    });
    expect(result.find((d) => d.kind === 'material')?.query?.query).toEqual({
      exchange: { have: ['chaos'], want: ['primal-crystallised-lifeforce'] },
    });
  });
});
