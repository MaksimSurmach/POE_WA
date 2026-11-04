import { test, expect } from './fixtures';

test('BOOT-01 packaged web assets and direct recipe route', async ({
  page,
}) => {
  const route = await page.goto('/recipes/physical-large-cluster-jagged');
  expect(route?.status()).toBe(200);
  await expect(page.locator('#root')).not.toBeEmpty();
  const assets = await page
    .locator('script[src],link[rel="stylesheet"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('src') ?? node.getAttribute('href'))
        .filter(Boolean),
    );
  expect(assets.some((asset) => asset?.includes('.js'))).toBe(true);
});
