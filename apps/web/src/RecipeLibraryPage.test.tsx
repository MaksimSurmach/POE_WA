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
  expect(html).toContain('Materials and steps');
});

it('filters the recipe library by class and preserves working recipe links', () => {
  const category = catalogFixtures[0]!.recipe.category;
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/recipes?category=${category}`]}>
      <RecipeLibrary entries={catalogFixtures} />
    </MemoryRouter>,
  );
  for (const { recipe } of catalogFixtures) {
    if (recipe.category === category)
      expect(html).toContain(`href="/recipes/${recipe.id}"`);
    else expect(html).not.toContain(`href="/recipes/${recipe.id}"`);
  }
});
