import { expect, it } from 'vitest';
import { recipeCraftFamilies } from './craftFamilies.js';
import { canonicalRecipeFixture } from './fixtures/recipes.js';
import { recipeTargetSignature } from './recipeSchema.js';

it('classifies canonical operations, including declared mixed stages, never payment currency', () => {
  const craft = canonicalRecipeFixture.craft;
  expect(
    recipeCraftFamilies({
      ...craft,
      method: {
        kind: 'fossil',
        fossils: ['jagged-fossil'],
        resonatorSockets: 1,
      },
    }),
  ).toEqual(['fossil']);
  expect(
    recipeCraftFamilies(
      {
        ...craft,
        method: { kind: 'currency', currency: 'deafening-essence-of-fear' },
      },
      ['bench'],
    ),
  ).toEqual(['essence', 'bench']);
  expect(
    recipeCraftFamilies({
      ...craft,
      method: { kind: 'currency', currency: 'orb-of-alteration' },
    }),
  ).toEqual(['alteration']);
  expect(
    recipeCraftFamilies({
      ...craft,
      method: { kind: 'currency', currency: 'chaos-orb' },
    }),
  ).toEqual(['chaos']);
  expect(
    recipeCraftFamilies({
      ...craft,
      method: { kind: 'currency', currency: 'essence-of-insanity' },
    }),
  ).toEqual(['essence']);
  expect(recipeTargetSignature(canonicalRecipeFixture)).toBe(
    canonicalRecipeFixture.targetSignature,
  );
});
