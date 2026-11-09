import { expect, test } from '@playwright/test';

test.skip(
  process.env.BROWSER_FIXTURE_SCENARIO !== 'two-methods-priced',
  'Requires the two-methods-priced market fixtures',
);

test('ranks two priced methods and shows both profits on the homepage', async ({
  page,
}) => {
  const jagged = '/recipes/physical-large-cluster-jagged';
  const chaos = '/recipes/physical-large-cluster-chaos';
  await page.goto(jagged);
  const table = page.getByRole('table', { name: 'Methods for this target' });
  const rows = table.locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(2);

  const budget = /^\d[\d,]*(?:\.\d+)? c$/;
  const rankedMethods = [
    { path: jagged, profit: '+14,475 c' },
    { path: chaos, profit: '+3,481 c' },
  ];
  for (const [index, { path, profit }] of rankedMethods.entries()) {
    const row = rows.nth(index);
    await expect(row.getByRole('link')).toHaveAttribute('href', path);
    const cells = row.getByRole('cell');
    await expect(cells.nth(2)).toHaveText(profit);
    await expect(cells.nth(4)).toHaveText(budget);
    await expect(cells.nth(5)).toHaveText(budget);
    await expect(row.getByLabel('Evidence grade A')).toBeVisible();
  }
  await expect(rows.first().getByText('Best by expected profit')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 840 });
  const scrollRegion = page.getByRole('region', {
    name: 'Method comparison, scroll for more columns',
  });
  await scrollRegion.focus();
  await expect(scrollRegion).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.goto('/');
  for (const { path, profit } of rankedMethods) {
    const row = page.getByRole('row').filter({
      has: page.locator(`a[href="${path}"]`),
    });
    await expect(row.getByRole('cell').nth(3)).toContainText(profit);
  }
});
