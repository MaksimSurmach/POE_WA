import { expect, test } from '@playwright/test';
import { createDatabasePool } from '../../apps/server/dist/database.js';
import { loadDatabaseConfig } from '../../apps/server/dist/config.js';
import { seedIntelligenceScenario } from '../../apps/server/dist/testkit/intelligence.js';

for (const width of [1440, 390]) {
  test(`saved evidence produces a bounded plan and stale evidence holds cash at ${width}px`, async ({
    page,
  }, info) => {
    const pool = createDatabasePool(loadDatabaseConfig());
    const recipeId =
      width === 1440
        ? 'quicksilver-mageblood-cheetah'
        : 'quicksilver-alchemist-cheetah';
    const league = 'Fixture League';
    try {
      const fixture = await seedIntelligenceScenario(pool, {
        recipeId,
        league,
      });
      expect(fixture.first.signal.state).toBe('WATCH');
      expect(fixture.confirmed.signal.state).toBe('CRAFT');
      expect(fixture.confirmed.liquidity).toMatchObject({
        status: 'supported',
        sellers: 5,
        listings: 5,
        own: {
          medianSellSeconds: 86400,
          medianHoldingSeconds: 172800,
        },
      });
      expect(fixture.confirmed.liquidity.own.sampleSize).toBeGreaterThanOrEqual(
        3,
      );
      await page.setViewportSize({ width, height: 980 });
      await page.goto('/');
      const intelligence = page.getByRole('region', {
        name: 'Production signals and liquidity',
      });
      await expect(
        intelligence
          .getByRole('row')
          .filter({ has: page.locator(`a[href="/recipes/${recipeId}"]`) })
          .getByRole('cell')
          .first()
          .getByText('CRAFT', { exact: true }),
      ).toBeVisible();
      await intelligence
        .getByText('Allocate available capital', { exact: true })
        .click();
      const form = intelligence.getByRole('form', {
        name: 'Capital allocation plan',
      });
      await form.getByLabel('Available capital', { exact: true }).fill('2');
      await form
        .getByLabel('Desired cash reserve', { exact: true })
        .fill('0.5');
      await form
        .getByRole('combobox', { name: 'Capital currency', exact: true })
        .selectOption('divine');
      await form
        .getByLabel('Chaos per divine for this plan', { exact: true })
        .fill('100');
      await form
        .getByLabel('Conversion source or explicit assumption', { exact: true })
        .fill('Synthetic acceptance FX assumption, not a live quotation');
      await form
        .getByLabel('Maximum combined risk (%)', { exact: true })
        .fill('25');
      await form
        .getByLabel('Maximum exposure per recipe (%)', { exact: true })
        .fill('10');
      await form
        .getByLabel('Investment horizon (days)', { exact: true })
        .fill('7');
      await form
        .getByText('Optional recipe and category restrictions', { exact: true })
        .click();
      await form
        .locator(`input[name="recipeIds"][value="${recipeId}"]`)
        .check();
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/admin/intelligence/allocations') &&
          response.request().method() === 'POST',
      );
      await form
        .getByRole('button', { name: 'Build production plan', exact: true })
        .click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const saved = (await response.json()).data;
      const request = response.request().postDataJSON();
      const balanced = saved.plan.scenarios.find(
        (scenario: { name: string }) => scenario.name === 'balanced',
      );
      expect(saved.plan.request.capital).toMatchObject({
        currency: 'divine',
        unitPrice: '2',
        chaosPerUnit: '100',
      });
      expect(balanced).toMatchObject({
        status: 'plan',
        allocatedCapital: '10',
        reservedCapital: '190',
        expectedProfit: '190',
      });
      expect(balanced.lines).toHaveLength(1);
      expect(balanced.lines[0]).toMatchObject({
        recipeId,
        objective: { kind: 'attempts', count: 1 },
        p90Budget: '10',
        p95Budget: '10',
      });
      expect(balanced.unionRiskUpperBound).toBeLessThanOrEqual(0.25);
      const replay = await page.request.post(
        '/api/admin/intelligence/allocations',
        { data: request },
      );
      expect((await replay.json()).data.id).toBe(saved.id);
      const plan = intelligence.getByLabel('Saved production plan');
      await expect(
        plan.getByText('190 c', { exact: true }).first(),
      ).toBeVisible();
      await page.reload();
      await intelligence
        .getByText('Allocate available capital', { exact: true })
        .click();
      await expect(
        plan.getByRole('heading', { name: 'Production plan', exact: true }),
      ).toBeVisible();
      await expect(plan.getByRole('combobox', { name: 'Allocation scenario' })).toHaveValue(
        'balanced',
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await plan.scrollIntoViewIfNeeded();
      await plan.screenshot({
        path: info.outputPath(`intelligence-${width}.png`),
      });
      await page.goto(`/recipes/${recipeId}`);
      const detail = page.getByRole('region', {
        name: 'Market decision and liquidity',
      });
      await expect(detail.getByText('CRAFT', { exact: true }).first()).toBeVisible();
      await expect(
        detail.getByText('5 / 5 reported', { exact: true }),
      ).toBeVisible();
      await detail.getByText('Decision history', { exact: true }).click();
      await expect(detail.getByText(/WATCH/).first()).toBeVisible();
      await pool.query(
        "update raw_snapshots set expires_at=now()-interval '1 second' where dedupe_key=any($1::text[])",
        [fixture.snapshotIds],
      );
      const current = await page.request.get(
        `/api/admin/intelligence/recipes/${recipeId}?league=${encodeURIComponent(league)}`,
      );
      expect((await current.json()).data.signal.state).toBe(
        'INSUFFICIENT_DATA',
      );
      const held = await page.request.post(
        '/api/admin/intelligence/allocations',
        { data: { ...request, idempotencyKey: crypto.randomUUID() } },
      );
      const hold = (await held.json()).data;
      expect(
        hold.plan.scenarios.every(
          (scenario: { status: string; allocatedCapital: string }) =>
            scenario.status === 'hold' && scenario.allocatedCapital === '0',
        ),
      ).toBe(true);
      expect(
        hold.plan.scenarios[1].watchlist.some(
          (entry: { recipeId: string }) => entry.recipeId === recipeId,
        ),
      ).toBe(true);
      const historical = await page.request.get(
        `/api/admin/intelligence/allocations/${saved.id}`,
      );
      expect((await historical.json()).data).toEqual(saved);
      await info.attach('synthetic-production-plan.json', {
        body: JSON.stringify(
          {
            dataKind:
              'labelled synthetic acceptance; not live quotes or real trades',
            saved,
            hold,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await pool.end();
    }
  });
}
