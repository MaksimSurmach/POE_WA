import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';
import {
  craftAnalysisResponseSchema,
  recipeResponseSchema,
} from '../../packages/contracts/dist/index.js';
import { workspaceSections } from '../../apps/web/src/workspaceNavigation.js';

const recipe = 'no-listings-bow';
const batch = '00000000-0000-4000-8000-000000000010';
// Production entrypoint with explicitly synthetic API responses; no database or provider is contacted.
test.beforeEach(async ({ page }) => {
  const fetch = createPreviewFetch();
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/analysis')) {
      const recipeId = new URL(route.request().url()).pathname.split('/')[3]!;
      const data = craftAnalysisResponseSchema.parse({
        correlationId: 'synthetic-light-test',
        data: {
          recipeId,
          recipeHash: 'synthetic-revision',
          targetSignature: 'synthetic-target',
          league: 'Preview League',
          leagueId: '00000000-0000-4000-8000-000000000001',
          evaluatedAt: '2026-11-17T10:00:00Z',
          modelRecord: null,
          embeddedModel: null,
          analysis: null,
          prices: {},
          valuations: {},
          unavailableReasons: ['Synthetic test: no probability model'],
          canEdit: true,
        },
      });
      return route.fulfill({ json: data });
    }
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

test('all 20 views render with contained tables, light surfaces and no runtime errors', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (process.env.CAPTURE_LIGHT_EVIDENCE)
    await mkdir('docs/evidence/worksmith-light', { recursive: true });
  for (const section of workspaceSections) {
    for (const [view] of section.tabs) {
      const path =
        section.path === '/recipes' && !['catalog', 'guides'].includes(view)
          ? `/recipes/${recipe}`
          : section.path;
      await page.goto(
        `${path}?view=${view}&recipe=${recipe}&league=Preview%20League&batch=${batch}`,
      );
      await expect(page.locator('main h1').first()).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: 'Main navigation', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--background')
            .trim(),
        ),
      ).toBe('#ffffff');
      expect(await page.locator('main').innerText()).not.toContain('Fettle');
      if (
        process.env.CAPTURE_LIGHT_EVIDENCE &&
        ((info.project.name === 'desktop' &&
          ['screener', 'catalog', 'overview', 'batches', 'general'].includes(
            view,
          )) ||
          (['mobile', 'tablet'].includes(info.project.name) &&
            ['screener', 'methods', 'overview', 'batch'].includes(view)))
      ) {
        await page.screenshot({
          path: `docs/evidence/worksmith-light/${info.project.name}-${view}.png`,
          fullPage: false,
        });
      }
    }
  }
  expect(errors).toEqual([]);
});

