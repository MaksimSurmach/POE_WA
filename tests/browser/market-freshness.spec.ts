import { expect, test } from '@playwright/test';

// ponytail: not yet verified against the collector browser fixture, so it
// stays on the legacy fixture it has always run on.
test.skip(
  process.env.PIPELINE !== 'legacy',
  'Requires the legacy browser fixture',
);

test('public schedule follows settings changed by another client', async ({
  page,
}) => {
  const admin = '/api/admin/market';
  const settings = async () =>
    (await (await page.request.get(`${admin}/settings`)).json()).data;
  const before = await settings();
  async function patch(changes: Record<string, unknown>) {
    const response = await page.request.patch(`${admin}/settings`, {
      data: { version: (await settings()).version, settings: changes },
    });
    expect(response.ok()).toBe(true);
  }

  try {
    await patch({ refreshCron: '0 */4 * * *' });
    await page.goto('/admin/market');
    await expect(
      page.getByRole('heading', { name: 'Page not found' }),
    ).toBeVisible();
    await patch({ collectionsPaused: true, refreshCron: '15 */4 * * *' });
    const refresh = await page.request.get('/api/refresh');
    expect((await refresh.json()).data.schedule).toMatchObject({
      cron: '15 */4 * * *',
      nextScheduledAt: null,
    });
    await patch({ collectionsPaused: false });
    const resumed = await page.request.get('/api/refresh');
    expect((await resumed.json()).data.schedule.nextScheduledAt).toMatch(
      /T\d{2}:15:00\.000Z$/,
    );
  } finally {
    await patch({
      collectionsPaused: before.configured.collectionsPaused,
      refreshCron: before.configured.refreshCron,
    });
  }
});

test('an open recipe revalidates when its window regains focus', async ({
  page,
}) => {
  const id = 'physical-large-cluster-alteration';
  let title = 'Initial recipe view';
  let unavailable = false;
  await page.route(`**/api/recipes/${id}`, async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, json: {} });
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    json.data.recipe.title = title;
    await route.fulfill({ response, json });
  });
  await page.goto(`/recipes/${id}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page
    .getByText('Advanced: expected value and risk calculator', { exact: true })
    .click();
  const risk = page.getByRole('region', { name: 'Expected value & risk' });
  await risk
    .getByText('Define outcome probabilities and values', { exact: true })
    .click();
  const base = risk.getByLabel('One base', { exact: true });
  await base.fill('10');

  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/Price update unavailable/)).toBeVisible();
  await expect(base).toHaveValue('10');

  unavailable = false;
  title = 'Revalidated recipe view';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(base).toHaveValue('10');
});
