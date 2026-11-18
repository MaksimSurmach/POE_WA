import { expect, test } from '@playwright/test';

test.skip(
  process.env.PIPELINE !== 'legacy' ||
    process.env.BROWSER_FIXTURE_SCENARIO !== 'two-methods-priced',
  'Requires the legacy pipeline and the two-methods-priced market fixtures',
);

test('keeps one Home target and exposes both priced methods in its popup', async ({
  page,
}) => {
  const jagged = '/recipes/physical-large-cluster-jagged';
  const chaos = '/recipes/physical-large-cluster-chaos';
  await page.goto(jagged);
  const table = page.getByRole('table', { name: 'Методы для этой цели' });
  const rows = table.locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(2);

  const budget = /^\d[\d,]*(?:\.\d+)? c$/;
  const rankedMethods = [
    { path: jagged, profit: '+14,468 c' },
    { path: chaos, profit: '+3,481 c' },
  ];
  for (const [index, { path, profit }] of rankedMethods.entries()) {
    const row = rows.nth(index);
    await expect(row.getByRole('rowheader').getByRole('link')).toHaveAttribute(
      'href',
      `${path}?recipe=${path.split('/').at(-1)}`,
    );
    await expect(
      row.getByRole('link', { name: 'План материалов', exact: true }),
    ).toHaveAttribute(
      'href',
      `${path}?view=materials&recipe=${path.split('/').at(-1)}`,
    );
    const cells = row.getByRole('cell');
    await expect(cells.nth(2)).toHaveText(profit);
    await expect(cells.nth(4)).toHaveText(budget);
    await expect(cells.nth(5)).toHaveText(budget);
    await expect(row.getByLabel('Evidence grade A')).toBeVisible();
  }
  await expect(
    rows.first().getByText('Лучший по оценке разницы с ask'),
  ).toBeVisible();

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
  const catalogue = (await (await page.request.get('/api/catalog')).json())
    .data;
  const signature = catalogue.entries.find(
    (entry: { recipe: { id: string } }) =>
      entry.recipe.id === jagged.split('/').at(-1),
  ).recipe.targetSignature;
  const target = page.locator(`[data-market-target="${signature}"]`);
  await expect(target).toHaveCount(1);
  await target.locator('.market-item-button').click();
  const popup = page.getByRole('dialog');
  await expect(
    popup.getByRole('tab', { name: 'Market', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const comparison = popup.getByRole('table', {
    name: 'Methods for this exact output',
  });
  await expect(comparison.locator('tbody tr')).toHaveCount(2);
  for (const { path, profit } of rankedMethods) {
    const name = catalogue.entries.find(
      (entry: { recipe: { id: string } }) =>
        entry.recipe.id === path.split('/').at(-1),
    ).recipe.methodName;
    const method = comparison.locator('tbody tr').filter({ hasText: name });
    await expect(method.getByRole('cell').nth(1)).toContainText(profit);
    await method
      .getByRole('button', { name: `View recipe: ${name}`, exact: true })
      .click();
    await expect(
      popup.getByRole('tab', { name: 'Recipe', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(popup.getByLabel('Craft method', { exact: true })).toHaveValue(
      path.split('/').at(-1)!,
    );
    await popup.getByRole('tab', { name: 'Market', exact: true }).click();
  }
  await popup.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Класс предмета', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
