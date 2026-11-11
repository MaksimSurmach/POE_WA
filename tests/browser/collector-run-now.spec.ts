import { expect, test } from '@playwright/test';

test.skip(
  (process.env.PIPELINE ?? 'collector') !== 'collector',
  'Requires the collector browser fixture',
);

test('run-now-updates-homepage', async ({ page }) => {
  const recipe = '/recipes/physical-large-cluster-chaos';
  // Private reverse-proxy requests need no application credential.
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
  await expect(page.getByLabel('Operator token')).toHaveCount(0);
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

test('catalog header labels stay inside their cells at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 840 });
  await page.goto('/');
  const headers = page.locator('.craft-table thead th:visible');
  await expect(headers.first()).toBeVisible();
  const overflowing = await headers.evaluateAll(
    (cells) =>
      cells.filter((cell) => {
        const button = cell.querySelector('button')!;
        return button.scrollWidth > button.clientWidth;
      }).length,
  );
  expect(overflowing).toBe(0);
});

test('visible collection controls pause, recover from conflict and resume', async ({
  page,
}) => {
  const settingsUrl = '/api/admin/market/settings';
  const read = async () =>
    (await (await page.request.get(settingsUrl)).json()).data;
  const before = await read();
  try {
    if (before.configured.collectionsPaused) {
      await page.request.post('/api/admin/market/resume', {
        data: { version: before.version },
      });
    }
    await page.goto('/');
    const controls = page.getByRole('group', {
      name: 'Collector controls',
      exact: true,
    });
    await controls
      .getByRole('button', { name: 'Pause collection', exact: true })
      .click();
    await expect(
      controls.getByText('Collection paused', { exact: true }),
    ).toBeVisible();
    await expect(
      controls.getByRole('button', { name: 'Run now', exact: true }),
    ).toBeDisabled();
    expect((await read()).configured.collectionsPaused).toBe(true);
    await page.reload();
    await expect(
      controls.getByRole('button', { name: 'Resume collection', exact: true }),
    ).toBeVisible();
    let rejected = false;
    await page.route('**/api/admin/market/resume', async (route) => {
      if (!rejected) {
        rejected = true;
        await route.fulfill({ status: 409, json: {} });
      } else await route.continue();
    });
    await controls
      .getByRole('button', { name: 'Resume collection', exact: true })
      .click();
    await expect(
      controls.getByText(/Could not resume collection/),
    ).toBeVisible();
    await expect(
      controls.getByRole('button', { name: 'Run now', exact: true }),
    ).toBeDisabled();
    expect((await read()).configured.collectionsPaused).toBe(true);
    await controls
      .getByRole('button', { name: 'Resume collection', exact: true })
      .click();
    await expect(
      controls.getByText('Collection active', { exact: true }),
    ).toBeVisible();
    expect((await read()).configured.collectionsPaused).toBe(false);
  } finally {
    const current = await read();
    if (
      current.configured.collectionsPaused !==
      before.configured.collectionsPaused
    ) {
      await page.request.post(
        `/api/admin/market/${before.configured.collectionsPaused ? 'pause' : 'resume'}`,
        { data: { version: current.version } },
      );
    }
  }
});

test('quote-age edits keep the draft and require review before overwriting another tab', async ({
  page,
}) => {
  const url = '/api/admin/market/settings';
  const read = async () => (await (await page.request.get(url)).json()).data;
  const before = await read();
  const oldMinutes = before.configured.freshnessWarningMs / 60_000;
  const draft = oldMinutes === 1 ? 2 : 1;
  const remote = oldMinutes === 3 ? 4 : 3;
  const remoteMaximum =
    before.configured.maximumQuoteAgeMs === 7_200_000 ? 3_600_000 : 7_200_000;
  try {
    await page.goto('/');
    await page.getByRole('heading', { name: 'Settings', exact: true }).click();
    const input = page.getByLabel('Warning age (minutes)', { exact: true });
    await input.fill(String(draft));
    const current = await read();
    expect(
      (
        await page.request.patch(url, {
          data: {
            version: current.version,
            settings: {
              freshnessWarningMs: remote * 60_000,
              maximumQuoteAgeMs: remoteMaximum,
            },
          },
        })
      ).ok(),
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Save settings', exact: true })
      .click();
    await expect(page.getByText(/Quote ages changed elsewhere/)).toBeVisible();
    await expect(input).toHaveValue(String(draft));
    await expect(
      page.getByLabel('Maximum quote age (minutes)', { exact: true }),
    ).toHaveValue(String(remoteMaximum / 60_000));
    expect((await read()).configured.freshnessWarningMs).toBe(remote * 60_000);
    await page
      .getByRole('button', { name: 'Save settings', exact: true })
      .click();
    await expect(
      page.getByText('Settings saved.', { exact: true }),
    ).toBeVisible();
    expect((await read()).configured.freshnessWarningMs).toBe(draft * 60_000);
    expect((await read()).configured.maximumQuoteAgeMs).toBe(remoteMaximum);
  } finally {
    const current = await read();
    await page.request.patch(url, {
      data: {
        version: current.version,
        settings: {
          freshnessWarningMs: before.configured.freshnessWarningMs,
          maximumQuoteAgeMs: before.configured.maximumQuoteAgeMs,
        },
      },
    });
  }
});
