import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { FactoryBatchRecord } from '@poe-worksmith/contracts';

async function currentBatch(page: Page, id: string) {
  const response = await page.request.get(`/api/admin/factory/batches/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).data as FactoryBatchRecord;
}

for (const width of [1440, 390]) {
  test(`factory keeps partial-sale accounting and retry history correct at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 980 });
    await page.goto(
      '/factory?recipe=quicksilver-mageblood-cheetah&league=Fixture%20League',
    );
    const create = page.getByRole('form', { name: 'Start production batch' });
    await create
      .getByLabel('Batch notes', { exact: true })
      .fill(`Synthetic acceptance ${width}; not real purchases or sales`);
    await create
      .getByLabel('Amount in transaction currency', { exact: true })
      .fill('100');
    await create
      .getByRole('button', { name: 'Start batch', exact: true })
      .click();
    await expect(page).toHaveURL(/batch=/);
    const id = new URL(page.url()).searchParams.get('batch')!;
    const form = page.getByRole('form', { name: 'Record factory event' });
    await expect(form).toBeVisible();

    // The server commits this purchase, but the browser loses its response.
    let dropResponse = true;
    await page.route('**/api/admin/factory/batches/*/events', async (route) => {
      if (dropResponse) {
        dropResponse = false;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    async function record(
      type: string,
      fill: (form: Locator) => Promise<void>,
      retry = false,
    ) {
      await form
        .getByRole('combobox', { name: 'Event type', exact: true })
        .selectOption(type);
      await fill(form);
      await form
        .getByLabel('Transaction or event source', { exact: true })
        .fill('Synthetic browser acceptance; no real game transaction');
      if (retry) {
        await form
          .getByRole('button', { name: 'Record event', exact: true })
          .click();
        await expect(page.getByRole('alert')).toContainText(
          'Your inputs are preserved',
        );
        const response = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/batches/${id}/events`) &&
            r.request().method() === 'POST',
        );
        await page
          .getByRole('button', {
            name: 'Retry exact pending event',
            exact: true,
          })
          .click();
        expect((await response).ok()).toBe(true);
      } else {
        const response = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/batches/${id}/events`) &&
            r.request().method() === 'POST',
        );
        await form
          .getByRole('button', { name: 'Record event', exact: true })
          .click();
        const result = await response;
        expect(result.ok(), await result.text()).toBe(true);
      }
      await expect(
        page.getByRole('status').filter({ hasText: 'Event recorded.' }),
      ).toBeVisible();
      await expect(
        form.getByRole('button', { name: 'Record event', exact: true }),
      ).toBeEnabled();
      return currentBatch(page, id);
    }
    async function purchase(
      resource: string,
      quantity: string,
      price: string,
      retry = false,
    ) {
      return record(
        'purchase',
        async (f) => {
          await f
            .getByLabel('Material or base name', { exact: true })
            .fill(resource);
          await f
            .getByLabel('Transaction quantity', { exact: true })
            .fill(quantity);
          await f
            .getByLabel('Unit price in transaction currency', { exact: true })
            .fill(price);
        },
        retry,
      );
    }
    let state = await purchase('Synthetic essence', '10', '2', true);
    expect(state.events).toHaveLength(1);
    const essencePurchase = state.events[0]!.id;
    state = await purchase('Synthetic base', '2', '10');
    const basePurchase = state.events.at(-1)!.id;
    const consume = (purchaseId: string, quantity: string) =>
      record('consume', async (f) => {
        await f
          .getByRole('combobox', { name: 'Purchase lot', exact: true })
          .selectOption(purchaseId);
        await f.getByLabel('Stock quantity', { exact: true }).fill(quantity);
      });
    state = await consume(essencePurchase, '4');
    const essenceCost = state.events.at(-1)!.id;
    state = await consume(basePurchase, '2');
    const baseCost = state.events.at(-1)!.id;
    for (const category of ['target', 'salvage']) {
      state = await record('produce', async (f) => {
        await f
          .getByLabel('Crafted item description', { exact: true })
          .fill(`Synthetic ${category} item`);
        await f
          .getByLabel('Outcome ID or classification label', { exact: true })
          .fill(`production-${category}`);
        await f
          .getByRole('combobox', { name: 'Outcome category', exact: true })
          .selectOption(category);
        if (category === 'target')
          await f
            .getByRole('checkbox', { name: /Matches this recipe/ })
            .check();
        else
          await f
            .getByRole('checkbox', { name: /Matches this recipe/ })
            .uncheck();
        if (
          (await f
            .getByRole('combobox', { name: 'Cost source', exact: true })
            .count()) < 2
        )
          await f
            .getByRole('button', { name: 'Add cost allocation', exact: true })
            .click();
        await f
          .getByRole('combobox', { name: 'Cost source', exact: true })
          .nth(0)
          .selectOption(essenceCost);
        await f
          .getByLabel('Allocated cost (chaos)', { exact: true })
          .nth(0)
          .fill('4');
        await f
          .getByRole('combobox', { name: 'Cost source', exact: true })
          .nth(1)
          .selectOption(baseCost);
        await f
          .getByLabel('Allocated cost (chaos)', { exact: true })
          .nth(1)
          .fill('10');
      });
    }
    const target = state.projection.inventory.find(
      (item) => item.outcomeClassification === 'target',
    )!;
    const salvage = state.projection.inventory.find(
      (item) => item.outcomeClassification === 'salvage',
    )!;
    expect(target.targetSignature).toBe(state.batch.targetSignature);
    expect(salvage.targetSignature).toBeNull();
    state = await record('expense', async (f) => {
      await f
        .getByRole('combobox', { name: 'Cost or credit category', exact: true })
        .selectOption('finishing');
      await f
        .getByLabel('Amount in transaction currency', { exact: true })
        .fill('2');
    });
    const finishing = state.events.at(-1)!.id;
    await record('allocate', async (f) => {
      await f
        .getByRole('combobox', { name: 'Inventory item', exact: true })
        .selectOption(target.id);
      await f
        .getByRole('combobox', { name: 'Cost source', exact: true })
        .selectOption(finishing);
      await f.getByLabel('Allocated cost (chaos)', { exact: true }).fill('2');
    });
    await record('list', async (f) => {
      await f
        .getByRole('combobox', { name: 'Inventory item', exact: true })
        .selectOption(target.id);
      await f
        .getByLabel('Amount in transaction currency', { exact: true })
        .fill('50');
    });
    const sale = () =>
      record('sale', async (f) => {
        await f
          .getByRole('combobox', { name: 'Inventory item', exact: true })
          .selectOption(target.id);
        const proceeds = f.getByRole('group', {
          name: 'Confirmed sale proceeds',
          exact: true,
        });
        await proceeds
          .getByRole('combobox', { name: 'Transaction currency', exact: true })
          .selectOption('divine');
        await proceeds
          .getByLabel('Amount in transaction currency', { exact: true })
          .fill('0.5');
        await proceeds
          .getByLabel('Chaos per divine at transaction time', { exact: true })
          .fill('100');
        await proceeds
          .getByLabel('Historical exchange-rate source', { exact: true })
          .fill('Synthetic locked rate 100; not a live quote');
        await f
          .getByLabel('Include transaction expense', { exact: true })
          .check();
        await f
          .getByRole('group', {
            name: 'Expense paid for this sale',
            exact: true,
          })
          .getByLabel('Amount in transaction currency', { exact: true })
          .fill('1');
      });
    state = await sale();
    expect(state.projection.metrics).toMatchObject({
      realizedProfit: '33',
      cashFlow: '7',
      inventoryCost: '14',
      unusedMaterialCost: '12',
      productionCost: '30',
      grossSpending: '43',
      soldCount: 1,
    });
    const originalSale = state.events.at(-1)!.id;
    state = await record('void', async (f) => {
      await f
        .getByRole('combobox', { name: 'Event to correct', exact: true })
        .selectOption(originalSale);
      await f
        .getByLabel('Correction reason', { exact: true })
        .fill('Synthetic correction acceptance; preserve original audit entry');
    });
    expect(state.projection.metrics.realizedProfit).toBe('0');
    state = await sale();
    expect(state.projection.metrics.realizedProfit).toBe('33');
    expect(state.projection.sales).toHaveLength(1);
    expect(state.projection.voidedEventIds).toContain(originalSale);
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: `Batch ${id.slice(0, 8)}`,
        exact: true,
      }),
    ).toBeVisible();
    expect((await currentBatch(page, id)).projection.metrics.cashFlow).toBe(
      '7',
    );
    const downloading = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export JSON', exact: true })
      .click();
    const download = await downloading;
    const exported = JSON.parse(
      await readFile((await download.path())!, 'utf8'),
    ) as FactoryBatchRecord;
    expect(exported.events.some((event) => event.id === originalSale)).toBe(
      true,
    );
    expect(exported.projection.sales[0]!.transaction).toMatchObject({
      currency: 'divine',
      unitPrice: '0.5',
      chaosPerUnit: '100',
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('heading', { name: `Batch ${id.slice(0, 8)}`, exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`factory-${width}.png`) });
  });
}
