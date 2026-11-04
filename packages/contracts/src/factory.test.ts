import { describe, expect, it } from 'vitest';
import {
  factoryAppendEventInputSchema,
  factoryCreateBatchInputSchema,
} from './factory.js';
const id = '00000000-0000-4000-8000-000000000001';
const transaction = {
  quantity: '1',
  unitPrice: '10',
  currency: 'divine',
  chaosPerUnit: '100',
  rateSource: 'Confirmed transaction-time FX',
};
describe('factory financial write contracts', () => {
  it('requires original denomination and explicit locked conversion evidence', () => {
    const input = {
      recipeId: 'recipe',
      recipeHash: 'revision',
      league: 'Synthetic League',
      plannedBudget: transaction,
      idempotencyKey: id,
    };
    expect(factoryCreateBatchInputSchema.parse(input).plannedBudget).toEqual(
      transaction,
    );
    expect(
      factoryCreateBatchInputSchema.safeParse({
        ...input,
        plannedBudget: { ...transaction, rateSource: '' },
      }).success,
    ).toBe(false);
    expect(
      factoryCreateBatchInputSchema.safeParse({
        ...input,
        plannedBudget: { ...transaction, chaosPerUnit: '0' },
      }).success,
    ).toBe(false);
  });
  it('requires optimistic version, idempotency key and bounded event inputs', () => {
    const input = {
      expectedVersion: 0,
      idempotencyKey: id,
      event: {
        id,
        occurredAt: '2026-11-04T00:00:00Z',
        source: 'Owner confirmed receipt',
        notes: '',
        payload: { type: 'purchase', resourceId: 'base', transaction },
      },
    };
    expect(factoryAppendEventInputSchema.safeParse(input).success).toBe(true);
    expect(
      factoryAppendEventInputSchema.safeParse({
        ...input,
        expectedVersion: 2001,
      }).success,
    ).toBe(false);
    expect(
      factoryAppendEventInputSchema.safeParse({
        ...input,
        idempotencyKey: 'reused string',
      }).success,
    ).toBe(false);
    expect(
      factoryAppendEventInputSchema.safeParse({
        ...input,
        event: {
          ...input.event,
          payload: {
            ...input.event.payload,
            transaction: { ...transaction, unitPrice: 'Infinity' },
          },
        },
      }).success,
    ).toBe(false);
  });
  it('records correction reasons instead of accepting mutable item aggregates', () => {
    const input = {
      expectedVersion: 1,
      idempotencyKey: id,
      event: {
        id,
        occurredAt: '2026-11-04T00:00:00Z',
        source: 'Owner correction',
        notes: '',
        payload: { type: 'void', eventId: id, reason: 'Receipt entered twice' },
      },
    };
    expect(factoryAppendEventInputSchema.safeParse(input).success).toBe(true);
    expect(
      factoryAppendEventInputSchema.safeParse({
        ...input,
        event: {
          ...input.event,
          payload: { type: 'set-profit', amount: '100' },
        },
      }).success,
    ).toBe(false);
  });
});
