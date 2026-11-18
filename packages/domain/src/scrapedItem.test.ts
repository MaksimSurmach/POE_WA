import { describe, expect, it } from 'vitest';

import { canonicalRecipeFixture, fixtureRecipe } from './fixtures/index.js';
import {
  scrapedItemDigest,
  scrapedItemEditIssues,
  scrapedItemIdentityChanged,
  scrapedItemSpecFromRecipe,
  scrapedItemSpecSchema,
  scrapedItemTargetSignature,
} from './scrapedItem.js';

const recipe = fixtureRecipe({
  ...canonicalRecipeFixture,
  craft: {
    ...canonicalRecipeFixture.craft,
    startingMods: [
      { modId: 'suppression', kind: 'fractured', tier: 2, minimumValue: 14 },
    ],
  },
  target: {
    ...canonicalRecipeFixture.target,
    prefixes: [{ kind: 'explicit', modId: 'physical', minimumValue: 20 }],
  },
});

describe('scraped item requirements', () => {
  it('derives the authored base and output requirements from a recipe', () => {
    const base = scrapedItemSpecFromRecipe(recipe, 'base');
    expect(base.item).toEqual(recipe.startingBase);
    expect(base.conditions).toEqual([
      {
        kind: 'fractured',
        modId: 'suppression',
        excluded: false,
        exactTier: 2,
        minimumValue: 14,
      },
    ]);
    const output = scrapedItemSpecFromRecipe(recipe, 'output');
    expect(output.item).toEqual(recipe.base);
    expect(output.conditions).toEqual(Object.values(recipe.target).flat());
    expect(scrapedItemSpecSchema.safeParse(base).success).toBe(true);
    expect(scrapedItemSpecSchema.safeParse(output).success).toBe(true);
  });

  it('identifies an unedited output exactly as the recipe does', () => {
    expect(
      scrapedItemTargetSignature(scrapedItemSpecFromRecipe(recipe, 'output')),
    ).toBe(recipe.targetSignature);
  });

  it('changes the signature when requirements change but not when they are reordered', () => {
    const output = scrapedItemSpecFromRecipe(recipe, 'output');
    const reordered = {
      ...output,
      conditions: [
        { kind: 'explicit' as const, modId: 'a', excluded: false },
        { kind: 'explicit' as const, modId: 'b', excluded: false },
      ],
    };
    expect(scrapedItemDigest('output', reordered)).toBe(
      scrapedItemDigest('output', {
        ...reordered,
        conditions: [...reordered.conditions].reverse(),
      }),
    );
    expect(scrapedItemDigest('output', reordered)).not.toBe(
      scrapedItemDigest('output', output),
    );
    expect(scrapedItemDigest('base', output)).not.toBe(
      scrapedItemDigest('output', output),
    );
  });

  describe('validation', () => {
    const output = scrapedItemSpecFromRecipe(recipe, 'output');
    const withConditions = (conditions: unknown[]) =>
      scrapedItemSpecSchema.safeParse({ ...output, conditions });

    it.each([
      [
        'an excluded modifier, which would silently disable its filter',
        [{ kind: 'explicit', modId: 'x', excluded: true }],
      ],
      [
        'an inverted value range',
        [{ kind: 'explicit', modId: 'x', minimumValue: 9, maximumValue: 3 }],
      ],
      [
        'a value outside the allowed bound',
        [{ kind: 'explicit', modId: 'x', minimumValue: 1e9 }],
      ],
      [
        'a non-finite value',
        [{ kind: 'explicit', modId: 'x', minimumValue: Infinity }],
      ],
      [
        'an exact tier combined with a tier range',
        [{ kind: 'explicit', modId: 'x', exactTier: 1, minimumTier: 1 }],
      ],
      [
        'a tier outside the supported range',
        [{ kind: 'explicit', modId: 'x', exactTier: 21 }],
      ],
      ['a modifier without a canonical identity', [{ kind: 'explicit' }]],
      [
        'two identities at once',
        [{ kind: 'explicit', modId: 'x', modFamilyId: 'y' }],
      ],
      [
        'a duplicate modifier',
        [
          { kind: 'explicit', modId: 'x' },
          { kind: 'explicit', modId: 'x' },
        ],
      ],
    ])('rejects %s', (_name, conditions) => {
      expect(withConditions(conditions).success).toBe(false);
    });

    it('limits how many modifiers one search can require', () => {
      expect(
        withConditions(
          Array.from({ length: 13 }, (_, index) => ({
            kind: 'explicit',
            modId: `mod-${index}`,
          })),
        ).success,
      ).toBe(false);
    });

    it('keeps canonical IDs byte-for-byte', () => {
      const parsed = withConditions([
        { kind: 'explicit', modId: 'Hale ‘of’ Giants' },
      ]);
      expect(parsed.success && parsed.data.conditions[0]?.modId).toBe(
        'Hale ‘of’ Giants',
      );
    });
  });

  describe('edit rules', () => {
    const output = scrapedItemSpecFromRecipe(recipe, 'output');
    it('rejects requirements the Trade site or role cannot express', () => {
      expect(
        scrapedItemEditIssues('base', {
          ...output,
          conditions: [{ kind: 'pseudo', modId: 'x', excluded: false }],
        }).map(({ path }) => path),
      ).toEqual(['conditions.0.kind']);
      expect(
        scrapedItemEditIssues('output', {
          ...output,
          item: { ...output.item, influences: ['bogus'] },
        }).map(({ path }) => path),
      ).toEqual(['item.influences.0']);
      expect(scrapedItemEditIssues('output', output)).toEqual([]);
    });

    it('treats the base, game data version and variant as the item identity', () => {
      expect(scrapedItemIdentityChanged(output, structuredClone(output))).toBe(
        false,
      );
      expect(
        scrapedItemIdentityChanged(output, {
          ...output,
          item: { ...output.item, itemLevel: 86 },
        }),
      ).toBe(false);
      expect(
        scrapedItemIdentityChanged(output, {
          ...output,
          item: { ...output.item, baseId: 'Other' },
        }),
      ).toBe(true);
      expect(
        scrapedItemIdentityChanged(output, { ...output, gameDataVersion: 'x' }),
      ).toBe(true);
    });
  });
});
