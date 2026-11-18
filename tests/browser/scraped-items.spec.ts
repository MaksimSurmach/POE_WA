import { expect, test } from '@playwright/test';

test.skip(
  (process.env.PIPELINE ?? 'collector') !== 'collector',
  'Requires the collector browser fixture',
);

test('settings-scraped-items-edit-and-test', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Scraped items' }).click();
  await expect(
    page.getByRole('heading', { name: 'Scraped items', level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', {
        name: 'Scraped items',
      }),
  ).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Kind').selectOption('output');
  await page.locator('.scraped-list__item').first().click();
  await expect(page).toHaveURL(/item=/);
  const openTrade = page.getByRole('link', { name: /Open Trade search/ });
  await expect(openTrade).toHaveAttribute(
    'href',
    /pathofexile\.com\/trade\/search\//,
  );
  await expect(openTrade).toHaveAttribute('rel', /noopener/);

  // Validation names the field and saves nothing.
  const level = page.getByLabel(/^Item level/);
  const equivalents = page.getByRole('checkbox', {
    name: 'Compare finished market equivalents',
  });
  await expect(equivalents).toBeChecked();
  await expect(level).toBeDisabled();
  await equivalents.uncheck();
  await expect(level).toBeEnabled();
  const current = Number(await level.inputValue());
  await level.fill('101');
  await page.getByRole('button', { name: 'Save requirements' }).click();
  await expect(page.getByRole('alert').first()).toContainText('1 to 100');

  // A valid edit is saved as a new revision and applied to the schedule.
  await level.fill(String(current === 90 ? 89 : 90));
  await page.getByRole('button', { name: 'Save requirements' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved.' }),
  ).toBeVisible();
  await expect(page.getByText(/edited by you/)).toBeVisible();
  await page.reload();
  await expect(equivalents).not.toBeChecked();
  await expect(level).toHaveValue(String(current === 90 ? 89 : 90));

  // The test is this item's own request, tied to the saved revision.
  await page.getByRole('button', { name: 'Run test' }).click();
  const result = page.locator('.scraped-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Request');
  await expect(result).toContainText(/Succeeded|Blocked|Failed/, {
    timeout: 45_000,
  });
  if ((await result.getAttribute('data-state')) === 'succeeded') {
    await expect(result).toContainText('Reported by Trade');
    await expect(result).toContainText('Listings fetched');
    await expect(result).toContainText('Comparable sellers');
  }
});

test('settings-scraped-items-mobile-has-no-horizontal-scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/scraped-items');
  await page.locator('.scraped-list__item').first().click();
  await expect(page.getByRole('button', { name: 'Run test' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
});