test('selected target survives budget → materials → workshop, including edits and API failure', async ({
  page,
}) => {
  await page.goto(`/recipes/${recipe}?league=Preview%20League&currency=divine`);
  await expect(page.locator('main h1')).toHaveText('Niche Elemental Bow');
  await page.getByRole('link', { name: 'Бюджет', exact: true }).click();
  await page.getByLabel('Количество предметов', { exact: true }).fill('3');
  const quantity = page
    .getByRole('spinbutton', { name: /^На предмет:/ })
    .first();
  const price = page.getByRole('spinbutton', { name: /^Цена \(/ }).first();
  const owned = page.getByRole('spinbutton', { name: /^Есть:/ }).first();
  await quantity.fill('2');
  await price.fill('10.25');
  await page
    .getByRole('combobox', { name: /^Валюта:/ })
    .first()
    .selectOption('chaos');
  await owned.fill('1');
  await page.getByRole('link', { name: 'К материалам', exact: true }).click();
  await expect(
    page.getByLabel('Количество предметов', { exact: true }),
  ).toHaveValue('3');
  await expect(quantity).toHaveValue('2');
  await expect(price).toHaveValue('10.25');
  await expect(owned).toHaveValue('1');
  await expect(page.locator('.plan-table tbody tr').first()).toContainText(
    '51.25',
  );
  await page.reload();
  await expect(price).toHaveValue('10.25');
  await page.getByRole('link', { name: 'Создать партию', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`recipe=${recipe}`));
  await expect(
    page.getByRole('combobox', { name: 'Рецепт крафта', exact: true }),
  ).toHaveValue(recipe);
  await expect(
    page.getByLabel('Заметки к партии', { exact: true }),
  ).toHaveValue(/План: 3 предметов/);
  const create = page.getByRole('form', {
    name: 'Создание партии',
    exact: true,
  });
  await create
    .getByLabel('Сумма в валюте операции', { exact: true })
    .fill('50');
  const currency = create.getByRole('combobox', {
    name: 'Валюта операции',
    exact: true,
  });
  await currency.selectOption('chaos');
  await page.route('**/api/admin/factory/batches', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.abort('failed');
  });
  // A missing EV model does not prevent the existing ledger API from creating a batch.
  const submit = create.getByRole('button', {
    name: 'Создать партию',
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    create.getByLabel('Сумма в валюте операции', { exact: true }),
  ).toHaveValue('50');
});

test('favorites preserve the actual target and storage failures never simulate success', async ({
  page,
}) => {
  await page.goto(`/recipes/${recipe}`);
  await page.getByRole('button', { name: 'Add favorite', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove favorite', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: /^Favorites/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Favorite recipes', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Niche Elemental Bow', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove favorite', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-target-id]')).toHaveCount(0);
  await page.goto(`/recipes/${recipe}`);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Disabled storage', 'SecurityError');
    };
  });
  await page.getByRole('button', { name: 'Add favorite', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Favorites could not be saved',
  );
  await expect(
    page.getByRole('button', { name: 'Add favorite', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('missing values remain unavailable and API errors allow retry', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/catalog', async (route) => {
    if (fail) await route.fulfill({ status: 503, body: '{}' });
    else await route.fallback();
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Рецепты недоступны', exact: true }),
  ).toBeVisible();
  fail = false;
  await page
    .getByRole('button', { name: 'Повторить загрузку', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Niche Elemental Bow', exact: true }),
  ).toBeVisible();
  await page.goto(`/recipes/${recipe}?view=materials`);
  const price = page.getByRole('spinbutton', { name: /^Цена \(/ }).first();
  await price.fill('');
  await expect(
    page.locator('.plan-table tbody tr').first().locator('td').last(),
  ).toHaveText('—');
  await expect(
    page.getByRole('status').filter({ hasText: 'План неполный' }),
  ).toBeVisible();
  await page.goto('/?view=budget');
  await expect(
    page.getByRole('heading', {
      name: 'Выберите целевой предмет',
      exact: true,
    }),
  ).toBeVisible();
});

test('confirmed sales and inventory link back to the actual batch and its recipe', async ({
  page,
}) => {
  await page.goto(
    '/factory?view=sales&league=Preview%20League&recipe=no-listings-bow',
  );
  const sales = page.getByRole('region', { name: 'Продажи', exact: true });
  await expect(sales.locator('tbody tr')).toHaveCount(1);
  await expect(sales.locator('tbody tr td').last()).toHaveText('60 c');
  await sales.getByRole('link').click();
  await expect(page).toHaveURL(/recipe=profitable-cluster/);
  await expect(
    page.getByRole('heading', { name: 'Произведённые предметы', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('form', { name: 'Запись события мастерской', exact: true }),
  ).toBeVisible();
  const inventoryUrl = new URL(page.url());
  inventoryUrl.searchParams.set('view', 'inventory');
  await page.goto(inventoryUrl.href);
  const inventory = page.getByRole('region', { name: 'Предметы', exact: true });
  await expect(inventory).toContainText('Illustrative finished item');
  await expect(inventory).toContainText('100 c');
  await expect(inventory).toContainText('sold');
});

test('settings validate, persist through the API and reload the saved values', async ({
  page,
}) => {
  const initial = await createPreviewFetch()('/api/admin/market/settings');
  const envelope = await initial.json();
  let saved = envelope.data;
  let writes = 0;
  await page.route('**/api/admin/market/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      writes++;
      const input = route.request().postDataJSON();
      expect(input.version).toBe(saved.version);
      const updates = input.settings;
      saved = {
        ...saved,
        version: saved.version + 1,
        configured: { ...saved.configured, ...updates },
        effective: { ...saved.effective, ...updates },
      };
    }
    await route.fulfill({ json: { data: saved } });
  });
  await page.goto('/settings');
  const maximum = page.getByRole('spinbutton', {
    name: 'Максимальный возраст цены (минуты)',
    exact: true,
  });
  const warning = page.getByRole('spinbutton', {
    name: 'Предупреждать о возрасте (минуты)',
    exact: true,
  });
  await expect(maximum).toBeVisible();
  await maximum.fill('10');
  await page
    .getByRole('button', { name: 'Сохранить настройки', exact: true })
    .click();
  expect(writes).toBe(0);
  await maximum.fill('90');
  await warning.fill('30');
  await page
    .getByRole('button', { name: 'Сохранить настройки', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Настройки сохранены.' }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.reload();
  await expect(maximum).toHaveValue('90');
  await expect(warning).toHaveValue('30');
});

test('keyboard reaches content, section links and horizontally scrolling tables', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  const region = page.getByRole('region', {
    name: 'Crafting targets',
    exact: true,
  });
  await region.focus();
  await expect(region).toBeFocused();
  if (info.project.name !== 'desktop') {
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => region.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
  }
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await settings.focus();
  await expect(settings).toBeInViewport();
  expect(
    await settings.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    ),
  ).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('main h1')).toHaveText('Настройки');
});

test('step progress stays local and prices from another league cannot be relabelled', async ({
  page,
}) => {
  const response = await createPreviewFetch()(`/api/recipes/${recipe}`);
  const body = await response.json();
  body.data.method.steps = [
    {
      id: 'synthetic-step',
      title: 'Synthetic base check',
      action: 'Inspect the base',
      materials: [],
      success: null,
      continueWhen: 'Matches the synthetic target',
      failureAction: 'Stop',
    },
  ];
  body.data.method.priceSources = [
    {
      itemId: 'synthetic-base',
      source: 'Explicit synthetic evidence',
      league: 'Synthetic source league',
      currency: 'chaos',
      capturedAt: '2026-11-17T10:00:00Z',
    },
  ];
  recipeResponseSchema.parse(body);
  await page.route(`**/api/recipes/${recipe}`, (route) =>
    route.fulfill({ json: body }),
  );
  await page.goto(`/recipes/${recipe}?view=steps`);
  const step = page.getByRole('checkbox', {
    name: 'Выполнен шаг: Synthetic base check',
    exact: true,
  });
  await step.check();
  await page.reload();
  await expect(step).toBeChecked();
  await page.goto(`/recipes/${recipe}?view=budget&league=Another%20league`);
  await expect(
    page.getByRole('heading', {
      name: 'Лига источника отличается',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('spinbutton', { name: 'Количество предметов', exact: true }),
  ).toHaveCount(0);
  await page.goto(`/recipes/${recipe}?view=steps&league=Another%20league`);
  await expect(step).toBeVisible();
  await expect(page.locator('.recipe-economics')).toHaveCount(0);
  await expect(page.locator('.recipe-ingredients .money')).toHaveCount(0);
});
