import { expect, test, type Page } from '@playwright/test';
import { fixtureItem } from '../../apps/web/src/mocks/scrapedItems.js';
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';

// Supplemental UI regressions; release acceptance uses the real database.
const root = '/api/settings/scraped-items';
const correlationId = '44444444-4444-4444-8444-444444444444';
const envelope = (data: unknown) => ({ correlationId, data });
const window = {
  from: '2026-11-11T12:00:00.000Z',
  to: '2026-11-18T12:00:00.000Z',
};

async function setup(page: Page) {
  const preview = createPreviewFetch();
  const items = Array.from({ length: 35 }, (_, i) => ({
    ...structuredClone(fixtureItem),
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    baseName: `Search ${String(i).padStart(2, '0')}`,
    recentListings: i === 2 ? null : { ...window, count: i === 1 ? 0 : 12 },
    query:
      i === 3
        ? {
            ...fixtureItem.query,
            status: 'blocked' as const,
            key: null,
            tradeUrl: null,
          }
        : fixtureItem.query,
  }));
  let saved: unknown;
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === `${root}/bases`)
      return route.fulfill({
        json: envelope({
          bases: [
            {
              id: fixtureItem.baseId,
              name: fixtureItem.baseName,
              itemClass: 'Jewel',
            },
            {
              id: 'base:amethyst-ring',
              name: 'Amethyst Ring',
              itemClass: 'Ring',
            },
          ],
        }),
      });
    if (path === root)
      return route.fulfill({
        json: envelope({
          collectionsPaused: true,
          generatedAt: window.to,
          items,
          league: { id: correlationId, name: 'Fixture', gggId: 'Fixture' },
          recipes: [],
        }),
      });
    if (path === `${root}/${items[0]!.id}` && request.method() === 'PUT') {
      const body = request.postDataJSON();
      saved = body;
      const item = items[0]!;
      item.spec = body.spec;
      item.baseId = body.spec.item.baseId;
      item.baseName = 'Amethyst Ring';
      item.revision++;
      item.recentListings = null;
      return route.fulfill({
        json: envelope({ item, schedule: 'synchronized' }),
      });
    }
    const response = await preview(request.url(), { method: request.method() });
    return route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
  return { items, saved: () => saved };
}

test('search controls remain fixed while results scroll and evidence badges distinguish all states', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/settings/scraped-items');
  const results = page.getByRole('region', {
    name: 'Search results',
    exact: true,
  });
  await expect(results.getByRole('button')).toHaveCount(35);
  const badges = results.locator('.scraped-evidence');
  await expect(badges.nth(0)).toHaveClass(/positive/);
  await expect(badges.nth(0)).toContainText('12 listings · 7d');
  await expect(badges.nth(1)).toHaveClass(/zero/);
  await expect(badges.nth(2)).toHaveClass(/unavailable/);
  await expect(badges.nth(3)).toHaveClass(/blocked/);
  const filter = page.getByLabel('Filter', { exact: true }),
    kind = page.getByRole('combobox', { name: 'Kind', exact: true });
  const before = [await filter.boundingBox(), await kind.boundingBox()];
  await results.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await results.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect([await filter.boundingBox(), await kind.boundingBox()]).toEqual(
    before,
  );
  await expect(results.getByRole('button').last()).toBeInViewport();
});

test('exact base and category edits are submitted, reloaded and visibly identified', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(`/settings/scraped-items?item=${state.items[0]!.id}`);
  const base = page.getByRole('combobox', { name: 'Base name', exact: true });
  await expect(base).toBeEnabled();
  await page
    .getByRole('searchbox', { name: 'Find a base', exact: true })
    .fill('Ring');
  await base.selectOption('base:amethyst-ring');
  await page
    .getByRole('button', { name: 'Save requirements', exact: true })
    .click();
  await expect.poll(state.saved).toMatchObject({
    spec: {
      item: { baseId: 'base:amethyst-ring', variant: { kind: 'none' } },
    },
  });
  await page.reload();
  await expect(base).toHaveValue('base:amethyst-ring');
  await expect(
    page.getByRole('heading', { name: 'Amethyst Ring', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.scraped-list__item[aria-current="true"] .scraped-evidence'),
  ).toContainText('Not checked · 7d');
  await page
    .getByRole('combobox', { name: 'Search by', exact: true })
    .selectOption('accessory.ring');
  await expect(base).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save requirements', exact: true })
    .click();
  await expect
    .poll(state.saved)
    .toMatchObject({ spec: { marketSearchCategory: 'accessory.ring' } });
  await expect(
    page.getByRole('heading', { name: 'All rings', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test('base catalogue failure can be retried without losing the current requirements', async ({
  page,
}) => {
  const state = await setup(page);
  let available = false;
  await page.route('**/api/settings/scraped-items/bases?*', (route) =>
    !available ? route.fulfill({ status: 503, json: {} }) : route.fallback(),
  );
  await page.goto(`/settings/scraped-items?item=${state.items[0]!.id}`);
  const base = page.getByRole('combobox', { name: 'Base name', exact: true });
  const retry = page.getByRole('button', {
    name: 'Retry base choices',
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect(base).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Search by', exact: true })
    .selectOption('accessory.ring');
  await expect(
    page.getByRole('button', { name: 'Save requirements', exact: true }),
  ).toBeEnabled();
  available = true;
  await retry.click();
  await expect(retry).toBeHidden();
  await page
    .getByRole('combobox', { name: 'Search by', exact: true })
    .selectOption('');
  await expect(base).toBeEnabled();
  await expect(base).toHaveValue(fixtureItem.baseId);
});
