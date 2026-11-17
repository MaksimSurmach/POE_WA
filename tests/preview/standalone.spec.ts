import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('standalone file supports navigation without network or live writes', async ({
  page,
}) => {
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
    page.getByRole('heading', { name: 'Что крафтить', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Название предмета', exact: true })
    .fill('Physical');
  await expect(
    page.getByRole('status').filter({ hasText: 'из 7 рецептов' }),
  ).toHaveText('1 из 7 рецептов');
  const navigate = async (name: string) => {
    await page.getByRole('link', { name, exact: true }).click();
  };
  await navigate('Настройки');
  await expect(
    page.getByRole('button', { name: 'Запустить сбор', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Приостановить сбор', exact: true }),
  ).toBeDisabled();
  await navigate('Рынок');
  const overview = page.getByRole('region', {
    name: 'Обзор рынка всех рецептов',
    exact: true,
  });
  await expect(overview).toContainText('7 целей');
  await page
    .getByLabel('Выберите рецепт')
    .selectOption({ label: 'Physical Large Cluster Jewel' });
  await page
    .getByRole('button', { name: 'Открыть историю цены ↓', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'История цены выбранной цели',
      exact: true,
    }),
  ).toBeFocused();
  await expect(overview).toBeVisible();
  await navigate('Рецепты');
  await expect(
    page.getByRole('heading', { name: 'Каталог рецептов', exact: true }),
  ).toBeVisible();
  await navigate('Моя мастерская');
  await expect(
    page.getByRole('heading', { name: 'Моя мастерская', exact: true }),
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
