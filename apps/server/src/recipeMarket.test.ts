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
import {
  createRecipeMarketDependencies,
  recipeQueryTarget,
} from './recipeMarket.js';

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
              : `${target.kind}.stat_1`,
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
  it('prices the exact model input level while allowing higher-level finished comparables', async () => {
    const result = await dependencies({
      recipe: canonicalRecipeFixture,
      league: 'Fixture League',
    });
    const base = result.find((d) => d.kind === 'base');
    const finished = result.find((d) => d.kind === 'target');
    const level = canonicalRecipeFixture.startingBase.itemLevel;
    expect(base?.query?.query).toMatchObject({
      query: {
        filters: {
          misc_filters: { filters: { ilvl: { min: level, max: level } } },
        },
      },
    });
    expect(recipeQueryTarget(base?.query?.query.handbookTarget)).toMatchObject({
      minItemLevel: level,
      maxItemLevel: level,
    });
    expect(
      recipeQueryTarget(finished?.query?.query.handbookTarget).maxItemLevel,
    ).toBeUndefined();
  });

  it('requires the priced starting affix itself to be fractured at its authored value', async () => {
    const recipe = fixtureRecipe({
      ...canonicalRecipeFixture,
      startingBase: {
        ...canonicalRecipeFixture.startingBase,
        rarity: 'rare',
        state: { corrupted: false, fractured: true, synthesised: false },
      },
      craft: {
        ...canonicalRecipeFixture.craft,
        startingMods: [
          {
            modId: 'suppression',
            kind: 'fractured',
            minimumValue: 14,
            maximumValue: 14,
          },
        ],
      },
    });
    const base = (
      await dependencies({ recipe, league: 'Fixture League' })
    ).find((d) => d.kind === 'base');
    expect(base?.query?.query).toMatchObject({
      query: {
        stats: [
          {
            filters: [{ id: 'fractured.stat_1', value: { min: 14, max: 14 } }],
          },
        ],
      },
    });
    expect(recipeQueryTarget(base?.query?.query.handbookTarget)).toMatchObject({
      tradeSearch: {
        fractured: true,
        groups: [{ filters: [{ id: 'fractured.stat_1', min: 14, max: 14 }] }],
      },
    });
    expect(() =>
      fixtureRecipe({
        ...recipe,
        craft: {
          ...recipe.craft,
          startingMods: [
            {
              modId: 'suppression',
              kind: 'fractured',
              minimumValue: 15,
              maximumValue: 14,
            },
          ],
        },
      }),
    ).toThrow(/minimumValue/);
  });
  it('does not request a Chaos Orb to Chaos Orb exchange for bench fees', async () => {
    const recipe = fixtureRecipe({
      ...canonicalRecipeFixture,
      craft: {
        ...canonicalRecipeFixture.craft,
        steps: canonicalRecipeFixture.craft.steps.map((step) => ({
          ...step,
          materials: [{ itemId: 'chaos-orb', quantity: 4 }],
        })),
      },
    });
    const result = await dependencies({ recipe, league: 'Fixture League' });
    expect(result.find((d) => d.kind === 'material')).toEqual({
      kind: 'material',
      materialId: 'chaos-orb',
      query: null,
    });
  });
});
