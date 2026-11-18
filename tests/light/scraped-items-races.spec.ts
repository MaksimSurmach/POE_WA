import { expect, test, type Page, type Route } from '@playwright/test';
import type { ScrapedItem } from '../../packages/contracts/src/index.js';
import {
  fixtureCapture,
  fixtureItem,
} from '../../apps/web/src/mocks/scrapedItems.js';
import { createPreviewFetch } from '../../apps/web/src/preview/previewApi.js';

// Supplemental race regressions only. Final market verification uses real database/provider data.
const path = '/api/settings/scraped-items';
const requestId = '44444444-4444-4444-8444-444444444444';
const envelope = (data: unknown) => ({ correlationId: requestId, data });
const library = (item: ScrapedItem) => ({
  collectionsPaused: false,
  generatedAt: '2026-11-18T10:00:00.000Z',
  items: [item],
  league: { id: requestId, gggId: 'Fixture', name: 'Fixture' },
  recipes: [{ id: 'recipe-a', title: 'Recipe A', base: null, output: item.id }],
});
const completed = (item: ScrapedItem) => ({
  capture: fixtureCapture,
  currentRevision: item.revision,
  currentScheduleKey: item.query.key,
  finishedAt: fixtureCapture.capturedAt,
  itemId: item.id,
  itemRevision: fixtureItem.revision,
  reason: null,
  requestId,
  requestedAt: fixtureCapture.capturedAt,
  scheduleKey: fixtureItem.query.key,
  stale: item.revision !== fixtureItem.revision,
  startedAt: fixtureCapture.capturedAt,
  state: 'succeeded',
});
const queued = envelope({
  itemId: fixtureItem.id,
  itemRevision: fixtureItem.revision,
  requestId,
  scheduleKey: fixtureItem.query.key,
});
const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });

async function intercept(page: Page, handle: (route: Route) => Promise<void>) {
  const preview = createPreviewFetch();
  await page.route('**/api/**', async (route) => {
    const response = await preview(route.request().url(), {
      method: route.request().method(),
    });
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
  await page.route('**/api/settings/scraped-items**', handle);
}
async function open(page: Page) {
  await page.goto(`/settings/scraped-items?item=${fixtureItem.id}`);
  await expect(page.getByLabel(/^Item level/)).toHaveValue('83');
}
function nextRevision() {
  const item = structuredClone(fixtureItem);
  item.revision++;
  item.spec.item.itemLevel = 90;
  item.query.key = 'changed-query';
  item.latestCapture = null;
  return item;
}

test('transient status failure retains the durable request and instant completion refreshes the library', async ({
  page,
}) => {
  let reads = 0,
    starts = 0,
    lists = 0;
  await intercept(page, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      starts++;
      await json(route, queued, 202);
    } else if (new URL(request.url()).pathname === path) {
      lists++;
      await json(route, envelope(library(fixtureItem)));
    } else if (++reads === 1) await json(route, {}, 503);
    else await json(route, envelope(completed(fixtureItem)));
  });
  await open(page);
  const initialLists = lists;
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.locator('.scraped-result')).toHaveAttribute(
    'data-state',
    'succeeded',
  );
  await expect.poll(() => lists).toBe(initialLists + 1);
  expect(starts).toBe(1);
  expect(reads).toBe(2);
  expect(
    await page.evaluate(
      (id) => sessionStorage.getItem(`worksmith:scraped-test:${id}`),
      fixtureItem.id,
    ),
  ).toBe(requestId);
});

test('saving a new query hides loaded diagnostics and ignores a late old capture response', async ({
  page,
}) => {
  let item = structuredClone(fixtureItem),
    checks = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(
    ({ id, requestId }) =>
      sessionStorage.setItem(`worksmith:scraped-test:${id}`, requestId),
    { id: fixtureItem.id, requestId },
  );
  await intercept(page, async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    if (request.method() === 'PUT') {
      item = nextRevision();
      await json(route, envelope({ item, schedule: 'synchronized' }));
    } else if (pathname === path) await json(route, envelope(library(item)));
    else if (pathname.endsWith('/capture')) {
      if (++checks === 2) await held;
      await json(route, envelope(fixtureCapture));
    } else await json(route, envelope(completed(item)));
  });
  await open(page);
  const latest = page.locator('.scraped-latest');
  await page.getByRole('button', { name: 'Check latest capture' }).click();
  await expect(latest.locator('.scraped-report')).toBeVisible();
  await page.getByRole('button', { name: 'Check latest capture' }).click();
  await expect.poll(() => checks).toBe(2);
  await page.getByLabel(/^Item level/).fill('90');
  await page.getByRole('button', { name: 'Save requirements' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved.' }),
  ).toBeVisible();
  const response = page.waitForResponse((r) => r.url().endsWith('/capture'));
  release();
  await response;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(latest.locator('.scraped-report')).toHaveCount(0);
  await expect(latest).toContainText(
    'No capture exists for this exact search yet.',
  );
  await expect(
    page.getByRole('note').filter({ hasText: 'previous search configuration' }),
  ).toBeVisible();
});

test('a late library refresh cannot roll a successful save back to an older revision', async ({
  page,
}) => {
  let item = structuredClone(fixtureItem);
  let holdNextList = false;
  let holdingList = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await intercept(page, async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    if (request.method() === 'PUT') {
      item = nextRevision();
      await json(route, envelope({ item, schedule: 'synchronized' }));
    } else if (request.method() === 'POST') await json(route, queued, 202);
    else if (pathname === path) {
      const snapshot = library(structuredClone(item));
      if (holdNextList) {
        holdNextList = false;
        holdingList = true;
        await held;
      }
      await json(route, envelope(snapshot));
    } else await json(route, envelope(completed(item)));
  });
  await open(page);
  holdNextList = true;
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect.poll(() => holdingList).toBe(true);
  await page.getByLabel(/^Item level/).fill('90');
  await page.getByRole('button', { name: 'Save requirements' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved.' }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path,
  );
  release();
  await response;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByLabel(/^Item level/)).toHaveValue('90');
  await expect(page.locator('.scraped-detail__header')).toContainText(
    'revision 4',
  );
});
