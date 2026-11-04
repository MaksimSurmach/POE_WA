import { expect, test, type Page } from '@playwright/test';

async function enterSyntheticModel(page: Page, recipeId: string) {
  await page.goto(`/recipes/${recipeId}`);
  const risk = page.getByRole('region', { name: 'Expected value & risk' });
  await expect(risk.getByText('EV unavailable', { exact: true })).toBeVisible();
  await risk
    .getByText('Define outcome probabilities and values', { exact: true })
    .click();
  await risk.getByLabel('One base', { exact: true }).fill('10');
  await risk.getByLabel('Materials per attempt', { exact: true }).fill('2');
  await risk
    .getByLabel('Cost source', { exact: true })
    .fill('Synthetic acceptance fixture; not actual purchases');
  await risk
    .getByLabel('Assumptions and outcome boundaries')
    .fill(
      'Synthetic disjoint coin flip: target or salvage. No observed game probabilities or transactions.',
    );
  for (const [index, classification, resale] of [
    [1, 'target', '100'],
    [2, 'salvage', '10'],
  ] as const) {
    const outcome = risk.getByRole('group', {
      name: `Outcome ${index}`,
      exact: true,
    });
    await outcome
      .getByLabel('Name / modifier requirements')
      .fill(`Synthetic ${classification}`);
    await outcome
      .getByRole('combobox', { name: 'Classification', exact: true })
      .selectOption(classification);
    await outcome
      .getByLabel('Probability (0–1)', { exact: true })
      .fill(index === 1 ? '0.5' : '0.4');
    await outcome
      .getByLabel('Probability source', { exact: true })
      .fill('Synthetic fair coin; explicitly assumed for acceptance only');
    await outcome.getByLabel('Finishing cost for this outcome').fill('0');
    await outcome.getByLabel('Recovery expense for this outcome').fill('0');
    if (index === 1)
      await outcome.getByLabel("Meets this recipe's exact target").check();
    await outcome.getByLabel('Sellable', { exact: true }).check();
    await outcome.getByLabel('Resale range: minimum').fill(resale);
    await outcome.getByLabel('Resale range: maximum').fill(resale);
    await outcome
      .getByLabel('Resale source', { exact: true })
      .fill('Synthetic valuation assumption; no completed sale');
  }
  await risk.getByLabel(/These outcomes do not overlap/).check();
  await risk.getByRole('button', { name: 'Save new model revision' }).click();
  await expect(risk.getByRole('alert')).toContainText(/sum|probabilit/i);
  const before = await page.request.get(`/api/recipes/${recipeId}/analysis`);
  expect((await before.json()).data.modelRecord).toBeNull();
  await risk
    .getByRole('group', { name: 'Outcome 2', exact: true })
    .getByLabel('Probability (0–1)', { exact: true })
    .fill('0.5');
  await risk.getByRole('button', { name: 'Save new model revision' }).click();
  await expect(risk.getByText(/Model revision 1 saved/)).toBeVisible();
  const response = await page.request.get(`/api/recipes/${recipeId}/analysis`);
  expect(response.ok()).toBe(true);
  const saved = (await response.json()).data;
  expect(saved.analysis).toMatchObject({
    status: 'complete',
    basis: 'assumptions',
    expectedTotalCost: '12',
    expectedNetProfit: { min: '43', max: '43' },
    expectedSalvageRecovery: { min: '5', max: '5' },
  });
  await risk
    .getByText('Create a replacement model revision', { exact: true })
    .click();
  return risk;
}

