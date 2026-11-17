import { expect, test } from '@playwright/test';
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';
import { createObservedItemPresentation } from '../../apps/server/dist/itemPresentation.js';
import { recipeResponseSchema } from '../../packages/contracts/dist/index.js';

// Independent regression probes from the review; all APIs are local synthetic fixtures.
test.beforeEach(async ({ page }) => {
  const fetch = createPreviewFetch();
  await page.route('**/api/**', async (route) => {
    const response = await fetch(route.request().url(), {
      method: route.request().method(),
    });
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
});

test('mobile table header text fits its buttons', async ({ page }) => {
  await page.goto('/');
  const headers = page.locator('.craft-table thead th:visible');
  await expect(headers.first()).toBeVisible();
  const outsideCell = await headers.evaluateAll(
    (cells) =>
      cells.filter((cell) => {
        const th = cell.getBoundingClientRect();
        return [...cell.querySelectorAll('button, svg')].some((child) => {
          const box = child.getBoundingClientRect();
          return box.left < th.left || box.right > th.right;
        });
      }).length,
  );
  expect(outsideCell).toBe(0);
  const overflowing = await headers.evaluateAll(
    (cells) =>
      cells.filter((cell) => {
        const button = cell.querySelector('button')!;
        return button.scrollWidth > button.clientWidth;
      }).length,
  );
  expect(overflowing).toBe(0);
});

test('first mobile target exposes its observed price and action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const row = page
    .locator('.craft-table tbody tr:not(.craft-table__readiness-group)')
    .first();
  await expect(row.locator('.craft-table__mobile-ask')).toBeInViewport();
  await expect(row.locator('.craft-table__mobile-ask .money')).toHaveText(
    await row.locator('[data-label="Цена объявления"] .money').innerText(),
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Основные разделы', exact: true })
      .getByRole('link', { name: 'Настройки', exact: true }),
  ).toBeInViewport();
  await expect(row.locator('.craft-table__steps')).toBeInViewport({ ratio: 1 });
});

test('choosing a target for an empty budget stays in the budget journey', async ({
  page,
}) => {
  await page.goto('/?view=budget');
  await page
    .getByRole('link', { name: 'Niche Elemental Bow', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Бюджет крафта', exact: true }),
  ).toBeVisible();
});

test('guides have a fixed source and the full catalog applies source selection', async ({
  page,
}) => {
  await page.goto('/recipes?view=guides');
  const source = page.getByRole('combobox', { name: 'Источник', exact: true });
  await expect(source).toBeDisabled();
  await expect(source).toHaveValue('pohx');
  await expect(
    page.locator('.recipe-library a[href^="/recipes/pohx/"]').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Niche Elemental Bow', exact: true }),
  ).toHaveCount(0);
  await page.goto('/recipes');
  await source.selectOption('market');
  await expect(source).toHaveValue('market');
  await expect(
    page.getByRole('link', { name: 'Niche Elemental Bow', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.recipe-library a[href^="/recipes/pohx/"]'),
  ).toHaveCount(0);
});

test('raw observed modifier indexes do not prove a required mod is absent', async ({
  page,
}) => {
  const response = await createPreviewFetch()(
    '/api/recipes/profitable-cluster',
  );
  const body = await response.json();
  body.data.presentation.target.modifiers = [
    {
      canonicalId: 'life-mod-family',
      generationType: 'prefix',
      label: '+100 to maximum Life',
    },
  ];
  const at = '2026-11-17T10:00:00Z';
  body.data.snapshot = {
    id: 'synthetic-snapshot',
    queryHash: 'synthetic-query',
    capturedAt: at,
    totalResults: 1,
    listings: [
      {
        id: 'synthetic-offer',
        seller: 'synthetic-seller',
        price: { amount: 10, currency: 'chaos' },
        indexedAt: at,
        ageSeconds: 0,
        itemPreview: createObservedItemPresentation({
          baseType: 'Leather Belt',
          ilvl: 84,
          explicitMods: ['+100 to maximum Life'],
        }),
      },
    ],
  };
  recipeResponseSchema.parse(body);
  await page.route('**/api/recipes/profitable-cluster', (route) =>
    route.fulfill({ json: body }),
  );
  await page.goto('/market?view=compare&recipe=profitable-cluster');
  await page
    .getByRole('combobox', { name: 'Предложение', exact: true })
    .selectOption('synthetic-offer');
  const row = page
    .getByRole('region', { name: 'Сравнение модификаторов', exact: true })
    .locator('tbody tr')
    .first();
  await expect(row).not.toContainText('отсутствует');
  await expect(row).toContainText(/Неизвестно|Нельзя сопоставить/);
});

test('existing batch deep links still open batch details', async ({ page }) => {
  await page.goto(
    '/factory?batch=00000000-0000-4000-8000-000000000010&league=Preview%20League',
  );
  await expect(
    page.getByRole('heading', { name: 'Произведённые предметы', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', {
        name: 'Моя мастерская: представления',
        exact: true,
      })
      .getByRole('link', { name: 'Партия', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('failed method discovery is not labelled as no compatible methods', async ({
  page,
}) => {
  await page.route('**/api/catalog', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto('/recipes/profitable-cluster?view=methods');
  await expect(
    page.getByRole('heading', {
      name: 'Сравнение методов недоступно',
      exact: true,
    }),
  ).toBeVisible();
});

test('method discovery distinguishes loading, failure and successful retry', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/catalog', async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/recipes/profitable-cluster?view=methods');
  await expect(
    page.getByRole('heading', { name: 'Загрузка методов', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Нет совместимых методов', exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole('heading', {
      name: 'Сравнение методов недоступно',
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute('**/api/catalog');
  const fetch = createPreviewFetch();
  await page.route('**/api/catalog', async (route) => {
    const response = await fetch(route.request().url());
    await route.fulfill({ json: await response.json() });
  });
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Сравнение методов недоступно',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', {
      name: /Нет совместимых методов|Методы для этой цели/,
    }),
  ).toBeVisible();
});

test('the plan transfers its complete amount, unit and provenance without ledger writes', async ({
  page,
}) => {
  await page.goto(
    '/?view=budget&recipe=profitable-cluster&league=Preview%20League',
  );
  await page.getByLabel('Количество предметов', { exact: true }).fill('3');
  const rows = page.locator('.plan-table tbody tr');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (const row of await rows.all()) {
    await row.getByRole('spinbutton', { name: /^На предмет:/ }).fill('1');
    await row.getByRole('spinbutton', { name: /^Цена \(/ }).fill('2');
    await row.getByRole('combobox', { name: /^Валюта:/ }).selectOption('chaos');
  }
  await page.getByRole('link', { name: 'Создать партию', exact: true }).click();
  const create = page.getByRole('form', {
    name: 'Создание партии',
    exact: true,
  });
  await expect(
    create.getByLabel('Сумма в валюте операции', { exact: true }),
  ).toHaveValue(String(count * 6));
  await expect(
    create.getByRole('combobox', { name: 'Валюта операции', exact: true }),
  ).toHaveValue('chaos');
  await expect(
    page.getByLabel('Заметки к партии', { exact: true }),
  ).toHaveValue(/Среднее ожидаемой закупки.*Ручные цены: да/);
  await page.goto(
    '/factory?recipe=profitable-cluster&currency=divine&plannedBudget=9',
  );
  await expect(
    create.getByRole('combobox', { name: 'Валюта операции', exact: true }),
  ).toHaveValue('chaos');
  await expect(
    create.getByLabel('Сумма в валюте операции', { exact: true }),
  ).not.toHaveValue('9');
});

test('material plans can be downloaded when clipboard access fails', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  await page.goto(
    '/?view=budget&recipe=profitable-cluster&league=Preview%20League',
  );
  await page
    .getByRole('button', { name: 'Скопировать план', exact: true })
    .click();
  await expect(
    page.getByText('Буфер обмена недоступен.', { exact: false }),
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать TSV', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe(
    'worksmith-profitable-cluster-materials.tsv',
  );
  const { readFile } = await import('node:fs/promises');
  const content = await readFile((await file.path())!, 'utf8');
  expect(content.charCodeAt(0)).toBe(0xfeff);
  expect(content).toContain('Preview League');
  expect(content).toContain('Источник цены');
});

test('mobile market rows expose the same observed price beside their identity', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/market');
  const first = page.locator('.recipe-market__table tbody tr').first();
  await expect(first).toBeVisible();
  const inline = first.locator('.market-mobile-ask');
  await expect(inline).toBeVisible();
  await expect(inline.locator('.money')).toHaveText(
    await first.locator('[data-label="Цена объявления"] .money').innerText(),
  );
});

test('the threshold currency follows section links and an explicit change clears the legacy unit', async ({
  page,
}) => {
  await page.goto('/?currency=divine');
  const currency = page.getByRole('combobox', {
    name: 'Валюта оценки',
    exact: true,
  });
  await page.getByText('Фильтры', { exact: true }).click();
  await currency.selectOption('chaos');
  await expect(page).not.toHaveURL(/currency=divine/);
  await currency.selectOption('divine');
  await page
    .getByRole('navigation', { name: 'Основные разделы', exact: true })
    .getByRole('link', { name: 'Рецепты', exact: true })
    .click();
  await expect(page).toHaveURL(/profitCurrency=divine/);
  await expect(page.locator('.workspace-context')).toContainText('divine');
});
