import { expect, test, waitForCollector } from './fixtures';

const recipe = 'physical-large-cluster-chaos';

test('COLLECTOR-01 Run now publishes capture readiness in the packaged app', async ({
  page,
}) => {
  await waitForCollector(page.request);

  await page.goto('/');
  await expect(page.getByLabel('Operator token')).toHaveCount(0);
  await expect(page.getByText('Collector connected')).toBeVisible();
  const row = page.getByRole('row').filter({
    has: page.locator(`a[href="/recipes/${recipe}"]`),
  });
  await expect(row).toHaveAttribute('data-readiness-level', 'insufficient');
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(row).toHaveAttribute('data-readiness-level', 'price-observed', {
    timeout: 40_000,
  });
  await expect(row.getByRole('cell').nth(1)).toContainText('11,519 c');

  await page.getByText('Collector details', { exact: true }).click();
  await expect(page.getByText(/leader · last contact/)).toBeVisible();
  const lastHour = page.getByRole('region', { name: 'Last 1h' });
  await expect(lastHour).toContainText(/successful \([1-9]\d* complete/);

  await row.locator(`a[href="/recipes/${recipe}"]`).click();
  await expect(
    page.locator(
      '[data-market-readiness][data-readiness-level="price-observed"]',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Single-seller price hypothesis').first(),
  ).toBeVisible();
});

test('COLLECTOR-02 disclosure fits a phone and identifies the recorded worker', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByText('Collector details', { exact: true }).click();
  await expect(page.getByText(/leader · last contact/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Last 24 hours' }),
  ).toBeVisible();
  // Replay a stale, restricted worker snapshot without sending provider traffic.
  await page.route('**/api/diagnostics/rate-limits', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.collector.stale = true;
    json.data.collector.current = {
      operation: 'cooldown',
      target: recipe,
      startedAt: new Date().toISOString(),
      taskStartedAt: null,
      reason: 'PROVIDER_RATE_LIMITED',
      until: new Date(Date.now() + 60_000).toISOString(),
    };
    await route.fulfill({ response, json });
  });
  await page.reload();
  await page.getByText('Collector details', { exact: true }).click();
  await expect(page.getByText(/stale telemetry/)).toBeVisible();
  await expect(page.getByText(/Cooling down.*HTTP 429.*until/)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
