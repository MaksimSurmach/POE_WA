import {
  factoryEventSchema,
  factoryTransactionSchema,
  type FactoryEvent,
  type FactoryProjection,
  type OutcomeModel,
} from '@poe-worksmith/domain';

export function factoryText(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}
export function factoryTransaction(form: FormData, prefix = '') {
  return factoryTransactionSchema.parse(
    Object.fromEntries(
      ['quantity', 'unitPrice', 'currency', 'chaosPerUnit', 'rateSource'].map(
        (key) => [key, factoryText(form, prefix + key)],
      ),
    ),
  );
}
export function buildFactoryEvent(
  form: FormData,
  id: string,
  now: string,
): FactoryEvent {
  const type = factoryText(form, 'type');
  const itemId = factoryText(form, 'itemId');
  const costs = form.getAll('allocationCost');
  const amounts = form.getAll('allocationAmount');
  const allocations = costs.flatMap((cost, index) => {
    const amount = String(amounts[index] ?? '').trim();
    return !String(cost).trim() && !amount
      ? []
      : [{ costEventId: String(cost), amount }];
  });
  let payload: unknown;
  switch (type) {
    case 'purchase':
      payload = {
        type,
        resourceId: factoryText(form, 'resourceId'),
        transaction: factoryTransaction(form),
      };
      break;
    case 'consume':
      payload = {
        type,
        purchaseEventId: factoryText(form, 'purchaseEventId'),
        quantity: factoryText(form, 'stockQuantity'),
      };
      break;
    case 'return-material':
      payload = {
        type,
        consumeEventId: factoryText(form, 'consumeEventId'),
        quantity: factoryText(form, 'stockQuantity'),
      };
      break;
    case 'refund':
      payload = {
        type,
        purchaseEventId: factoryText(form, 'purchaseEventId'),
        quantity: factoryText(form, 'stockQuantity'),
        transaction: factoryTransaction(form),
      };
      break;
    case 'expense':
    case 'credit':
      payload = {
        type,
        category: factoryText(form, 'category'),
        transaction: factoryTransaction(form),
      };
      break;
    case 'produce':
      payload = {
        type,
        itemId: id,
        description: factoryText(form, 'description'),
        modifiers: factoryText(form, 'modifiers')
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
        outcome: factoryText(form, 'outcome'),
        classification: factoryText(form, 'classification') || 'unknown',
        targetSignature: factoryText(form, 'targetSignature') || null,
        allocations,
      };
      break;
    case 'allocate':
      payload = { type, itemId, allocations };
      break;
    case 'list':
      payload = { type, itemId, price: factoryTransaction(form) };
      break;
    case 'sale':
      payload = {
        type,
        itemId,
        transaction: factoryTransaction(form),
        expenses: form.get('hasSaleExpense')
          ? [factoryTransaction(form, 'expense-')]
          : [],
      };
      break;
    case 'item-status':
    case 'batch-status':
      payload = {
        type,
        ...(type === 'item-status' ? { itemId } : {}),
        status: factoryText(form, 'status'),
      };
      break;
    case 'activity':
      if (
        !/^\d+$/.test(factoryText(form, 'attempts')) ||
        !/^\d+$/.test(factoryText(form, 'craftingSeconds'))
      )
        throw new Error(
          'Enter completed method runs and crafting seconds explicitly, including zero.',
        );
      payload = {
        type,
        attempts: Number(factoryText(form, 'attempts')),
        craftingSeconds: Number(factoryText(form, 'craftingSeconds')),
      };
      break;
    case 'note':
      payload = { type, text: factoryText(form, 'text') };
      break;
    case 'void':
      payload = {
        type,
        eventId: factoryText(form, 'eventId'),
        reason: factoryText(form, 'reason'),
      };
      break;
    default:
      throw new Error('Select an event type.');
  }
  const enteredTime = factoryText(form, 'occurredAt');
  return factoryEventSchema.parse({
    id,
    occurredAt: enteredTime ? new Date(enteredTime).toISOString() : now,
    source: factoryText(form, 'source'),
    notes: factoryText(form, 'notes'),
    payload,
  });
}

export function factoryFormFingerprint(form: FormData) {
  return JSON.stringify(
    [...form.entries()].map(([key, value]) => [key, String(value)]),
  );
}
export type PendingFactoryRequest<T> = {
  fingerprint: string;
  request: T;
  rejectedConflict?: true;
};
/** Cache exact mutations, including server version and transaction time, until confirmation. */
export function prepareFactoryRequest<T>(
  previous: PendingFactoryRequest<T> | null,
  fingerprint: string,
  create: () => T,
): PendingFactoryRequest<T> {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, request: create() };
}
export function factoryErrorMessage(error: unknown) {
  if (
    error instanceof Error &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues
      .map(
        (issue: { path?: unknown[]; message?: string }) =>
          `${issue.path?.join('.') ?? 'Input'}: ${issue.message ?? 'Invalid input'}`,
      )
      .slice(0, 4)
      .join(' · ');
  }
  return error instanceof Error ? error.message : 'Factory request failed.';
}

export function factoryCostLabel(
  eventId: string,
  events: FactoryEvent[],
  projection: FactoryProjection,
) {
  const event = events.find((value) => value.id === eventId);
  if (event?.payload.type === 'consume') {
    const purchaseEventId = event.payload.purchaseEventId;
    return (
      projection.stock.find((lot) => lot.purchaseEventId === purchaseEventId)
        ?.resourceId ?? 'Consumed material'
    );
  }
  if (event?.payload.type === 'expense')
    return `${event.payload.category}: ${event.notes || event.source}`;
  return 'Production cost';
}

/** A read can prove a lost response committed; only an explicit refresh resolves a rejected conflict. */
export function reconcileFactoryPending<T extends { event: { id: string } }>(
  pending: PendingFactoryRequest<T> | null,
  events: Pick<FactoryEvent, 'id'>[],
  explicitRefresh = false,
): 'recorded' | 'rejected-conflict' | null {
  if (!pending) return null;
  if (events.some((event) => event.id === pending.request.event.id))
    return 'recorded';
  return explicitRefresh && pending.rejectedConflict
    ? 'rejected-conflict'
    : null;
}

export function factoryExactTargetAllowed(
  model: OutcomeModel | null | undefined,
  outcomeId: string,
  classification: string,
  targetSignature: string | undefined,
): boolean {
  if (!targetSignature) return false;
  const declared = model?.stages
    .flatMap((stage) => stage.outcomes)
    .find((outcome) => outcome.id === outcomeId);
  if (
    declared &&
    (declared.matching.kind !== 'exact-target' ||
      declared.matching.targetSignature !== targetSignature ||
      (classification !== 'unknown' &&
        classification !== declared.classification))
  )
    return false;
  return ['premium', 'target'].includes(
    declared?.classification ?? classification,
  );
}