for (const width of [1440, 390]) {
  test(`owner saves an explicit model, simulates and reloads durable results at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 980 });
    const risk = await enterSyntheticModel(
      page,
      width === 1440
        ? 'quicksilver-mageblood-cheetah'
        : 'quicksilver-alchemist-cheetah',
    );
    await risk
      .getByRole('combobox', { name: 'Objective', exact: true })
      .selectOption('attempts');
    await risk.getByLabel('Method runs', { exact: true }).fill('1');
    await risk.getByLabel(/Available budget/).fill('20');
    await risk
      .getByLabel('Seed', { exact: true })
      .fill('synthetic-acceptance-v1');
    await risk.getByRole('button', { name: 'Simulate objective' }).click();
    await expect(
      risk.getByText('Simulation completed', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(risk.getByText('P90 budget', { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByText('Simulation completed', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('heading', { name: 'Expected value & risk' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`economics-${width}.png`),
      fullPage: true,
    });
  });
}

test('owner cancels an expensive conditional simulation without publishing partial risk', async ({
  page,
}) => {
  const recipeId = 'quicksilver-mageblood-cheetah';
  const contextResponse = await page.request.get(
    `/api/recipes/${recipeId}/analysis`,
  );
  const context = (await contextResponse.json()).data;
  const provenance = {
    kind: 'assumption',
    reference: 'Synthetic cancellation fixture',
    recordedAt: new Date().toISOString(),
    notes: 'Deliberately rare synthetic transition; not game data.',
  };
  const matching = {
    kind: 'manual',
    description: 'Synthetic completed result',
  };
  const outcome = {
    name: 'Synthetic transition',
    targetSuccess: false,
    sellable: false,
    matching,
    costs: [],
    credits: [],
    unknowns: [],
  };
  const saved = await page.request.post('/api/admin/craft-analysis/models', {
    data: {
      recipeId,
      recipeHash: context.recipeHash,
      league: context.league,
      expectedRevision: context.modelRecord?.revision ?? null,
      idempotencyKey: crypto.randomUUID(),
      currency: 'chaos',
      model: {
        version: 1,
        id: 'synthetic-cancel',
        startStageId: 'roll',
        initialCosts: [],
        unknowns: [],
        stages: [
          {
            id: 'roll',
            name: 'Synthetic rare roll',
            costs: [
              {
                kind: 'material',
                resourceId: 'synthetic-currency',
                quantity: '1',
                provenance,
              },
            ],
            exclusivity: { mode: 'disjoint', provenance },
            outcomes: [
              {
                ...outcome,
                id: 'advance',
                classification: 'imperfect',
                probability: { value: '0.0001', provenance },
                nextStageId: 'finish',
              },
              {
                ...outcome,
                id: 'retry',
                classification: 'recovery',
                probability: { value: '0.9999', provenance },
                nextStageId: 'roll',
              },
            ],
          },
          {
            id: 'finish',
            name: 'Synthetic finish',
            costs: [],
            exclusivity: { mode: 'disjoint', provenance },
            outcomes: [
              {
                ...outcome,
                id: 'target',
                classification: 'target',
                probability: { value: '1', provenance },
                nextStageId: null,
                sellable: true,
                targetSuccess: true,
              },
            ],
          },
        ],
      },
      prices: {
        'synthetic-currency': { amount: '1', currency: 'chaos', provenance },
      },
      valuations: {
        target: {
          min: '100',
          max: '100',
          currency: 'chaos',
          matching,
          provenance,
        },
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(`/recipes/${recipeId}`);
  const risk = page.getByRole('region', { name: 'Expected value & risk' });
  await expect(
    risk.getByRole('button', { name: 'Simulate objective' }),
  ).toBeEnabled();
  await risk.getByLabel(/Available budget/).fill('100');
  await risk
    .getByRole('combobox', { name: 'Simulation trials', exact: true })
    .selectOption('10000');
  await risk.getByLabel('Maximum stage steps per trial').fill('100000');
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/craft-analysis/simulations') &&
      response.request().method() === 'POST',
  );
  await risk.getByRole('button', { name: 'Simulate objective' }).click();
  const runId = (await (await created).json()).data.id;
  await risk
    .getByRole('button', { name: 'Cancel simulation', exact: true })
    .click();
  await expect(
    risk.getByText('Simulation cancelled', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const cancelled = await page.request.get(
    `/api/admin/craft-analysis/simulations/${runId}`,
  );
  expect((await cancelled.json()).data).toMatchObject({
    status: 'cancelled',
    result: null,
  });
});
