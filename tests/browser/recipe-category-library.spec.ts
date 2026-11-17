import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  catalogEntrySchema,
  recipeDetailViewSchema,
  recipeTrendSchema,
} from '../../packages/contracts/dist/index.js';
import archive from '../fixtures/category-library-archive.json' with { type: 'json' };
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';

const entries = archive.entries.map((e) => catalogEntrySchema.parse(e));
const details = Object.values(archive.details).map((d) =>
  recipeDetailViewSchema.parse(d),
);
const histories = Object.values(archive.histories).map((h) =>
  recipeTrendSchema.parse(h),
);
const physical = entries.find(
  (e) => e.recipe.id === 'physical-large-cluster-chaos',
)!;
const jaggedId = 'physical-large-cluster-jagged';
const chaosId = 'physical-large-cluster-chaos';
const fettleId = 'small-cluster-life-fettle-2-passives';
const envelope = (data: unknown) => ({
  correlationId: '44444444-4444-4444-8444-444444444444',
  data,
  state: 'success',
  isStale: false,
  errorCode: null,
  lastSuccessfulAt: new Date(archive.provenance.snapshotAt).toISOString(),
  publishedAt: new Date(archive.provenance.snapshotAt).toISOString(),
  refreshStatus: 'published',
});

test.beforeEach(async ({ page }) => {
  const preview = createPreviewFetch();
  await page.route('https://web.poecdn.com/**', async (route) => {
    try {
      await route.fulfill({ response: await route.fetch({ timeout: 10_000 }) });
    } catch {
      await route.abort();
    }
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/catalog')
      return route.fulfill({
        json: envelope({
          entries,
          league: { id: 'archive-covens', name: 'Covens' },
        }),
      });
    const recipe = /^\/api\/recipes\/([^/]+)$/.exec(url.pathname)?.[1];
    if (recipe) {
      const detail = details.find((d) => d.recipe.id === recipe);
      if (detail) return route.fulfill({ json: envelope(detail) });
      return route.fulfill({
        status: 404,
        json: { message: 'No archived steps for this exact recipe' },
      });
    }
    const trendId = /^\/api\/trends\/([^/]+)$/.exec(url.pathname)?.[1];
    if (trendId) {
      const history = histories.find((h) => h.recipeId === trendId);
      if (history)
        return route.fulfill({
          json: {
            correlationId: '44444444-4444-4444-8444-444444444444',
            data: {
              ...history,
              recipeId: trendId,
              range: url.searchParams.get('range'),
            },
          },
        });
      return route.fulfill({ status: 503, json: {} });
    }
    const response = await preview(route.request().url(), {
      method: route.request().method(),
    });
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
});

test('archive renders unique shelves and matching methods; filters keep catalogue counts', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/recipes');
  await expect(
    page.getByRole('heading', { name: 'Recipes', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-target-id]')).toHaveCount(66);
  await expect(page.locator('.library-routes button')).toHaveCount(72);
  expect(
    await page
      .locator('[data-target-id]')
      .evaluateAll(
        (rows) =>
          new Set(rows.map((r) => r.getAttribute('data-target-id'))).size,
      ),
  ).toBe(66);
  await expect(page.getByRole('status')).toContainText('66 outputs');
  await expect(
    page.getByRole('button', { name: 'All item classes 66' }),
  ).toHaveAttribute('aria-pressed', 'true');
  if (process.env.CAPTURE_CATEGORY_EVIDENCE) {
    await mkdir('/tmp/max-1319-evidence', { recursive: true });
    await expect
      .poll(() =>
        page
          .locator('.target-art img')
          .first()
          .evaluate(
            (image) =>
              image instanceof HTMLImageElement && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: `/tmp/max-1319-evidence/library-${info.project.name}.png`,
    });
  }
  await page.getByLabel('Craft method', { exact: true }).selectOption('fossil');
  await expect(page.locator('[data-target-id]')).toHaveCount(12);
  await expect(page.locator('.library-routes button')).toHaveCount(12);
  await expect(
    page.getByRole('button', { name: 'All item classes 66' }),
  ).toBeVisible();
  await expect(page.locator(`[id="route-${chaosId}"]`)).toHaveCount(0);
  await page.getByLabel('With cost estimate', { exact: true }).click();
  await expect(
    page.getByLabel('With cost estimate', { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('heading', { name: 'No matching recipes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.getByLabel('With cost estimate', { exact: true }).click();
  await expect(
    page.getByLabel('With cost estimate', { exact: true }),
  ).toBeChecked();
  await expect(page.locator('[data-target-id]')).toHaveCount(10);
  await page.getByRole('button', { name: 'Cluster jewels 21' }).click();
  await expect(page.locator('[data-target-id]')).toHaveCount(10);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors).toEqual([]);
});

test('exact methods never borrow instructions; Back, scope, focus and scroll survive detail', async ({
  page,
}, info) => {
  await page.goto('/recipes?family=fossil&category=cluster-jewel&sort=name');
  const opener = page.locator(`[id="route-${jaggedId}"]`);
  await opener.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Craft method', { exact: true })).toHaveValue(
    jaggedId,
  );
  await expect(
    dialog.getByText('Crafting sequence', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('1/1 matching routes estimated', { exact: false }),
  ).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Market', exact: true }).click();
  await expect(
    dialog
      .locator('p')
      .filter({ hasText: /38 independent observations in this window/ }),
  ).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Market' })).toBeFocused();
  if (process.env.CAPTURE_CATEGORY_EVIDENCE && info.project.name === 'desktop')
    await page.screenshot({
      path: '/tmp/max-1319-evidence/physical-market.png',
    });
  await dialog.getByRole('tab', { name: 'Recipe' }).click();
  await expect(dialog.getByRole('tab', { name: 'Recipe' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    dialog.getByText('Crafting sequence', { exact: true }),
  ).toBeVisible();
  if (process.env.CAPTURE_CATEGORY_EVIDENCE && info.project.name === 'desktop')
    await page.screenshot({ path: '/tmp/max-1319-evidence/exact-jagged.png' });
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByLabel('Craft method', { exact: true })).toHaveValue(
    'fossil',
  );
  expect(
    Math.abs((await page.evaluate(() => window.scrollY)) - scroll),
  ).toBeLessThan(3);
  await page.goto('/recipes');
  await page.locator(`[id="route-${chaosId}"]`).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText('Exact recipe details could not be loaded.'),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').getByText('Crafting sequence', { exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator(`[id="route-${chaosId}"]`)).toBeFocused();
});

test('Fettle total, empty history, keyboard trap and reloadable deep link', async ({
  page,
}) => {
  await page.goto('/recipes?search=fettle&sort=cost');
  await expect(page.locator('[data-target-id]')).toHaveCount(1);
  await expect(page.locator('.library-cost')).toContainText('38.5 c');
  await page
    .getByRole('button', { name: 'Fettle · 2 passives', exact: true })
    .click();
  await page.reload();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.target-economics')).toContainText('38.5 c');
  await expect(dialog.locator('.target-economics')).toContainText('+61.5 c');
  await expect(dialog.getByLabel('Craft method', { exact: true })).toHaveValue(
    fettleId,
  );
  await dialog.getByRole('tab', { name: 'Market' }).click();
  await expect(
    dialog.getByText(/No independent ask observations/),
  ).toBeVisible();
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('dialog')),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByLabel('Search items or modifiers', { exact: true }),
  ).toHaveValue('fettle');
});

test('legacy favorites collapse by target and removal restores focus when the row disappears', async ({
  page,
}) => {
  await page.goto('/recipes');
  await page.evaluate(
    (id) => localStorage.setItem('worksmith:favorites', JSON.stringify([id])),
    chaosId,
  );
  await page.goto('/recipes?favorites=1&family=fossil');
  await expect(page.locator('[data-target-id]')).toHaveCount(1);
  await page.locator(`[id="route-${jaggedId}"]`).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Remove favorite', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Add favorite', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-target-id]')).toHaveCount(0);
  await expect(
    page.getByLabel('Search items or modifiers', { exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('worksmith:favorites') ?? '[]'),
    ),
  ).toEqual([]);
});

test('search shortcut, modifier matching, image fallback, density and 200 percent zoom', async ({
  page,
}) => {
  await page.route('**/image/Art/**', (route) => route.abort());
  await page.goto('/recipes');
  await expect(page.locator('[data-target-id]')).toHaveCount(66);
  await page.locator('main').focus();
  await page.keyboard.press('/');
  const search = page.getByLabel('Search items or modifiers', { exact: true });
  await expect(search).toBeFocused();
  await search.fill('Furious Assault');
  await expect(
    page.locator(`[data-target-id="${physical.recipe.targetSignature}"]`),
  ).toBeVisible();
  await page.getByLabel('Display density').selectOption('compact');
  await expect(page.locator('.workspace-shell')).toHaveClass(/density-compact/);
  await expect(
    page.getByRole('img', { name: /image unavailable/ }).first(),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.getByLabel('Display density')).toHaveValue('compact');
});

test('refresh failures preserve useful data; history failures remain partial and offer retry', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Failure semantics are viewport-independent.',
  );
  await page.goto('/recipes');
  await expect(page.locator('[data-target-id]')).toHaveCount(66);
  await page.route('**/api/catalog', (route) =>
    route.fulfill({
      json: envelope({
        entries,
        league: { id: 'archive-covens', name: 'Updated catalogue league' },
      }),
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.workspace-context')).toContainText(
    'Updated catalogue league',
  );
  await page.route('**/api/catalog', (route) =>
    route.fulfill({
      json: {
        ...envelope(null),
        state: 'error',
        data: null,
        errorCode: 'PERSISTENCE_NOT_FOUND',
        error: {
          category: 'persistence',
          code: 'PERSISTENCE_NOT_FOUND',
          disposition: 'permanent',
          message: 'Fixture refresh unavailable',
          retryable: false,
        },
      },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('heading', { name: 'Recipes could not be refreshed' }),
  ).toBeVisible();
  await expect(page.locator('[data-target-id]')).toHaveCount(66);
  await page.locator(`[id="route-${jaggedId}"]`).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Market' }).click();
  await expect(
    dialog
      .locator('p')
      .filter({ hasText: /38 independent observations in this window/ }),
  ).toBeVisible();
  await expect(dialog.getByText(/target coverage is incomplete/)).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Retry history' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Line', exact: true }).click();
  await dialog.getByLabel('History range', { exact: true }).selectOption('30d');
  await dialog.getByRole('tab', { name: 'Recipe' }).click();
  await dialog.getByRole('tab', { name: 'Market' }).click();
  await expect(dialog.getByLabel('History range', { exact: true })).toHaveValue(
    '30d',
  );
  await expect(
    dialog.getByRole('button', { name: 'Line', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('a hanging sibling history cannot indefinitely block the available source', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Deadline semantics are viewport-independent.',
  );
  await page.route(`**/api/trends/${chaosId}?*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await route.abort().catch(() => {});
  });
  await page.goto('/recipes');
  await page.locator(`[id="route-${jaggedId}"]`).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Market' }).click();
  await expect(
    dialog
      .locator('p')
      .filter({ hasText: /38 independent observations in this window/ }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(/target coverage is incomplete/)).toBeVisible();
});
