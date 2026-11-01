import type { BeltOpportunity } from '@poe-worksmith/contracts';
import { displayDate } from './marketWorkbench.js';

export function MarketOpportunities({
  rows,
  selectedId,
  onSelect,
}: {
  rows: BeltOpportunity[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <p className="market-footnote">
        Порядок: доступный расчёт, уверенность, ROI, число независимых
        продавцов; при равенстве — меньший приток предложений. Исчезновение
        объявления не означает продажу.
      </p>
      <div className="market-table-scroll">
        <table
          className="market-snapshot-table market-opportunity-table"
          aria-label="Рейтинг возможностей крафта"
        >
          <thead>
            <tr>
              <th>Предмет / билд</th>
              <th>Затраты / диапазон</th>
              <th>Цена предложения</th>
              <th>Разрыв / ROI</th>
              <th>Объявления / продавцы</th>
              <th>Изменение предложения</th>
              <th>Последняя проверка</th>
              <th>Уверенность / пробелы</th>
              <th>Доказательства</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const calc = row.calculation;
              return (
                <tr
                  key={row.targetId}
                  aria-selected={row.targetId === selectedId}
                >
                  <td>
                    <button
                      className="market-link-button"
                      onClick={() => onSelect(row.targetId)}
                    >
                      {row.name}
                    </button>
                    <small className="market-row-meta">
                      {row.league} · {row.patch} · {row.builds.join(', ')}
                    </small>
                  </td>
                  <td>
                    {calc
                      ? `${calc.expectedCraftCost} ${calc.currency}`
                      : 'Нет расчёта'}
                    {calc?.costRange && (
                      <small className="market-row-meta">
                        {calc.costRange.min}–{calc.costRange.max}
                      </small>
                    )}
                  </td>
                  <td>
                    {calc ? `${calc.askingPrice} ${calc.currency}` : '—'}
                    {calc?.askingRange && (
                      <small className="market-row-meta">
                        {calc.askingRange.min}–{calc.askingRange.max}
                      </small>
                    )}
                  </td>
                  <td>
                    {calc ? (
                      <>
                        <strong>
                          {calc.spread} {calc.currency}
                        </strong>
                        <small className="market-row-meta">
                          {calc.roiPercent
                            ? Number(calc.roiPercent).toFixed(1) + '%'
                            : '—'}{' '}
                          ·{' '}
                          {row.economicConclusion === 'POSITIVE'
                            ? 'положительный'
                            : 'неположительный'}
                        </small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {row.comparison?.confirmedListings ?? 0} /{' '}
                    {row.comparison?.independentSellers ?? 0}
                  </td>
                  <td>
                    {row.supply ? (
                      <>
                        +{row.supply.newCount} новых · {row.supply.missingCount}{' '}
                        отсутствуют
                        <small className="market-row-meta">
                          {row.supply.coverage} · ↑{row.supply.increasedCount} /
                          ↓{row.supply.decreasedCount} цен
                        </small>
                      </>
                    ) : (
                      'Нет совместимых повторов'
                    )}
                  </td>
                  <td>
                    {row.capturedAt
                      ? displayDate(row.capturedAt)
                      : 'Нет наблюдения'}
                    <small className="market-row-meta">
                      {row.freshness === 'FRESH'
                        ? 'свежие'
                        : row.freshness === 'STALE'
                          ? 'устарели'
                          : 'нет данных'}{' '}
                      ·{' '}
                      {row.dataKind === 'demo' ? 'DEMO' : (row.dataKind ?? '—')}
                    </small>
                  </td>
                  <td>
                    {row.confidence === 'MEDIUM' ? 'Средняя' : 'Низкая'}
                    <small className="market-row-meta">
                      {row.reasons.join(' ') ||
                        'Расчёт по заявленным допущениям; цена предложения не гарантирует продажу.'}
                    </small>
                  </td>
                  <td>
                    {row.queryUrl && (
                      <a href={row.queryUrl} target="_blank" rel="noreferrer">
                        Trade ↗
                      </a>
                    )}
                    <button
                      className="market-link-button"
                      onClick={() => onSelect(row.targetId)}
                    >
                      Расчёт и наблюдения
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
