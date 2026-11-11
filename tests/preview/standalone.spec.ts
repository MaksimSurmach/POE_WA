import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('standalone file supports navigation without network or live writes', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
  });
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(
    pathToFileURL(resolve('apps/web/dist-preview/worksmith-heroui.html')).href,
  );
  await expect(
    page.getByRole('heading', { name: 'Craft opportunities', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Item name', exact: true })
    .fill('Physical');
  await expect(
    page.getByRole('status').filter({ hasText: 'of 7 recipes' }),
  ).toHaveText('1 of 7 recipes');
  const navigate = async (name: string) => {
    if (testInfo.project.name === 'mobile')
      await page
        .getByRole('button', { name: 'Worksmith menu', exact: true })
        .click();
    await page.getByRole('link', { name, exact: true }).click();
  };
  await navigate('Settings');
  await expect(
    page.getByRole('button', { name: 'Run now', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Pause collection', exact: true }),
  ).toBeDisabled();
  await navigate('Market trends');
  const overview = page.getByRole('region', {
    name: 'All recipes market overview',
    exact: true,
  });
  await expect(overview).toContainText('7 targets');
  await page
    .getByLabel('Choose recipe')
    .selectOption({ label: 'Physical Large Cluster Jewel' });
  await page
    .getByRole('button', { name: 'View recipe price history ↓', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Recipe price history', exact: true }),
  ).toBeFocused();
  await expect(overview).toBeVisible();
  await navigate('Recipes');
  await expect(
    page.getByRole('heading', { name: 'Crafting recipes', exact: true }),
  ).toBeVisible();
  await navigate('My Factory');
  await expect(
    page.getByRole('heading', { name: 'My Factory', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /00000000 · Physical Large Cluster Jewel/,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
