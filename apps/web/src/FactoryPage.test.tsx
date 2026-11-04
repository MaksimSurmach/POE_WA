import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  factoryBatchSchema,
  projectFactoryBatch,
  factoryEventSchema,
  type FactoryEvent,
} from '@poe-worksmith/domain';
import { factoryAppendEventInputSchema } from '@poe-worksmith/contracts';
import { AllocationFields, FactoryEventForm } from './FactoryEventForm.js';
import { FactoryBatchSummary, FactoryMetrics } from './FactorySummary.js';
import { TransactionFields } from './FactoryFields.js';
import {
  buildFactoryEvent,
  factoryCostLabel,
  factoryFormFingerprint,
  prepareFactoryRequest,
} from './factoryForm.js';
import { App } from './App.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const started = '2026-11-04T12:00:15.123Z';
const now = '2026-11-04T12:01:00.000Z';
const batch = factoryBatchSchema.parse({
  id: id(1),
  recipeId: 'synthetic-recipe',
  recipeHash: 'revision-1',
  targetSignature: 'synthetic-exact-target',
  leagueId: id(2),
  league: 'Synthetic League',
  accountingCurrency: 'chaos',
  startedAt: started,
  plannedBudget: {
    quantity: '1',
    unitPrice: '100',
    currency: 'chaos',
    chaosPerUnit: '1',
    rateSource: 'Synthetic budget',
  },
  notes: '',
  forecast: null,
});
function form(values: Record<string, string | string[]>) {
  const result = new FormData();
  Object.entries({
    source: 'Labelled synthetic transaction',
    notes: '',
    ...values,
  }).forEach(([key, value]) =>
    (Array.isArray(value) ? value : [value]).forEach((entry) =>
      result.append(key, entry),
    ),
  );
  return result;
}
const transaction = {
  quantity: '2',
  unitPrice: '1',
  currency: 'divine',
  chaosPerUnit: '100',
  rateSource: 'Synthetic historical FX',
};
function event(n: number, values: Record<string, string | string[]>) {
  return buildFactoryEvent(form(values), id(n), now);
}
function flow(): FactoryEvent[] {
  return [
    event(10, {
      type: 'purchase',
      resourceId: 'Convoking Wand base',
      ...transaction,
    }),
    event(11, { type: 'consume', purchaseEventId: id(10), stockQuantity: '1' }),
    event(12, {
      type: 'produce',
      description: 'Synthetic wand',
      outcome: 'salvage-life-tier2',
      classification: 'salvage',
      allocationCost: id(11),
      allocationAmount: '100',
    }),
  ];
}

