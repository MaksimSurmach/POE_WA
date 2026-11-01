import { Fragment, type ReactNode } from 'react';
import type { BeltOpportunity } from '@poe-worksmith/contracts';
import { displayDate, displayPrice } from './marketWorkbench.js';

export function MarketOpportunities({
  rows,
  selectedId,
  onSelect,
  renderDetails,
}: {
  rows: BeltOpportunity[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderDetails: (row: BeltOpportunity) => ReactNode;
}) {
  return (
    <div className="market-table-scroll">
      <table
        className="market-snapshot-table market-opportunity-table"
        aria-label="Рейтинг возможностей крафта"
      >
        <thead>
          <tr>
            <th>Предмет / билд</th>
            <th>Крафт</th>
            <th>Рынок · медиана</th>
            <th>Разница / ROI</th>
            <th>Объявления / продавцы</th>
            <th>Проверено</th>
            <th>Trade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const calc = row.calculation;
            const distribution = row.comparison?.askingDistribution;
            const expanded = selectedId === row.targetId;
            return (
              <Fragment key={row.targetId}>
                <tr className={expanded ? 'is-expanded' : undefined}>
                  <td>
                    <button
                      type="button"
                      className="market-opportunity-title"
                      aria-expanded={expanded}
                      aria-controls={`opportunity-${row.targetId}`}
                      onClick={() => onSelect(expanded ? '' : row.targetId)}
                    >
                      <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                      {row.name}
                    </button>
                    <small className="market-row-meta">
                      {row.builds.join(', ')} · {row.patch}
                    </small>
                  </td>
                  <td>
                    {calc
                      ? displayPrice(
                          Number(calc.expectedCraftCost),
                          calc.currency as 'chaos' | 'divine',
                        )
                      : 'Нет оценки'}
                    {calc?.costRange && (
                      <small className="market-row-meta">
                        {calc.costRange.min}–{calc.costRange.max}
                      </small>
                    )}
                  </td>
                  <td>
                    {distribution && row.comparison
                      ? displayPrice(
                          distribution.median,
                          row.comparison.currency,
                        )
                      : calc
                        ? `${calc.askingPrice} ${calc.currency}`
                        : '—'}
                    {distribution && row.comparison && (
                      <small className="market-row-meta">
                        {displayPrice(
                          distribution.min,
                          row.comparison.currency,
                        )}{' '}
                        –{' '}
                        {displayPrice(
                          distribution.max,
                          row.comparison.currency,
                        )}
                      </small>
                    )}
                  </td>
                  <td
                    className={
                      row.economicConclusion === 'POSITIVE'
                        ? 'market-positive'
                        : row.economicConclusion === 'NON_POSITIVE'
                          ? 'market-negative'
                          : undefined
                    }
                  >
                    {calc ? `${calc.spread} ${calc.currency}` : '—'}
                    {calc && (
                      <small className="market-row-meta">
                        {calc.roiPercent === undefined
                          ? '—'
                          : `${Number(calc.roiPercent).toFixed(1)}%`}
                      </small>
                    )}
                  </td>
                  <td>
                    {row.comparison?.confirmedListings ?? 0} /{' '}
                    {row.comparison?.independentSellers ?? 0}
                    <small className="market-row-meta">
                      {row.supply
                        ? `+${row.supply.newCount} новых · ${row.supply.missingCount} отсутствуют`
                        : 'Нет повторной выборки'}
                    </small>
                  </td>
                  <td>
                    {row.capturedAt
                      ? displayDate(row.capturedAt)
                      : 'Нет наблюдения'}
                    <small className="market-row-meta">
                      {row.dataKind === 'demo'
                        ? 'DEMO'
                        : row.freshness === 'FRESH'
                          ? 'Свежие данные'
                          : row.freshness === 'STALE'
                            ? 'Старше 24 ч'
                            : 'Нужна проверка'}
                    </small>
                  </td>
                  <td>
                    {row.queryUrl ? (
                      <a
                        className="market-trade-link"
                        href={row.queryUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Trade: ${row.name}`}
                      >
                        Trade ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr className="market-opportunity-detail">
                    <td colSpan={7}>
                      <div
                        id={`opportunity-${row.targetId}`}
                        role="region"
                        aria-label={`Детали: ${row.name}`}
                      >
                        {renderDetails(row)}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
