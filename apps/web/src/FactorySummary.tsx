import type { FactoryBatchRecord } from '@poe-worksmith/contracts';
import type {
  FactoryProjection,
  FactoryTransaction,
} from '@poe-worksmith/domain';
import { Link } from 'react-router-dom';
import { factoryCostLabel } from './factoryForm.js';

export function factoryMoney(value: string | null) {
  return value === null
    ? 'Unavailable'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(Number(value))} c`;
}
export function factoryOriginalPrice(transaction: FactoryTransaction | null) {
  return transaction
    ? `${transaction.quantity} × ${transaction.unitPrice} ${transaction.currency === 'divine' ? 'div' : 'c'}${transaction.currency === 'divine' ? ` @ ${transaction.chaosPerUnit} c/div` : ''}`
    : '—';
}
function duration(seconds: number | null) {
  return seconds === null
    ? 'Unavailable'
    : seconds < 60
      ? seconds > 0 && seconds < 1
        ? '<1 sec'
        : `${Math.round(seconds)} sec`
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min`
        : `${(seconds / 3600).toFixed(1)} h`;
}

function ratio(value: string | null) {
  return value === null
    ? 'Unavailable'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
        Number(value),
      );
}

export function FactoryMetrics({
  metrics,
}: {
  metrics: FactoryProjection['metrics'];
}) {
  return (
    <>
      <dl className="factory-metrics">
        <div>
          <dt>Realized profit (allocated sold items)</dt>
          <dd>{factoryMoney(metrics.realizedProfit)}</dd>
        </div>
        <div>
          <dt>Recognized item result (sold + disposed)</dt>
          <dd>{factoryMoney(metrics.recognizedItemResult)}</dd>
        </div>
        <div>
          <dt>Cash flow</dt>
          <dd>{factoryMoney(metrics.cashFlow)}</dd>
        </div>
        <div>
          <dt>Unsold inventory cost</dt>
          <dd>{factoryMoney(metrics.inventoryCost)}</dd>
        </div>
        <div>
          <dt>Unused material stock</dt>
          <dd>{factoryMoney(metrics.unusedMaterialCost)}</dd>
        </div>
        <div>
          <dt>Actual production cost</dt>
          <dd>{factoryMoney(metrics.productionCost)}</dd>
        </div>
        <div>
          <dt>Unallocated production cost</dt>
          <dd>{factoryMoney(metrics.unallocatedCost)}</dd>
        </div>
        <div>
          <dt>Gross spending</dt>
          <dd>{factoryMoney(metrics.grossSpending)}</dd>
        </div>
        <div>
          <dt>Realized ROI (sold + disposed items)</dt>
          <dd>
            {metrics.actualRoiPercent === null
              ? 'Unavailable'
              : `${ratio(metrics.actualRoiPercent)}%`}
          </dd>
        </div>
        <div>
          <dt>Recovery credits</dt>
          <dd>{factoryMoney(metrics.recoveryCredits)}</dd>
        </div>
        <div>
          <dt>Salvage sale revenue</dt>
          <dd>{factoryMoney(metrics.salvageSaleRevenue)}</dd>
        </div>
        <div>
          <dt>Confirmed sales / produced</dt>
          <dd>
            {metrics.soldCount} / {metrics.producedCount}
          </dd>
        </div>
        <div>
          <dt>
            Own time to sell ({metrics.timeToSellSampleSize} observations)
          </dt>
          <dd>{duration(metrics.meanTimeToSellSeconds)}</dd>
        </div>
        <div>
          <dt>Observed sell-through</dt>
          <dd>
            {metrics.observedSellThroughPercent === null
              ? 'Unavailable'
              : `${ratio(metrics.observedSellThroughPercent)}%`}
          </dd>
        </div>
        <div>
          <dt>Recognized item result / crafting hour</dt>
          <dd>{factoryMoney(metrics.profitPerCraftingHour)}</dd>
        </div>
        <div>
          <dt>Attempts · crafting time</dt>
          <dd>
            {metrics.attempts} · {duration(metrics.craftingSeconds || null)}
          </dd>
        </div>
        <div>
          <dt>Disposed item costs</dt>
          <dd>{factoryMoney(metrics.disposedCost)}</dd>
        </div>
        <div>
          <dt>
            Own listed asking value ({metrics.listedInventoryCount} items)
          </dt>
          <dd>{factoryMoney(metrics.listedInventoryAskingValue)}</dd>
        </div>
        <div>
          <dt>Observed unit turnover</dt>
          <dd>{ratio(metrics.observedUnitTurnover)}</dd>
        </div>
      </dl>
      {metrics.turnoverWindowStart && metrics.turnoverWindowEnd ? (
        <p className="factory-note">
          Turnover window:{' '}
          {new Date(metrics.turnoverWindowStart).toLocaleString('en-US')} –{' '}
          {new Date(metrics.turnoverWindowEnd).toLocaleString('en-US')}.
          Confirmed units sold ÷ time-weighted held units (
          {ratio(metrics.averageHeldUnits)}). Listing asks are indicative, not
          inventory fair value or confirmed revenue.
        </p>
      ) : null}
      <p className="factory-note">
        Realized profit uses confirmed sales less their allocated production
        costs and sale expenses. Cash flow includes all purchases and receipts.
        Inventory and unused stock remain separate; no indicative resale value
        is assumed.
      </p>
      <p className="factory-note">
        Recognized item result subtracts disposed-item costs from sold-item
        profit. ROI uses sold-item production costs, sale expenses and disposed
        costs; recovery and other credits remain cash receipts.
      </p>
      <details>
        <summary>Cash reconciliation</summary>
        <dl className="factory-metrics">
          <div>
            <dt>Confirmed sale receipts</dt>
            <dd>{factoryMoney(metrics.saleRevenue)}</dd>
          </div>
          <div>
            <dt>Refund receipts</dt>
            <dd>{factoryMoney(metrics.refundReceipts)}</dd>
          </div>
          <div>
            <dt>Refunded material cost basis</dt>
            <dd>{factoryMoney(metrics.refundedMaterialCost)}</dd>
          </div>
          <div>
            <dt>Recovery receipts</dt>
            <dd>{factoryMoney(metrics.recoveryCredits)}</dd>
          </div>
          <div>
            <dt>Other receipts</dt>
            <dd>{factoryMoney(metrics.otherCredits)}</dd>
          </div>
          <div>
            <dt>All cash received</dt>
            <dd>{factoryMoney(metrics.cashReceived)}</dd>
          </div>
          <div>
            <dt>All cash spent</dt>
            <dd>{factoryMoney(metrics.grossSpending)}</dd>
          </div>
        </dl>
        <p className="factory-note">
          Cash flow = all receipts − all spending. Refunded material cost is
          removed from stock, not counted as another cash payment.
        </p>
      </details>
      {!metrics.allocationComplete ? (
        <p className="recipe-warning">
          Unallocated costs remain. Sold-item profit is provisional; finish
          tracing costs before interpreting profitability.
        </p>
      ) : null}
    </>
  );
}

