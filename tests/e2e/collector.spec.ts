import { expect, test, waitForCollector } from './fixtures';

const recipe = 'physical-large-cluster-chaos';

test('COLLECTOR-01 Run now publishes capture readiness in the packaged app', async ({
  page,
}) => {
  await waitForCollector(page.request);

  const catalogue = (await (await page.request.get('/api/catalog')).json())
    .data;
  const entry = catalogue.entries.find(
    (e: { recipe: { id: string } }) => e.recipe.id === recipe,
  );
  expect(entry.readiness.level).toBe('insufficient');
  await page.goto('/?family=chaos');
  await expect(page.getByLabel('Operator token')).toHaveCount(0);
  const row = page.locator(
    `[data-market-target="${entry.recipe.targetSignature}"]`,
  );
  const cost = row.getByRole('cell').nth(6);
  await expect(cost).toContainText('Not estimated');
  await page.goto('/settings');
  await expect(page.getByText('Collector connected')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить сбор' }).click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/collector/status');
        return (await response.json()).latestRequest?.state;
      },
      { timeout: 40_000 },
    )
    .toBe('done');

  await page.getByText('Диагностика коллектора', { exact: true }).click();
  await expect(page.getByText(/leader · last contact/)).toBeVisible();
  const lastHour = page.getByRole('region', { name: 'Last 1h' });
  await expect(lastHour).toContainText(/successful \([1-9]\d* complete/);

  await page.goto('/?family=chaos');
  await expect(cost).toContainText('11,519 c');
  await row.locator('.market-item-button').click();
  const evidence = page
    .getByRole('dialog')
    .getByRole('region', { name: 'Current asking evidence' });
  await expect(
    evidence
      .getByText('Sample sellers', { exact: true })
      .locator('xpath=following-sibling::dd'),
  ).toHaveText('1');
  await expect(evidence).toContainText('Capture coverage: complete');
  await page.goto(`/recipes/${recipe}`);
  await page.getByText('Готовность данных', { exact: true }).click();
  await expect(
    page.locator(
      '[data-market-readiness][data-readiness-level="price-observed"]',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Гипотеза цены одного продавца').first(),
  ).toBeVisible();
});

test('COLLECTOR-02 disclosure fits a phone and identifies the recorded worker', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await page.getByText('Диагностика коллектора', { exact: true }).click();
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
  await page.getByText('Диагностика коллектора', { exact: true }).click();
  await expect(page.getByText(/stale telemetry/)).toBeVisible();
  await expect(page.getByText(/Cooling down.*HTTP 429.*until/)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
