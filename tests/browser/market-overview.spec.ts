import { expect, test } from '@playwright/test';
import { catalogFixtures } from '../../apps/web/src/mocks/catalog.js';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-11-11T10:00:00.000Z';
const alternate = {
  ...catalogFixtures[0]!,
  recipe: {
    ...catalogFixtures[0]!.recipe,
    id: 'alternate-method',
    title: 'Other crafting method',
  },
  evaluation: {
    ...catalogFixtures[0]!.evaluation,
    recipeId: 'alternate-method',
  },
};
const entries = [...catalogFixtures, alternate];
const window = {
  state: 'empty',
  range: '7d',
  bucketSeconds: 3600,
  windowStart: '2026-11-04T10:00:00.000Z',
  windowEnd: at,
  league: { id, name: 'Current Fixture League' },
  priceBasis: 'asking',
  salesVolume: 'unknown',
};

test('current market includes every recipe and selection preserves the overview', async ({
  page,
}) => {
  const archivedRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/trade-history'))
      archivedRequests.push(request.url());
  });
  await page.route('**/api/catalog', (route) =>
    route.fulfill({
      json: {
        correlationId: id,
        data: { entries, pipeline: 'collector' },
        state: 'success',
        errorCode: null,
        isStale: false,
        lastSuccessfulAt: at,
        publishedAt: at,
        refreshStatus: 'published',
      },
    }),
  );
  await page.route('**/api/trends?*', (route) =>
    route.fulfill({
      json: {
        correlationId: id,
        data: {
          ...window,
          entries: entries.map(({ recipe }) => ({
            recipeId: recipe.id,
            title: recipe.title,
            category: recipe.category,
            summary: null,
          })),
        },
      },
    }),
  );
  await page.route('**/api/recipes/*/trends?*', (route) =>
    route.fulfill({
      json: {
        correlationId: id,
        data: {
          ...window,
          recipeId: entries[0]!.recipe.id,
          title: entries[0]!.recipe.title,
          summary: null,
          buckets: [],
        },
      },
    }),
  );
  await page.goto('/market');
  const overview = page.getByRole('region', {
    name: 'All recipes market overview',
    exact: true,
  });
  await expect(
    overview.getByRole('heading', {
      name: 'All recipes · current market',
      exact: true,
    }),
  ).toBeVisible();
  await expect(overview.locator('.trade-map__point').first()).toBeVisible();
  expect(await overview.locator('.trade-map__point').count()).toBeGreaterThan(
    1,
  );
  await expect(
    page.getByRole('region', { name: 'Selected recipe price history' }),
  ).toContainText('Select a recipe');
  await overview.getByRole('button', { name: /^2 recipes,/ }).click();
  const choices = page.getByRole('group', { name: 'Recipes at this point' });
  await expect(choices).toBeVisible();
  await choices
    .getByRole('button', { name: 'Other crafting method', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Selected recipe price history' }),
  ).toContainText('Other crafting method');
  await expect(choices).toBeHidden();
  await overview.locator('summary').click();
  await expect(overview.locator('tbody tr')).toHaveCount(entries.length);
  await expect(
    overview.getByText('No fresh ask', { exact: true }).first(),
  ).toBeVisible();
  await overview.locator('tbody tr').first().getByRole('button').click();
  await expect(
    page.getByRole('region', { name: 'Selected recipe price history' }),
  ).toContainText(entries[0]!.recipe.title);
  await expect(overview.locator('.trade-map__point').first()).toBeVisible();
  expect(archivedRequests).toEqual([]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test('all main pages share typography, palette and content width', async ({
  page,
}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    let expected: unknown;
    for (const path of [
      '/',
      '/recipes',
      '/recipes/physical-large-cluster-chaos',
      '/recipes/pohx/gloves',
      '/market',
      '/factory',
    ]) {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toBeVisible();
      const theme = await page.evaluate(() => {
        const title = getComputedStyle(document.querySelector('main h1')!);
        return {
          background: getComputedStyle(document.body).backgroundColor,
          text: title.color,
          font: title.fontFamily,
          titleSize: title.fontSize,
          width: document.querySelector('main')!.getBoundingClientRect().width,
        };
      });
      if (expected) expect(theme, path).toEqual(expected);
      else expected = theme;
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        path,
      ).toBeLessThanOrEqual(width);
    }
  }
});