export function FactoryBatchSummary({
  record,
}: {
  record: FactoryBatchRecord;
}) {
  const { batch, projection } = record;
  const comparison = projection.forecastComparison;
  return (
    <>
      <div className="factory-actions">
        <h2>Batch {batch.id.slice(0, 8)}</h2>
        <Link to={`/recipes/${encodeURIComponent(batch.recipeId)}`}>
          View recipe
        </Link>
      </div>
      <p className="factory-note">
        {batch.league} · {projection.status} · Revision{' '}
        {batch.recipeHash.slice(0, 10)} · Started{' '}
        {new Date(batch.startedAt).toLocaleString('en-US')}
        {projection.completedAt
          ? ` · Production ended ${new Date(projection.completedAt).toLocaleString('en-US')}`
          : ''}{' '}
        · Planned budget {factoryOriginalPrice(batch.plannedBudget)}
      </p>
      {projection.notes ? <p>{projection.notes}</p> : null}
      <FactoryMetrics metrics={projection.metrics} />
      {projection.warnings.map((warning) => (
        <p className="factory-note" key={warning}>
          {warning}
        </p>
      ))}
      <details>
        <summary>Expected versus actual cash economics</summary>
        <p className="factory-note">{comparison.reason}</p>
        {batch.forecast ? (
          <p className="factory-note">
            Frozen source {batch.forecast.sourceId}.{' '}
            {batch.forecast.riskRequest
              ? `Objective: ${batch.forecast.riskRequest.objective.kind} × ${batch.forecast.riskRequest.objective.count}.`
              : 'First-run cash EV only; no comparable batch simulation.'}{' '}
            Retained assets have no assigned value.
          </p>
        ) : (
          <p className="factory-note">
            No forecast was attached when this batch started.
          </p>
        )}
        {comparison.status === 'comparable' ? (
          <dl className="factory-metrics">
            <div>
              <dt>Expected outlay</dt>
              <dd>{factoryMoney(comparison.expectedCost)}</dd>
            </div>
            <div>
              <dt>Actual outlay</dt>
              <dd>{factoryMoney(comparison.actualCashOutlay)}</dd>
            </div>
            <div>
              <dt>Expected cash result</dt>
              <dd>{factoryMoney(comparison.expectedProfit)}</dd>
            </div>
            <div>
              <dt>Actual cash result</dt>
              <dd>{factoryMoney(comparison.actualCashResult)}</dd>
            </div>
            <div>
              <dt>Outlay difference</dt>
              <dd>{factoryMoney(comparison.costDifference)}</dd>
            </div>
            <div>
              <dt>Cash-result difference</dt>
              <dd>{factoryMoney(comparison.profitDifference)}</dd>
            </div>
          </dl>
        ) : null}
      </details>
      <h2>Produced inventory</h2>
      {projection.inventory.length ? (
        <div className="factory-scroll">
          <table className="factory-table">
            <thead>
              <tr>
                <th>Item / outcome</th>
                <th>Status</th>
                <th>Allocated cost</th>
                <th>Advertised price</th>
                <th>Confirmed sale</th>
              </tr>
            </thead>
            <tbody>
              {projection.inventory.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.description}
                    <small>
                      {item.outcome} ({item.outcomeClassification}) ·{' '}
                      {item.id.slice(0, 8)}
                    </small>
                    {item.modifiers.length ? (
                      <details>
                        <summary>Modifiers</summary>
                        {item.modifiers.map((modifier) => (
                          <p key={modifier}>{modifier}</p>
                        ))}
                      </details>
                    ) : null}
                  </td>
                  <td>{item.status}</td>
                  <td>{factoryMoney(item.allocatedCost)}</td>
                  <td>
                    {factoryOriginalPrice(item.listingPrice)}
                    {item.listedAt ? (
                      <small>
                        {new Date(item.listedAt).toLocaleString('en-US')}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    {item.soldAt ? (
                      <>
                        {factoryMoney(item.saleRevenue)}
                        <small>
                          {new Date(item.soldAt).toLocaleString('en-US')}
                        </small>
                      </>
                    ) : (
                      'No completed sale'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="factory-note">No crafted items registered yet.</p>
      )}
      <details>
        <summary>Material stock and cost allocations</summary>
        <div className="factory-scroll">
          <table className="factory-table">
            <thead>
              <tr>
                <th>Purchase lot</th>
                <th>Available quantity</th>
                <th>Unused cost</th>
              </tr>
            </thead>
            <tbody>
              {projection.stock.map((lot) => (
                <tr key={lot.purchaseEventId}>
                  <td>
                    {lot.resourceId}
                    <small>{lot.purchaseEventId.slice(0, 8)}</small>
                  </td>
                  <td>{lot.quantityAvailable}</td>
                  <td>{factoryMoney(lot.costBasis)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="factory-table">
            <thead>
              <tr>
                <th>Cost source</th>
                <th>Production cost</th>
                <th>Allocated</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {projection.costs.map((cost) => (
                <tr key={cost.eventId}>
                  <td>
                    {factoryCostLabel(cost.eventId, record.events, projection)}
                    <small>{cost.eventId.slice(0, 8)}</small>
                  </td>
                  <td>{factoryMoney(cost.amount)}</td>
                  <td>{factoryMoney(cost.allocated)}</td>
                  <td>{factoryMoney(cost.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Audit log ({record.events.length} events)</summary>
        <div className="factory-scroll">
          <table className="factory-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Time / source</th>
                <th>Recorded details</th>
              </tr>
            </thead>
            <tbody>
              {record.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    {event.payload.type}
                    <small>
                      {event.id.slice(0, 8)}
                      {projection.voidedEventIds.includes(event.id)
                        ? ' · corrected'
                        : ''}
                    </small>
                  </td>
                  <td>
                    {new Date(event.occurredAt).toLocaleString('en-US')}
                    <small>{event.source}</small>
                  </td>
                  <td>
                    <pre className="factory-event-summary">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                    {event.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
