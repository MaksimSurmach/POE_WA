import { describe, expect, it } from 'vitest';
import {
  canonicalRecipeFixture,
  fixtureRecipe,
} from '@poe-worksmith/domain/fixtures';
import {
  RegisteredTradeQueryGenerator,
  noVariantFilter,
  mappedTargetFilter,
  type TradeQueryGenerator,
} from '@poe-worksmith/domain';
import {
  createRecipeMarketDependencies,
  matchingRecipeListings,
  comparableRecipeListings,
  compileScrapedItemQuery,
  recipeQueryTarget,
} from './recipeMarket.js';
import {
  derivedRecipeSpecs,
  type RecipeSpecResolver,
} from './scrapedItemConfig.js';
import {
  scrapedItemSpecFromRecipe,
  scrapedItemTargetSignature,
} from '@poe-worksmith/domain';

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
            target.modId === 'unmapped'
              ? `${target.kind}.stat_999999999999`
              : target.modId === 'different'
                ? 'explicit.stat_2923486259'
                : `${target.kind}.stat_3299347043`,
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
  specs: derivedRecipeSpecs,
});
const query = async (
  recipe: typeof canonicalRecipeFixture,
  league = 'Fixture League',
) =>
  (await dependencies({ recipe, league })).find((d) => d.kind === 'target')
    ?.query;
