import { describe, expect, it } from 'vitest';

import {
  hashCanonicalCraftSetup,
  normalizeCanonicalCraftSetup,
} from './canonical/normalization.js';
import {
  canonicalCraftSetupFromRecipe,
  validateRecipeV2,
} from './recipeSchemaV2.js';

const validRecipe = {
  base: {
    baseId: 'Metadata/Items/Jewels/JewelPassiveTreeExpansionLarge',
    influences: [],
    itemLevel: 84,
    rarity: 'rare',
    state: { corrupted: false, fractured: false, synthesised: false },
    variant: {
      kind: 'cluster-jewel',
      passiveCount: 8,
      smallPassiveStatId: 'physical-damage',
    },
  },
  category: 'cluster-jewel',
  content: { craftSteps: [{ id: 'reforge', title: 'Reforge Physical' }] },
  craft: {
    method: { kind: 'harvest-reforge', tag: 'physical' },
    startingMods: [],
  },
  gameDataVersion: '3.26.0',
  id: 'physical-large-cluster',
  schemaVersion: 2,
  summary: 'A physical large cluster jewel.',
  tags: ['cluster-jewel', 'physical'],
  target: {
    allOf: [
      { kind: 'explicit', minimumTier: 1, modFamilyId: 'physical-notable' },
    ],
    anyOf: [],
    minimumMatched: null,
  },
  title: 'Physical Large Cluster Jewel',
} as const;

describe('recipe schema v2', () => {
  it('validates a physical large cluster recipe without provider payloads', () => {
    const recipe = validateRecipeV2(validRecipe);
    expect(recipe.base.variant).toEqual({
      kind: 'cluster-jewel',
      passiveCount: 8,
      smallPassiveStatId: 'physical-damage',
    });
    expect(recipe.craft.method).toEqual({
      kind: 'harvest-reforge',
      tag: 'physical',
    });
  });

  it('rejects invalid item variants, item levels, targets, and craft methods with paths', () => {
    expect(() =>
      validateRecipeV2({
        ...validRecipe,
        base: {
          ...validRecipe.base,
          itemLevel: 101,
          variant: { kind: 'unsupported' },
        },
      }),
    ).toThrow(/base\.itemLevel/);
    expect(() =>
      validateRecipeV2({
        ...validRecipe,
        target: {
          ...validRecipe.target,
          anyOf: [{ kind: 'explicit', modId: 'a' }],
          minimumMatched: 2,
        },
      }),
    ).toThrow(/target\.minimumMatched/);
    expect(() =>
      validateRecipeV2({
        ...validRecipe,
        craft: {
          ...validRecipe.craft,
          method: { kind: 'essence', essence: 'fear' },
        },
      }),
    ).toThrow(/craft\.method\.kind/);
  });

  it('rejects contradictory target conditions at stable paths', () => {
    expect(() =>
      validateRecipeV2({
        ...validRecipe,
        target: {
          allOf: [
            { kind: 'explicit', modId: 'physical', excluded: false },
            { kind: 'explicit', modId: 'physical', excluded: true },
          ],
          anyOf: [],
          minimumMatched: null,
        },
      }),
    ).toThrow(/target\.allOf\[1\]/);
  });

  it('normalizes unordered craft intent before hashing', () => {
    const first = {
      ...canonicalCraftSetupFromRecipe(validateRecipeV2(validRecipe)),
      base: { ...validRecipe.base, influences: ['elder', 'shaper'] },
      method: {
        fossils: ['jagged', 'pristine'],
        kind: 'fossil',
        resonatorSockets: 2,
      } as const,
      startingMods: [
        { modId: 'suffix-b', tier: 2 },
        { modId: 'prefix-a', tier: 1 },
      ],
      target: {
        allOf: [
          { kind: 'explicit', modId: 'b' },
          { kind: 'explicit', modFamilyId: 'a' },
        ],
        anyOf: [],
        minimumMatched: null,
      },
    };
    const second = {
      ...first,
      base: { ...first.base, influences: ['shaper', 'elder'] },
      method: { ...first.method, fossils: ['pristine', 'jagged'] },
      startingMods: [...first.startingMods].reverse(),
      target: { ...first.target, allOf: [...first.target.allOf].reverse() },
    };

    expect(normalizeCanonicalCraftSetup(first)).toEqual(
      normalizeCanonicalCraftSetup(second),
    );
    expect(hashCanonicalCraftSetup(first)).toBe(
      hashCanonicalCraftSetup(second),
    );
  });

  it('hashes canonical intent only', () => {
    const recipe = validateRecipeV2(validRecipe);
    const setup = canonicalCraftSetupFromRecipe(recipe);
    expect(hashCanonicalCraftSetup(setup)).toBe(
      hashCanonicalCraftSetup(
        canonicalCraftSetupFromRecipe(
          validateRecipeV2({
            ...validRecipe,
            title: 'Different display title',
          }),
        ),
      ),
    );
    expect(hashCanonicalCraftSetup(setup)).not.toBe(
      hashCanonicalCraftSetup({
        ...setup,
        method: { kind: 'harvest-reforge', tag: 'fire' },
      }),
    );
  });
});
