import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { hashMarketQuery, type CanonicalRecipeV1 } from '@poe-worksmith/domain';

import { loadRecipeFile, type LoadedRecipe } from '../recipes/loader.js';
import type { RecipeMarketDependencies } from '../recipeMarket.js';

export const integrationRecipeIds = [
  'fixture-v2-fossil-a-01',
  'fixture-v2-fossil-a-02',
  'fixture-v2-fossil-a-03',
  'fixture-v2-fossil-a-04',
  'fixture-v2-harvest-b-05',
  'fixture-v2-harvest-b-06',
  'fixture-v2-harvest-b-07',
  'fixture-v2-harvest-b-08',
  'fixture-v2-fossil-c-09',
  'fixture-v2-fossil-c-10',
  'fixture-v2-fossil-c-11',
  'fixture-v2-fossil-c-12',
  'fixture-v2-harvest-d-13',
  'fixture-v2-harvest-d-14',
  'fixture-v2-harvest-d-15',
  'physical-large-cluster-jagged',
  'physical-large-cluster-alteration',
  'fixture-v1-cheapest-17',
  'fixture-v1-third-18',
  'fixture-v1-median-19',
  'fixture-v1-mean-20',
] as const;
export const expectedDefaultQueryKeys = [
  'fixture:base:a',
  'fixture:base:c',
  'fixture:base:legacy',
  'fixture:base:production',
  'fixture:material:jagged',
  'fixture:material:resonator',
  'fixture:material:lifeforce',
  'fixture:material:legacy',
  'fixture:material:production:jagged',
  'fixture:material:production:resonator',
  'fixture:material:production:alteration',
  'fixture:material:production:transmutation',
  'fixture:output:a',
  'fixture:output:b',
  'fixture:output:c',
  'fixture:output:d',
  'fixture:output:legacy',
  'fixture:output:production:alteration',
  'fixture:output:production:jagged',
] as const;

const compiled = import.meta.url.includes('/dist/');
const syntheticDirectory = new URL(
  compiled ? './recipe-assets/synthetic/' : './recipes/',
  import.meta.url,
);
const productionRoot = new URL(
  compiled ? './recipe-assets/production/' : '../../../../recipes/',
  import.meta.url,
);
const productionRecipes = [
  'physical-large-cluster/recipe.json',
  'physical-large-cluster-alteration/recipe.json',
].map((file) => new URL(file, productionRoot));
const query = (
  fixtureKey: string,
): CanonicalRecipeV1['baseRequirements']['tradeQuery'] => ({
  provider: 'poe-trade',
  query: { fixtureKey },
  schemaVersion: 1,
});

export async function loadIntegrationCatalog(): Promise<
  readonly LoadedRecipe[]
> {
  const syntheticFiles = (await readdir(syntheticDirectory))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const root = fileURLToPath(syntheticDirectory);
  const synthetic = await Promise.all(
    syntheticFiles.map((file) =>
      loadRecipeFile(fileURLToPath(new URL(file, syntheticDirectory)), root),
    ),
  );
  const production = await Promise.all(
    productionRecipes.map((file) =>
      loadRecipeFile(fileURLToPath(file), fileURLToPath(productionRoot)),
    ),
  );
  return [...synthetic, ...production].sort((left, right) =>
    left.definition.id.localeCompare(right.definition.id),
  );
}

export const integrationMarketDependencies: RecipeMarketDependencies = async ({
  recipe,
}) => {
  if (recipe.schemaVersion === 1)
    return [
      { kind: 'base', query: query('fixture:base:legacy') },
      {
        kind: 'material',
        materialId: 'fixture-material',
        query: query('fixture:material:legacy'),
      },
      { kind: 'target', query: query('fixture:output:legacy') },
    ];
  const group = recipe.id.startsWith('physical-large-cluster-')
    ? 'production'
    : recipe.id.includes('-a-')
      ? 'a'
      : recipe.id.includes('-b-')
        ? 'b'
        : recipe.id.includes('-c-')
          ? 'c'
          : 'd';
  const materialDependencies =
    group === 'production' && recipe.id.endsWith('-jagged')
      ? [
          {
            materialId: 'jagged-fossil',
            queryKey: 'fixture:material:production:jagged',
          },
          {
            materialId: 'primitive-chaotic-resonator',
            queryKey: 'fixture:material:production:resonator',
          },
        ]
      : group === 'production'
        ? [
            {
              materialId: 'orb-of-alteration',
              queryKey: 'fixture:material:production:alteration',
            },
            {
              materialId: 'orb-of-transmutation',
              queryKey: 'fixture:material:production:transmutation',
            },
          ]
        : group === 'a' || group === 'c'
          ? [
              {
                materialId: 'fixture:jagged',
                queryKey: 'fixture:material:jagged',
              },
              {
                materialId: 'fixture:resonator',
                queryKey: 'fixture:material:resonator',
              },
            ]
          : [
              {
                materialId: 'fixture:lifeforce',
                queryKey: 'fixture:material:lifeforce',
              },
            ];
  return [
    {
      kind: 'base',
      query: query(
        `fixture:base:${group === 'production' ? 'production' : group === 'a' || group === 'b' ? 'a' : 'c'}`,
      ),
    },
    ...materialDependencies.map(({ materialId, queryKey }) => ({
      kind: 'material' as const,
      materialId,
      query: query(queryKey),
    })),
    {
      kind: 'target',
      query: query(
        group === 'production'
          ? `fixture:output:production:${recipe.id.endsWith('-jagged') ? 'jagged' : 'alteration'}`
          : `fixture:output:${group}`,
      ),
    },
  ];
};
export async function expectedDefaultQueryHashes(league = 'Fixture League') {
  return Promise.all(
    expectedDefaultQueryKeys.map((fixtureKey) =>
      hashMarketQuery({
        league,
        provider: 'poe-trade',
        query: { fixtureKey },
        schemaVersion: 1,
      }),
    ),
  );
}
