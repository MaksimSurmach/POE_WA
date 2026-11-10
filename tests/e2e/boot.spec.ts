import { test, expect, waitForCollector } from './fixtures';

test('BOOT-01 packaged web assets and direct recipe route', async ({
  page,
}) => {
  await waitForCollector(page.request);
  const assetResponses: Array<{ type: string; status: number }> = [];
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (type === 'script' || type === 'stylesheet') {
      assetResponses.push({ type, status: response.status() });
    }
  });
  const recipeResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      '/api/recipes/physical-large-cluster-jagged',
  );
  const route = await page.goto('/recipes/physical-large-cluster-jagged');
  expect(route?.status()).toBe(200);
  expect((await recipeResponse).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Physical Cluster Jewel · 3 Notables' }),
  ).toBeVisible();
  expect(assetResponses.some(({ type }) => type === 'script')).toBe(true);
  expect(assetResponses.some(({ type }) => type === 'stylesheet')).toBe(true);
  expect(assetResponses.every(({ status }) => status === 200)).toBe(true);
});
