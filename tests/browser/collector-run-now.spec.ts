import { expect, test } from '@playwright/test';

test.skip(
  process.env.PIPELINE !== 'collector',
  'Requires the collector browser fixture',
);

test('run-now-updates-homepage', async ({ page }) => {
  const recipe = '/recipes/physical-large-cluster-chaos';
  // A forwarded request exercises the real remote authorization guard.
  await page.route(/\/api\/(collector\/status|run)$/, (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-forwarded-for': '192.0.2.1' },
    }),
  );
  let leagueName = '';
  await page.route('**/api/leagues/current', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (leagueName) json.data.name = leagueName;
    await route.fulfill({ response, json });
  });
  await page.goto('/');
  await expect(page.getByLabel('Operator token')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh Prices' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Production signals and liquidity' }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.get(
        '/api/admin/intelligence/opportunities?league=Allflame',
      )
    ).status(),
  ).toBe(404);
  await page.getByLabel('Operator token').fill('wrong-fixture-token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(
    page.getByText('The operator token was rejected.'),
  ).toBeVisible();
  await page
    .getByLabel('Operator token')
    .fill(process.env.OPERATOR_DIAGNOSTICS_TOKEN!);
  await page.getByRole('button', { name: 'Connect' }).click();
  const lastRun = page.getByLabel('Last run');
  await expect(lastRun).toHaveAttribute('datetime', /T/);
  const before = (await lastRun.getAttribute('datetime'))!;
  const cost = page
    .getByRole('row')
    .filter({
      has: page.locator(`a[href="${recipe}"]`),
    })
    .getByRole('cell')
    .nth(1);
  await expect(cost).toContainText('11,519 c');
  leagueName = 'Next Fixture League';
  const clickedAt = Date.now();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect
    .poll(async () => Date.parse((await lastRun.getAttribute('datetime'))!), {
      timeout: 12_000,
    })
    .toBeGreaterThan(Date.parse(before));
  await expect(cost).toContainText('11,536 c');
  await expect(page.getByText(/Next Fixture League/)).toBeVisible();
  const detail = await page.request.get(`/api${recipe}`);
  expect(detail.ok()).toBe(true);
  const { data } = await detail.json();
  expect(data.evaluation.expectedCraftCost).toEqual({
    amount: 11536,
    currency: 'chaos',
  });
  expect(Date.parse(data.evaluation.evaluatedAt)).toBeGreaterThan(clickedAt);
  expect(data.snapshot).toBeNull();
  await page.reload();
  await expect(page.getByLabel('Operator token')).toHaveValue('');
});

test('shows a persistent Trade block after a successful maintenance run', async ({
  page,
}) => {
  await page.route('**/api/collector/status', (route) =>
    route.fulfill({
      json: {
        collectorState: {
          lastRunFinishedAt: new Date().toISOString(),
          lastRunStatus: 'succeeded',
          blockedReason: 'PROVIDER_AUTH_FAILED',
        },
        latestRequest: null,
        lockHeld: true,
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByText(/Trade access blocked/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
});

test('Run now becomes available again when its request stalls', async ({
  page,
}) => {
  await page.route('**/api/run', () => {});
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Run now' });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.getByText(/Could not confirm the run/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(button).toBeEnabled();
});

test('persists quote age changed from the homepage', async ({ page }) => {
  const url = '/api/admin/market/settings';
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  const before = (await response.json()).data;
  const field = 'Warning age (minutes)';
  const oldMinutes = before.configured.freshnessWarningMs / 60_000;
  const nextMinutes = oldMinutes === 5 ? 6 : 5;

  try {
    await page.goto('/');
    await page.getByRole('heading', { name: 'Settings' }).click();
    await page.getByLabel(field).fill(String(nextMinutes));
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.reload();
    await page.getByRole('heading', { name: 'Settings' }).click();
    await expect(page.getByLabel(field)).toHaveValue(String(nextMinutes));
  } finally {
    const current = (await (await page.request.get(url)).json()).data;
    if (current.version !== before.version) {
      const restored = await page.request.patch(url, {
        data: {
          version: current.version,
          settings: {
            freshnessWarningMs: before.configured.freshnessWarningMs,
          },
        },
      });
      expect(restored.ok()).toBe(true);
    }
  }
});
