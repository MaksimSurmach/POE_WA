import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { RecipeLibrary } from './RecipeLibraryPage.js';
import { catalogFixtures } from './mocks/catalog.js';

it('includes every recipe even with no market prices and ignores profitability filters', () => {
  const entries = catalogFixtures.map((entry) => ({
    ...entry,
    evaluation: {
      ...entry.evaluation,
      profit: null,
      marginPercent: null,
      expectedCraftCost: null,
      estimatedSalePrice: null,
    },
  }));
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/recipes?minRoi=999']}>
      <RecipeLibrary entries={entries} />
    </MemoryRouter>,
  );
  for (const { recipe } of entries) expect(html).toContain(recipe.title);
  expect(html).not.toContain('ROI');
  expect(html).toContain('One item, multiple routes.');
  expect(html).toContain('Not estimated');
});

it('filters by class and exposes stable exact-method controls', () => {
  const category = catalogFixtures[0]!.recipe.category;
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/recipes?category=${category}`]}>
      <RecipeLibrary entries={catalogFixtures} />
    </MemoryRouter>,
  );
  for (const { recipe } of catalogFixtures) {
    if (recipe.category === category)
      expect(html).toContain(`id="route-${recipe.id}"`);
    else expect(html).not.toContain(`id="route-${recipe.id}"`);
  }
});

it('shows full category totals while filtered shelves and routes change', () => {
  const entry = catalogFixtures[0]!;
  const entries = [
    entry,
    {
      ...entry,
      recipe: {
        ...entry.recipe,
        id: 'alternative',
        craftFamilies: ['fossil' as const],
      },
    },
  ];
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/recipes?family=fossil']}>
      <RecipeLibrary entries={entries} />
    </MemoryRouter>,
  );
  expect(html).toContain('1 outputs');
  expect(html).toContain('1 crafting methods');
  expect(html).toContain('id="route-alternative"');
  expect(html).not.toContain(`id="route-${entry.recipe.id}"`);
  expect(html).toContain(
    'Category and craft method counts describe the full recipe catalogue',
  );
});
