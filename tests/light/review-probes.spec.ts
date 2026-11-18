import { expect, test } from '@playwright/test';
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';
import { createObservedItemPresentation } from '../../apps/server/dist/itemPresentation.js';
import {
  catalogResponseSchema,
  recipeResponseSchema,
} from '../../packages/contracts/dist/index.js';

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

test('market table headers keep their controls inside the column', async ({
  page,
}) => {
  await page.goto('/');
  const headers = page.locator('.market-items-table thead th:visible');
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
        const button = cell.querySelector('button');
        return button ? button.scrollWidth > button.clientWidth : false;
      }).length,
  );
  expect(overflowing).toBe(0);
});

test('Home target methods deduplicate and its observed chart keeps its full size', async ({
  page,
}) => {
  const response = await createPreviewFetch()('/api/catalog');
  const body = await response.json();
  const entry = body.data.entries[0];
  entry.recipe.title =
    'Bow Damage Large Cluster · Arcing Shot / Martial Prowess / Vicious Skewering';
  entry.recipe.craftMethod = 'Chaos Orb · 3 Notables';
  entry.readiness = {
    level: 'price-observed',
    capturedAt: '2026-11-17T10:00:00Z',
    fresh: true,
    coverage: 'partial',
    currentListings: 5,
    currentSellers: 4,
    comparableSellers: 4,
    currentAskRange: {
      min: { amount: 42, currency: 'chaos' },
      max: { amount: 55, currency: 'chaos' },
    },
    staleFloorCount: 0,
    comparableAsks: true,
    costVerified: false,
    saleEligible: false,
    activityMeasurable: false,
    last24h: {
      complete: 1,
      partial: 1,
      failed: 0,
      failuresTrackedSince: null,
      spanMinutes: 0,
      completeSpanMinutes: 0,
      largestGapMinutes: null,
      overdueIntervals: null,
      sellers: 4,
      listings: 5,
      repriced: null,
      inferredExits: 0,
      exitSellers: null,
      uncertainExits: null,
      relisted: null,
      askRange: null,
    },
  };
  const other = structuredClone(entry);
  other.recipe.id = 'synthetic-other-method';
  other.evaluation.recipeId = other.recipe.id;
  body.data.entries = [entry, other];
  catalogResponseSchema.parse(body);
  await page.route('**/api/catalog', (route) => route.fulfill({ json: body }));
  await page.goto('/');
  const rows = page.locator('[data-market-target]');
  await expect(rows).toHaveCount(1);
  const item = rows.first().locator('.market-item-button');
  await expect(
    page.getByRole('link', { name: 'Settings', exact: true }),
  ).toBeInViewport();
  await item.scrollIntoViewIfNeeded();
  await expect(item).toBeInViewport();
  await item.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('tab', { name: 'Market', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    dialog.getByRole('region', { name: 'Current asking evidence' }),
  ).toContainText('42 c');
  const chart = dialog.locator('.trend-chart__svg');
  await expect(chart).toBeVisible();
  const chartBounds = await chart.boundingBox();
  expect(chartBounds?.width).toBeGreaterThan(250);
  expect(chartBounds?.height).toBeGreaterThan(200);
});

test('choosing a target for an empty budget stays in the budget journey', async ({
  page,
}) => {
  await page.goto('/?view=budget');
  await page
    .getByRole('button', { name: 'Niche Elemental Bow', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Бюджет крафта', exact: true }),
  ).toBeVisible();
});

test('Category Library excludes guides while their saved deep links still resolve', async ({
  page,
}) => {
  await page.goto('/recipes?view=guides');
  await expect(
    page.getByRole('combobox', { name: 'Источник', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Niche Elemental Bow', exact: true }),
  ).toBeVisible();
  await expect(page.locator('a[href^="/recipes/pohx/"]')).toHaveCount(0);
  await page.goto('/recipes/pohx/totem-shield');
  await expect(
    page.getByRole('heading', { name: 'RF Totem Shield', exact: true }),
  ).toBeVisible();
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
    page.getByRole('form', { name: 'Запись события мастерской', exact: true }),
  ).toBeVisible();
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

test('explicit market currency follows the shared section links', async ({
  page,
}) => {
  await page.goto('/?currency=divine');
  await expect(page.locator('.workspace-context')).toContainText('divine');
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'Recipes', exact: true })
    .click();
  await expect(page).toHaveURL(/currency=divine/);
  await expect(page.locator('.workspace-context')).toContainText('divine');
});

test('Home controls preserve independent choices and family-scoped economics agree with CSV', async ({
  page,
}) => {
  const body = await (await createPreviewFetch()('/api/catalog')).json();
  const chaos = body.data.entries[0];
  chaos.recipe.title = 'Synthetic family-scope target';
  chaos.recipe.craftFamilies = ['chaos'];
  chaos.recipe.methodName = 'Synthetic Chaos';
  chaos.evaluation.expectedCraftCost = { amount: 50, currency: 'chaos' };
  chaos.snapshot.listings = [
    {
      ...chaos.snapshot.listings[0],
      price: { amount: 100, currency: 'chaos' },
    },
  ];
  delete chaos.readiness;
  const fossil = structuredClone(chaos);
  fossil.recipe.id = 'synthetic-fossil-bench';
  fossil.evaluation.recipeId = fossil.recipe.id;
  fossil.recipe.craftFamilies = ['fossil', 'bench'];
  fossil.recipe.methodName = 'Synthetic Fossil + Bench';
  fossil.evaluation.expectedCraftCost = { amount: 70, currency: 'chaos' };
  body.data.entries = [chaos, fossil];
  catalogResponseSchema.parse(body);
  await page.route('**/api/catalog', (route) => route.fulfill({ json: body }));
  await page.goto('/');
  const rows = page.locator('[data-market-target]');
  await expect(rows).toHaveCount(1);
  expect(
    await page.locator('.market-map-group').evaluateAll((groups) =>
      groups.every((group) => {
        const heading = group.querySelector('h3')!;
        const tiles = group.querySelector('.market-map-tiles')!;
        return (
          getComputedStyle(heading).display === 'none' ||
          heading.getBoundingClientRect().bottom <=
            tiles.getBoundingClientRect().top + 1
        );
      }),
    ),
  ).toBe(true);
  await expect(rows.first().locator('td').nth(6)).toContainText('50 c');
  await expect(rows.first().locator('td').nth(7)).toContainText('50 c');
  await page.getByLabel('Size', { exact: true }).selectOption('asking-price');
  await page
    .getByLabel('Group by', { exact: true })
    .selectOption('craft-method');
  await expect(page.getByLabel('Color', { exact: true })).toHaveValue(
    'cost-spread',
  );
  await expect(page.getByLabel('Size', { exact: true })).toHaveValue(
    'asking-price',
  );
  await page
    .getByLabel('Color', { exact: true })
    .selectOption('listing-activity');
  await expect(page.getByLabel('Group by', { exact: true })).toHaveValue(
    'craft-method',
  );
  await page
    .getByLabel('Craft method family', { exact: true })
    .selectOption('fossil');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td').nth(6)).toContainText('70 c');
  await expect(rows.first().locator('td').nth(7)).toContainText('30 c');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const { readFile } = await import('node:fs/promises');
  const content = await readFile((await file.path())!, 'utf8');
  expect(content.split('\r\n')).toHaveLength(2);
  expect(content).toContain(
    '"Synthetic family-scope target","Fossil","100","chaos"',
  );
  expect(content).toContain('"70","30"');
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await expect(page.getByLabel('Group by', { exact: true })).toHaveValue(
    'craft-method',
  );
  await expect(page.getByLabel('Color', { exact: true })).toHaveValue(
    'listing-activity',
  );
  await expect(page.getByLabel('Size', { exact: true })).toHaveValue(
    'asking-price',
  );
  await expect(rows.first().locator('td').nth(6)).toContainText('50 c');
});

test('catalogue stays usable while trends hang, and market tabs work from the keyboard', async ({
  page,
}) => {
  const catalogue = await (await createPreviewFetch()('/api/catalog')).json();
  const targetCount = new Set(
    catalogue.data.entries.map(
      (entry: { recipe: { targetSignature: string } }) =>
        entry.recipe.targetSignature,
    ),
  ).size;
  let release!: () => void;
  let trendRequests = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/trends?*', async (route) => {
    trendRequests++;
    await pending;
    if (!page.isClosed() && !route.request().failure()) await route.fallback();
  });
  try {
    await page.goto('/');
    await expect.poll(() => trendRequests).toBeGreaterThan(0);
    await expect(page.locator('[data-market-target]')).toHaveCount(
      targetCount,
      {
        timeout: 3_000,
      },
    );
    await expect(
      page.getByRole('heading', { name: 'Loading market', exact: true }),
    ).toHaveCount(0);
    const track = page.getByRole('button', { name: 'Track item', exact: true });
    await expect(track).toBeDisabled();
    await expect(track).toHaveAttribute(
      'aria-describedby',
      'track-unavailable',
    );
    await expect(page.locator('#track-unavailable')).toHaveText(
      'Independent monitoring unavailable',
    );
    const items = page.getByRole('tab', { name: 'Items', exact: true });
    const materials = page.getByRole('tab', { name: 'Materials', exact: true });
    await items.focus();
    await page.keyboard.press('ArrowRight');
    await expect(materials).toBeFocused();
    await expect(materials).toHaveAttribute('aria-selected', 'true');
    await expect(items).toHaveAttribute('tabindex', '-1');
    await expect(
      page.getByRole('tabpanel', { name: 'Materials', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Home');
    await expect(items).toBeFocused();
    await expect(items).toHaveAttribute('aria-selected', 'true');
    await expect(materials).toHaveAttribute('tabindex', '-1');
    await expect(
      page.getByRole('tabpanel', { name: 'Items', exact: true }),
    ).toBeVisible();
    const completed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/trends',
    );
    release();
    await completed;
  } finally {
    release();
  }
});