describe('recipe market dependencies', () => {
  it('reports an unsupported collector stat per search instead of throwing from the shared compiler', async () => {
    const spec = scrapedItemSpecFromRecipe(canonicalRecipeFixture, 'output');
    for (const kind of ['explicit', 'fractured'] as const) {
      const result = await compileScrapedItemQuery(
        trade,
        'output',
        {
          ...spec,
          conditions: [{ kind, modId: 'unmapped', excluded: false }],
        },
        'Fixture League',
      );
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'COLLECTOR_QUERY_UNSUPPORTED',
            entityId: 'explicit.stat_999999999999',
          },
        ],
      });
    }
  });

  it('reports a registered but non-executable native range without hiding unexpected generator failures', async () => {
    const invalidNative: TradeQueryGenerator = {
      async generate(input) {
        const generated = await trade.generate(input);
        if (!generated.ok) return generated;
        return {
          ...generated,
          value: {
            ...generated.value,
            query: {
              query: {
                type: 'Large Cluster Jewel',
                stats: [
                  {
                    type: 'and',
                    filters: [{ id: 'misc.quality', value: { min: 101 } }],
                  },
                ],
              },
            },
          },
        };
      },
    };
    const spec = scrapedItemSpecFromRecipe(canonicalRecipeFixture, 'output');
    await expect(
      compileScrapedItemQuery(invalidNative, 'output', spec, 'Fixture League'),
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'COLLECTOR_QUERY_UNSUPPORTED' }],
    });
    await expect(
      compileScrapedItemQuery(
        {
          generate: async () => {
            throw new Error('unexpected-generator-failure');
          },
        },
        'output',
        spec,
        'Fixture League',
      ),
    ).rejects.toThrow('unexpected-generator-failure');
  });
  it('preserves value-based finished searches while letting the owner choose a strict search', async () => {
    const spec = scrapedItemSpecFromRecipe(canonicalRecipeFixture, 'output');
    spec.item = {
      ...spec.item,
      influences: ['hunter'],
      state: { corrupted: false, fractured: true, synthesised: true },
    };
    spec.conditions = [
      {
        kind: 'fractured',
        modId: 'life',
        excluded: false,
        minimumValue: 80,
        maximumValue: 90,
        exactTier: 2,
      },
    ];
    const equivalent = await compileScrapedItemQuery(
      trade,
      'output',
      spec,
      'Fixture League',
    );
    expect(equivalent.ok).toBe(true);
    if (!equivalent.ok) return;
    const target = recipeQueryTarget(equivalent.query.query.handbookTarget);
    expect(target.minItemLevel).toBeUndefined();
    expect(target.influences).toBeUndefined();
    expect(target.synthesised).toBeUndefined();
    expect(target.tradeSearch?.fractured).toBeUndefined();
    expect(target.tradeSearch?.groups).toEqual([
      {
        type: 'and',
        filters: [{ id: 'explicit.stat_3299347043', min: 80 }],
      },
    ]);
    expect(equivalent.query.query).toMatchObject({
      query: {
        stats: [
          {
            type: 'and',
            filters: [{ id: 'explicit.stat_3299347043', value: { min: 80 } }],
          },
        ],
      },
    });
    const strict = await compileScrapedItemQuery(
      trade,
      'output',
      { ...spec, marketEquivalent: false },
      'Fixture League',
    );
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    expect(recipeQueryTarget(strict.query.query.handbookTarget)).toMatchObject({
      minItemLevel: spec.item.itemLevel,
      influences: ['hunter'],
      synthesised: true,
      tradeSearch: {
        fractured: true,
        groups: [
          {
            filters: [
              {
                id: 'fractured.stat_3299347043',
                min: 80,
                max: 90,
                exactTier: 2,
              },
            ],
          },
        ],
      },
    });
    expect(recipeQueryTarget(strict.query.query.handbookTarget).name).toBe(
      target.name,
    );
    const base = await compileScrapedItemQuery(
      trade,
      'base',
      spec,
      'Fixture League',
    );
    expect(base.ok).toBe(true);
    if (base.ok)
      expect(recipeQueryTarget(base.query.query.handbookTarget)).toMatchObject({
        minItemLevel: spec.item.itemLevel,
        maxItemLevel: spec.item.itemLevel,
        influences: ['hunter'],
        synthesised: true,
        tradeSearch: {
          fractured: true,
          groups: [
            {
              filters: [
                {
                  id: 'fractured.stat_3299347043',
                  min: 80,
                  max: 90,
                  exactTier: 2,
                },
              ],
            },
          ],
        },
      });
  });

  it('retains negative upper bounds and implicit ranges in equivalent output searches', async () => {
    const original = scrapedItemSpecFromRecipe(
      canonicalRecipeFixture,
      'output',
    );
    for (const [kind, minimumValue, maximumValue] of [
      ['explicit', -10, -5],
      ['implicit', 80, 90],
    ] as const) {
      const result = await compileScrapedItemQuery(
        trade,
        'output',
        {
          ...original,
          conditions: [
            {
              kind,
              modId: 'life',
              excluded: false,
              minimumValue,
              maximumValue,
            },
          ],
        },
        'Fixture League',
      );
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(
          recipeQueryTarget(result.query.query.handbookTarget).tradeSearch
            ?.groups,
        ).toEqual([
          {
            type: 'and',
            filters: [
              {
                id: `${kind}.stat_3299347043`,
                min: minimumValue,
                max: maximumValue,
              },
            ],
          },
        ]);
    }
  });

  it('carries an explicitly base-independent output category to its handbook and wire query', async () => {
    const recipe = fixtureRecipe({
      ...canonicalRecipeFixture,
      category: 'ring',
      tags: ['base-independent'],
    });
    const spec = scrapedItemSpecFromRecipe(recipe, 'output');
    const result = await compileScrapedItemQuery(
      trade,
      'output',
      spec,
      'Fixture League',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      recipeQueryTarget(result.query.query.handbookTarget).tradeSearch,
    ).toMatchObject({ category: 'accessory.ring' });
    expect(result.query.query).toMatchObject({
      query: {
        filters: {
          type_filters: { filters: { category: { option: 'accessory.ring' } } },
        },
      },
    });
    expect(
      (result.query.query.query as Record<string, unknown>).type,
    ).toBeUndefined();
  });

  it('preserves comparable listing depth before seller deduplication without changing catalog pricing', async () => {
    const targetQuery = (await query(canonicalRecipeFixture))!;
    const capturedAt = new Date('2026-11-04T12:00:00.000Z');
    const listings = ['same', 'same', 'independent'].map((account, index) => ({
      id: `listing-${index}`,
      account,
      ageSeconds: 0,
      fee: null,
      indexedAt: capturedAt,
      price: { amount: String(200 + index), currency: 'chaos' },
      item: {
        baseType: 'Large Cluster Jewel',
        rarity: 'rare',
        league: 'Fixture League',
        patch: canonicalRecipeFixture.patch,
        itemLevel: 84,
        corrupted: false,
        synthesised: false,
        fractured: false,
        influences: [],
        seller: account,
        status: 'listed',
        currency: 'chaos',
        modsComplete: true,
        mods: [],
      },
    }));
    expect(
      matchingRecipeListings(
        targetQuery.query,
        listings,
        capturedAt,
        capturedAt,
      ),
    ).toHaveLength(3);
    expect(
      comparableRecipeListings(
        targetQuery.query,
        listings,
        capturedAt,
        capturedAt,
      ),
    ).toHaveLength(2);
  });

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
            filters: [
              { id: 'fractured.stat_3299347043', value: { min: 14, max: 14 } },
            ],
          },
        ],
      },
    });
    expect(recipeQueryTarget(base?.query?.query.handbookTarget)).toMatchObject({
      tradeSearch: {
        fractured: true,
        groups: [
          { filters: [{ id: 'fractured.stat_3299347043', min: 14, max: 14 }] },
        ],
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

  describe('configured scraped-item requirements', () => {
    const recipe = fixtureRecipe({
      ...canonicalRecipeFixture,
      target: {
        ...canonicalRecipeFixture.target,
        prefixes: [{ kind: 'explicit', modId: 'authored-prefix' }],
      },
    });
    const configured = (
      override: (spec: ReturnType<typeof scrapedItemSpecFromRecipe>) => void,
    ): RecipeSpecResolver => {
      return async (input) => {
        const base = derivedRecipeSpecs(input) as Awaited<
          ReturnType<RecipeSpecResolver>
        >;
        const output = structuredClone(base.output.spec);
        override(output);
        return {
          base: base.base,
          output: { spec: output, configured: { id: 'item-1', revision: 2 } },
        };
      };
    };
    const compile = async (specs: RecipeSpecResolver) =>
      (
        await createRecipeMarketDependencies({
          trade,
          resolveResource: async (id) => id,
          specs,
        })({ recipe, league: 'Fixture League' })
      ).filter((d) => d.kind !== 'material');

    it('compiles an unedited configured spec byte-identically to the authored recipe', async () => {
      expect(await compile(configured(() => undefined))).toEqual(
        await compile(derivedRecipeSpecs),
      );
      expect(
        scrapedItemTargetSignature(scrapedItemSpecFromRecipe(recipe, 'output')),
      ).toBe(recipe.targetSignature);
    });

    it('uses edited requirements for the finished search and leaves the starting base alone', async () => {
      const authored = await compile(derivedRecipeSpecs);
      const edited = await compile(
        configured((spec) => {
          spec.conditions = [
            { kind: 'explicit', modId: 'different', excluded: false },
          ];
          spec.item.itemLevel = 86;
          spec.marketEquivalent = false;
        }),
      );
      expect(edited.find((d) => d.kind === 'base')).toEqual(
        authored.find((d) => d.kind === 'base'),
      );
      const before = authored.find((d) => d.kind === 'target')!.query;
      const after = edited.find((d) => d.kind === 'target')!.query;
      expect(after).not.toEqual(before);
      expect(after.query).toMatchObject({
        query: {
          filters: { misc_filters: { filters: { ilvl: { min: 86 } } } },
          stats: [{ filters: [{ id: 'explicit.stat_2923486259' }] }],
        },
      });
      expect(recipeQueryTarget(after.query.handbookTarget).name).not.toBe(
        recipe.targetSignature,
      );
    });
  });
});
