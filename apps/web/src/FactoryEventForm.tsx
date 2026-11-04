import { useState, type FormEvent } from 'react';
import type { FactoryEvent, FactoryProjection } from '@poe-worksmith/domain';
import {
  FactoryField,
  FactorySelect,
  TransactionFields,
} from './FactoryFields.js';
import { factoryCostLabel } from './factoryForm.js';

const eventTypes = [
  ['purchase', 'Buy materials or bases'],
  ['consume', 'Consume purchased materials'],
  ['produce', 'Register crafted result'],
  ['list', 'List an item'],
  ['sale', 'Confirm completed sale'],
  ['activity', 'Record attempts and crafting time'],
  ['expense', 'Add crafting or finishing expense'],
  ['allocate', 'Allocate additional item costs'],
  ['credit', 'Record recovery credit'],
  ['return-material', 'Return unused materials to stock'],
  ['refund', 'Refund unused purchase'],
  ['item-status', 'Change inventory status'],
  ['batch-status', 'Change production status'],
  ['note', 'Update batch notes'],
  ['void', 'Correct an earlier event'],
] as const;

export function AllocationFields({
  projection,
  events,
}: {
  projection: FactoryProjection;
  events: FactoryEvent[];
  targetSignature?: string;
}) {
  const [rows, setRows] = useState([0]);
  const costs = projection.costs.filter((cost) => Number(cost.remaining) > 0);
  return (
    <fieldset>
      <legend>Trace production cost to this item</legend>
      <p className="factory-note">
        Allocate consumed materials and expenses in chaos. Purchases still in
        stock are not production cost. Blank rows leave costs unallocated and
        profitability incomplete.
      </p>
      {rows.map((row) => (
        <div className="factory-allocation" key={row}>
          <label>
            Cost source
            <select name="allocationCost">
              <option value="">Select cost or leave unallocated</option>
              {costs.map((cost) => (
                <option key={cost.eventId} value={cost.eventId}>
                  {factoryCostLabel(cost.eventId, events, projection)} ·{' '}
                  {cost.remaining} c available · {cost.eventId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <FactoryField
            name="allocationAmount"
            label="Allocated cost (chaos)"
            type="number"
            step="any"
            min="0.000001"
            required={false}
          />
          <button
            type="button"
            onClick={() => setRows(rows.filter((id) => id !== row))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={rows.length >= 200}
        onClick={() => setRows([...rows, Math.max(-1, ...rows) + 1])}
      >
        Add cost allocation
      </button>
    </fieldset>
  );
}

export function FactoryEventForm({
  projection,
  events,
  busy,
  onSubmit,
  targetSignature,
}: {
  projection: FactoryProjection;
  events: FactoryEvent[];
  targetSignature?: string;
  busy: boolean;
  onSubmit: (form: FormData) => Promise<boolean>;
}) {
  const [type, setType] = useState('purchase');
  const [hasSaleExpense, setHasSaleExpense] = useState(false);
  const [matchesTarget, setMatchesTarget] = useState(false);
  const availableItems = projection.inventory.filter((item) =>
    ['held', 'listed'].includes(item.status),
  );
  const activeEvents = events.filter(
    (event) =>
      event.payload.type !== 'void' &&
      !projection.voidedEventIds.includes(event.id),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(new FormData(event.currentTarget));
  }
  return (
    <form onSubmit={submit} aria-label="Record factory event">
      <label>
        Event type
        <select
          disabled={busy}
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            setHasSaleExpense(false);
            setMatchesTarget(false);
          }}
        >
          {eventTypes.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <fieldset key={type} disabled={busy} className="factory-panel">
        <input type="hidden" name="type" value={type} />
        {type === 'purchase' ? (
          <FactoryField
            name="resourceId"
            label="Material or base name"
            maxLength={200}
          />
        ) : null}
        {['consume', 'refund'].includes(type) ? (
          <FactorySelect name="purchaseEventId" label="Purchase lot">
            <option value="">Choose purchase</option>
            {projection.stock
              .filter((lot) => Number(lot.quantityAvailable) > 0)
              .map((lot) => (
                <option key={lot.purchaseEventId} value={lot.purchaseEventId}>
                  {lot.resourceId} · {lot.quantityAvailable} available ·{' '}
                  {lot.purchaseEventId.slice(0, 8)}
                </option>
              ))}
          </FactorySelect>
        ) : null}
        {type === 'return-material' ? (
          <FactorySelect name="consumeEventId" label="Consumption to reverse">
            <option value="">Choose consumption</option>
            {activeEvents
              .filter((event) => event.payload.type === 'consume')
              .map((event) => (
                <option key={event.id} value={event.id}>
                  {event.id.slice(0, 8)} · {event.occurredAt}
                </option>
              ))}
          </FactorySelect>
        ) : null}
        {['consume', 'return-material', 'refund'].includes(type) ? (
          <FactoryField
            name="stockQuantity"
            label="Stock quantity"
            type="number"
            step="any"
            min="0.000001"
          />
        ) : null}
        {['allocate', 'list', 'sale', 'item-status'].includes(type) ? (
          <FactorySelect name="itemId" label="Inventory item">
            <option value="">Choose held or listed item</option>
            {availableItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.description} · {item.status} · {item.id.slice(0, 8)}
              </option>
            ))}
          </FactorySelect>
        ) : null}
        {type === 'produce' ? (
          <>
            <FactoryField
              name="description"
              label="Crafted item description"
              maxLength={200}
            />
            <FactoryField
              name="outcome"
              label="Outcome ID or classification label"
              maxLength={200}
            />
            <FactorySelect
              name="classification"
              label="Outcome category"
              value="unknown"
            >
              {[
                'unknown',
                'premium',
                'target',
                'imperfect',
                'salvage',
                'unusable',
                'recovery',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </FactorySelect>
            {targetSignature ? (
              <label className="factory-check">
                <input
                  type="checkbox"
                  checked={matchesTarget}
                  onChange={(event) => setMatchesTarget(event.target.checked)}
                />
                Matches this recipe’s exact target
              </label>
            ) : null}
            {matchesTarget ? (
              <input
                name="targetSignature"
                type="hidden"
                value={targetSignature}
              />
            ) : (
              <details>
                <summary>Advanced output matching</summary>
                <FactoryField
                  name="targetSignature"
                  label="Other verified output signature (optional)"
                  required={false}
                  maxLength={200}
                />
                <p className="factory-note">
                  Leave unknown unless you can verify the exact item
                  requirements. The recipe's target is not assigned to salvage
                  results automatically.
                </p>
              </details>
            )}
            <label>
              Modifiers (one per line)
              <textarea name="modifiers" rows={3} />
            </label>
            <p className="factory-note">
              Use the model's outcome ID when known. Register each physical
              result separately.
            </p>
          </>
        ) : null}
        {['produce', 'allocate'].includes(type) ? (
          <AllocationFields projection={projection} events={events} />
        ) : null}
        {['expense', 'credit'].includes(type) ? (
          <FactorySelect name="category" label="Cost or credit category">
            {(type === 'credit'
              ? ['recovery', 'other']
              : ['base', 'crafting', 'finishing', 'recovery', 'other']
            ).map((category) => (
              <option key={category}>{category}</option>
            ))}
          </FactorySelect>
        ) : null}
        {['purchase', 'expense', 'credit', 'refund', 'list', 'sale'].includes(
          type,
        ) ? (
          <TransactionFields
            quantity={type === 'purchase'}
            label={
              type === 'list'
                ? 'Advertised listing price (not a sale)'
                : type === 'sale'
                  ? 'Confirmed sale proceeds'
                  : 'Actual transaction'
            }
          />
        ) : null}
        {type === 'sale' ? (
          <>
            <label className="factory-check">
              <input
                type="checkbox"
                name="hasSaleExpense"
                checked={hasSaleExpense}
                onChange={(event) => setHasSaleExpense(event.target.checked)}
              />
              Include transaction expense
            </label>
            {hasSaleExpense ? (
              <TransactionFields
                prefix="expense-"
                quantity={false}
                label="Expense paid for this sale"
              />
            ) : null}
            <p className="factory-note">
              Only record a sale you completed. A disappearing listing is not a
              sale. Allocate all production and finishing costs before
              confirming.
            </p>
          </>
        ) : null}
        {type === 'activity' ? (
          <div className="factory-fields">
            <FactoryField
              name="attempts"
              label="Completed method runs"
              type="number"
              min="0"
              step="1"
            />
            <FactoryField
              name="craftingSeconds"
              label="Actual crafting time (seconds)"
              type="number"
              min="0"
              step="1"
            />
            <p className="factory-note">
              For comparison with a saved simulation, count terminal method
              runs, including internal retries. Enter 0 if time or attempts were
              not recorded.
            </p>
          </div>
        ) : null}
        {type === 'item-status' ? (
          <FactorySelect name="status" label="New item status">
            {['held', 'consumed', 'recycled', 'discarded'].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </FactorySelect>
        ) : null}
        {type === 'batch-status' ? (
          <>
            <FactorySelect name="status" label="Production status">
              {['active', 'completed', 'cancelled'].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </FactorySelect>
            <p className="factory-note">
              Completing production does not mark remaining items sold. Listings
              and confirmed sales can still be recorded.
            </p>
          </>
        ) : null}
        {type === 'note' ? (
          <label>
            New batch notes
            <textarea name="text" rows={3} maxLength={2000} />
          </label>
        ) : null}
        {type === 'void' ? (
          <>
            <FactorySelect name="eventId" label="Event to correct">
              <option value="">Choose active event</option>
              {activeEvents.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.payload.type} · {event.id.slice(0, 8)} ·{' '}
                  {event.occurredAt}
                </option>
              ))}
            </FactorySelect>
            <FactoryField
              name="reason"
              label="Correction reason"
              maxLength={200}
            />
            <p className="factory-note">
              This appends an audit correction; history remains. Correct
              dependent sales or allocations first, then record the replacement
              event.
            </p>
          </>
        ) : null}
        <div className="factory-fields">
          <FactoryField
            name="occurredAt"
            label="Event time (local; blank means now)"
            type="datetime-local"
            step="1"
            required={false}
          />
          <FactoryField
            name="source"
            label="Transaction or event source"
            maxLength={200}
          />
          <FactoryField
            name="notes"
            label="Event notes"
            maxLength={2000}
            required={false}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record event'}
        </button>
      </fieldset>
    </form>
  );
}