describe('factory financial entry', () => {
  it('keeps original currency and historical conversion, with purchases separate from production', () => {
    const events = flow();
    expect(events[0]!.payload).toMatchObject({ transaction });
    const projection = projectFactoryBatch(batch, events, now);
    expect(projection.metrics).toMatchObject({
      cashFlow: '-200',
      productionCost: '100',
      unusedMaterialCost: '100',
      inventoryCost: '100',
      realizedProfit: '0',
    });
    expect(projection.inventory[0]).toMatchObject({
      targetSignature: null,
      outcomeClassification: 'salvage',
    });
    const html = renderToStaticMarkup(
      <FactoryMetrics metrics={projection.metrics} />,
    );
    expect(html).toContain('Unsold inventory cost');
    expect(html).toContain('Unused material stock');
    expect(html).toContain('Realized profit (allocated sold items)');
    expect(html).toContain('Own time to sell (0 observations)');
    expect(html).not.toContain('0 min');
  });
  it('records a confirmed sale and sale expenses without using a listing as revenue', () => {
    const events = flow();
    events.push(
      event(13, {
        type: 'list',
        itemId: id(12),
        ...transaction,
        quantity: '1',
        unitPrice: '3',
      }),
    );
    expect(projectFactoryBatch(batch, events, now).metrics.realizedProfit).toBe(
      '0',
    );
    events.push(
      event(14, {
        type: 'sale',
        itemId: id(12),
        ...transaction,
        quantity: '1',
        unitPrice: '2',
        chaosPerUnit: '120',
        hasSaleExpense: 'on',
        'expense-quantity': '1',
        'expense-unitPrice': '5',
        'expense-currency': 'chaos',
        'expense-chaosPerUnit': '1',
        'expense-rateSource': 'Chaos transaction; no conversion',
      }),
    );
    const projection = projectFactoryBatch(batch, events, now);
    expect(projection.metrics).toMatchObject({
      realizedProfit: '135',
      cashFlow: '35',
      unusedMaterialCost: '100',
      inventoryCost: '0',
    });
    expect(projection.sales[0]?.transaction.chaosPerUnit).toBe('120');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FactoryBatchSummary
          record={{ batch, events, projection, version: events.length }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('No forecast was attached');
    expect(html).toContain('Confirmed sale');
  });
  it('uses exact submit time for first events in a newly started batch', () => {
    const submitted = '2026-11-04T12:00:15.456Z';
    const first = buildFactoryEvent(
      form({
        type: 'purchase',
        resourceId: 'Base',
        ...transaction,
        occurredAt: '',
      }),
      id(10),
      submitted,
    );
    expect(first.occurredAt).toBe(submitted);
    expect(() => projectFactoryBatch(batch, [first], submitted)).not.toThrow();
  });
  it('preserves the exact pending event after network failure and serialized reload', async () => {
    const raw = form({ type: 'purchase', resourceId: 'Base', ...transaction });
    const create = vi.fn(() =>
      factoryAppendEventInputSchema.parse({
        expectedVersion: 0,
        idempotencyKey: id(30),
        event: buildFactoryEvent(raw, id(31), now),
      }),
    );
    const pending = prepareFactoryRequest(
      null,
      factoryFormFingerprint(raw),
      create,
    );
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({ ok: true });
    await expect(send(pending.request)).rejects.toThrow('Network timeout');
    const restored = {
      fingerprint: pending.fingerprint,
      request: factoryAppendEventInputSchema.parse(
        JSON.parse(JSON.stringify(pending.request)),
      ),
    };
    const retried = prepareFactoryRequest(
      restored,
      factoryFormFingerprint(raw),
      create,
    );
    await send(retried.request);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    raw.set('unitPrice', '2');
    prepareFactoryRequest(restored, factoryFormFingerprint(raw), create);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('rejects missing FX, blank activity counters and invalid allocations rather than silently making zero costs', () => {
    expect(() =>
      event(10, {
        type: 'purchase',
        resourceId: 'Base',
        ...transaction,
        chaosPerUnit: '',
      }),
    ).toThrow();
    expect(() =>
      event(10, { type: 'activity', attempts: '', craftingSeconds: '' }),
    ).toThrow(/explicitly/);
    expect(() =>
      event(10, {
        type: 'produce',
        description: 'Item',
        outcome: 'target',
        allocationCost: id(9),
        allocationAmount: '',
      }),
    ).toThrow();
    expect(() =>
      projectFactoryBatch(
        batch,
        [
          ...flow(),
          event(14, { type: 'sale', itemId: id(12), ...transaction }),
        ],
        now,
      ),
    ).toThrow(/exactly one item/);
  });
  it('traces human-readable material names into allocation choices', () => {
    const events = flow().slice(0, 2);
    const projection = projectFactoryBatch(batch, events, now);
    expect(factoryCostLabel(id(11), events, projection)).toBe(
      'Convoking Wand base',
    );
    const html = renderToStaticMarkup(
      <AllocationFields projection={projection} events={events} />,
    );
    expect(html).toContain('Convoking Wand base');
    expect(html).toContain('100 c available');
  });
  it('keeps corrections auditable and excludes corrected entries from selectable history', () => {
    const events = flow();
    events.push(
      factoryEventSchema.parse({
        id: id(15),
        occurredAt: now,
        source: 'Synthetic correction',
        notes: '',
        payload: {
          type: 'void',
          eventId: id(12),
          reason: 'Recorded wrong result',
        },
      }),
    );
    const projection = projectFactoryBatch(batch, events, now);
    expect(projection.inventory).toHaveLength(0);
    expect(events).toHaveLength(4);
    const html = renderToStaticMarkup(
      <FactoryEventForm
        projection={projection}
        events={events}
        busy={false}
        onSubmit={async () => true}
      />,
    );
    expect(html).toContain('Correct an earlier event');
    expect(html).toContain('Event time (local; blank means now)');
  });
  it('keeps short observed sale times and ratio displays readable without changing exact metrics', () => {
    const metrics = projectFactoryBatch(batch, flow(), now).metrics;
    metrics.meanTimeToSellSeconds = 2;
    metrics.timeToSellSampleSize = 1;
    metrics.actualRoiPercent = '194.11764706';
    metrics.observedUnitTurnover = '0.9581138';
    const html = renderToStaticMarkup(<FactoryMetrics metrics={metrics} />);
    expect(html).toContain('2 sec');
    expect(html).not.toContain('0 min');
    expect(html).toContain('194.12%');
    expect(html).toContain('0.96');
    expect(html).not.toContain('194.11764706');
    expect(metrics.actualRoiPercent).toBe('194.11764706');
  });
  it('exposes the factory route and makes frozen currency semantics explicit', () => {
    const page = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/factory']}>
        <App />
      </MemoryRouter>,
    );
    expect(page).toContain('My Factory');
    expect(page).toContain('Actual production, inventory and confirmed sales');
    const fields = renderToStaticMarkup(<TransactionFields quantity={false} />);
    expect(fields).toContain('Amount in transaction currency');
    expect(fields).toContain('no conversion');
    expect(fields).toContain('will not rewrite this transaction');
  });
});
