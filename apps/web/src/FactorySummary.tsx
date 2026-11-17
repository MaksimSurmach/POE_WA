import { formatTimestamp } from './dateTime.js';
import { TableSurface } from './ui.js';
import type { FactoryBatchRecord } from '@poe-worksmith/contracts';
import type {
  FactoryProjection,
  FactoryTransaction,
} from '@poe-worksmith/domain';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
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
          <dt>
            Реализованная прибыль (проданные предметы с распределёнными
            затратами)
          </dt>
          <dd>{factoryMoney(metrics.realizedProfit)}</dd>
        </div>
        <div>
          <dt>Recognized item result (sold + disposed)</dt>
          <dd>{factoryMoney(metrics.recognizedItemResult)}</dd>
        </div>
        <div>
          <dt>Денежный поток</dt>
          <dd>{factoryMoney(metrics.cashFlow)}</dd>
        </div>
        <div>
          <dt>Себестоимость непроданных предметов</dt>
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
          <dt>Подтверждено продаж / произведено</dt>
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
          Turnover window: {formatTimestamp(metrics.turnoverWindowStart)} –{' '}
          {formatTimestamp(metrics.turnoverWindowEnd)}. Confirmed units sold ÷
          time-weighted held units ({ratio(metrics.averageHeldUnits)}). Listing
          asks are indicative, not inventory fair value or confirmed revenue.
        </p>
      ) : null}
      <p className="factory-note">
        Реализованная прибыль — подтверждённая выручка за вычетом отнесённой
        себестоимости и расходов продажи. Денежный поток включает все покупки и
        поступления. Непроданные предметы и неиспользованные материалы
        учитываются отдельно; предполагаемая цена перепродажи им не назначается.
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
            <dt>Поступления от подтверждённых продаж</dt>
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
          Денежный поток = все поступления − все платежи. Возвращённая
          себестоимость материалов удаляется из запаса, а не учитывается
          повторным платежом.
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
          Открыть рецепт
        </Link>
      </div>
      <p className="factory-note">
        {batch.league} · {projection.status} · Revision{' '}
        {batch.recipeHash.slice(0, 10)} · Started{' '}
        {formatTimestamp(batch.startedAt)}
        {projection.completedAt
          ? ` · Production ended ${formatTimestamp(projection.completedAt)}`
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
              ? `Цель расчёта: ${batch.forecast.riskRequest.objective.kind} × ${batch.forecast.riskRequest.objective.count}.`
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
      <h2>Произведённые предметы</h2>
      {projection.inventory.length ? (
        <div
          className="factory-scroll"
          role="region"
          aria-label="Журнал партии"
          tabIndex={0}
        >
          <TableSurface>
            <table className="table__content factory-table">
              <thead className="table__header">
                <tr className="table__row">
                  <th className="table__column">Предмет / результат</th>
                  <th className="table__column">Статус</th>
                  <th className="table__column">Отнесённая себестоимость</th>
                  <th className="table__column">Цена объявления</th>
                  <th className="table__column">Подтверждённая продажа</th>
                </tr>
              </thead>
              <tbody className="table__body">
                {projection.inventory.map((item) => (
                  <tr className="table__row" key={item.id}>
                    <td className="table__cell">
                      {item.description}
                      <small>
                        {item.outcome} ({item.outcomeClassification}) ·{' '}
                        {item.id.slice(0, 8)}
                      </small>
                      {item.modifiers.length ? (
                        <details>
                          <summary>Модификаторы</summary>
                          {item.modifiers.map((modifier) => (
                            <p key={modifier}>{modifier}</p>
                          ))}
                        </details>
                      ) : null}
                    </td>
                    <td className="table__cell">{item.status}</td>
                    <td className="table__cell">
                      {factoryMoney(item.allocatedCost)}
                    </td>
                    <td className="table__cell">
                      {factoryOriginalPrice(item.listingPrice)}
                      {item.listedAt ? (
                        <small>{formatTimestamp(item.listedAt)}</small>
                      ) : null}
                    </td>
                    <td className="table__cell">
                      {item.soldAt ? (
                        <>
                          {factoryMoney(item.saleRevenue)}
                          <small>{formatTimestamp(item.soldAt)}</small>
                        </>
                      ) : (
                        'Продажа не подтверждена'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableSurface>
        </div>
      ) : (
        <p className="factory-note">
          Произведённые предметы пока не зарегистрированы.
        </p>
      )}
      <details>
        <summary>Материалы и распределение затрат</summary>
        <div
          className="factory-scroll"
          role="region"
          aria-label="Журнал партии"
          tabIndex={0}
        >
          <TableSurface>
            <table className="table__content factory-table">
              <thead className="table__header">
                <tr className="table__row">
                  <th className="table__column">Партия закупки</th>
                  <th className="table__column">Доступное количество</th>
                  <th className="table__column">Остаточная стоимость</th>
                </tr>
              </thead>
              <tbody className="table__body">
                {projection.stock.map((lot) => (
                  <tr className="table__row" key={lot.purchaseEventId}>
                    <td className="table__cell">
                      {lot.resourceId}
                      <small>{lot.purchaseEventId.slice(0, 8)}</small>
                    </td>
                    <td className="table__cell">{lot.quantityAvailable}</td>
                    <td className="table__cell">
                      {factoryMoney(lot.costBasis)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableSurface>
          <TableSurface>
            <table className="table__content factory-table">
              <thead className="table__header">
                <tr className="table__row">
                  <th className="table__column">Источник затрат</th>
                  <th className="table__column">Затраты производства</th>
                  <th className="table__column">Allocated</th>
                  <th className="table__column">Остаток</th>
                </tr>
              </thead>
              <tbody className="table__body">
                {projection.costs.map((cost) => (
                  <tr className="table__row" key={cost.eventId}>
                    <td className="table__cell">
                      {factoryCostLabel(
                        cost.eventId,
                        record.events,
                        projection,
                      )}
                      <small>{cost.eventId.slice(0, 8)}</small>
                    </td>
                    <td className="table__cell">{factoryMoney(cost.amount)}</td>
                    <td className="table__cell">
                      {factoryMoney(cost.allocated)}
                    </td>
                    <td className="table__cell">
                      {factoryMoney(cost.remaining)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableSurface>
        </div>
      </details>
      <details>
        <summary>Журнал событий ({record.events.length} events)</summary>
        <div
          className="factory-scroll"
          role="region"
          aria-label="Журнал партии"
          tabIndex={0}
        >
          <TableSurface>
            <table className="table__content factory-table">
              <thead className="table__header">
                <tr className="table__row">
                  <th className="table__column">Event</th>
                  <th className="table__column">Время / источник</th>
                  <th className="table__column">Сведения о событии</th>
                </tr>
              </thead>
              <tbody className="table__body">
                {record.events.map((event) => (
                  <tr className="table__row" key={event.id}>
                    <td className="table__cell">
                      {event.payload.type}
                      <small>
                        {event.id.slice(0, 8)}
                        {projection.voidedEventIds.includes(event.id)
                          ? ' · corrected'
                          : ''}
                      </small>
                    </td>
                    <td className="table__cell">
                      {formatTimestamp(event.occurredAt)}
                      <small>{event.source}</small>
                    </td>
                    <td className="table__cell">
                      <pre className="factory-event-summary">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                      {event.notes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableSurface>
        </div>
      </details>
    </>
  );
}
