import { useEffect, useState, type ReactNode } from 'react';
import type {
  FactoryInventoryResponse,
  FactorySalesResponse,
} from '@poe-worksmith/contracts';
import { createApiClient } from './apiClient.js';
import { Button, NativeSelect, TableSurface } from './ui.js';
import { StatusPanel } from './components.js';
import { factoryMoney } from './FactorySummary.js';
import { formatTimestamp } from './dateTime.js';
import { WorkspaceLink as Link } from './workspaceNavigation.js';

const api = createApiClient();
export function FactoryLedgerView({
  league,
  sales,
  revision,
}: {
  league: string;
  sales: boolean;
  revision: number;
}) {
  const [inventory, setInventory] = useState<
    FactoryInventoryResponse['data'] | null
  >(null);
  const [saleData, setSaleData] = useState<FactorySalesResponse['data'] | null>(
    null,
  );
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState('all');
  useEffect(() => {
    setInventory(null);
    setSaleData(null);
    setError('');
    if (!league) return;
    let active = true;
    void (
      sales
        ? api.getFactorySales(league).then((response) => {
            if (active) setSaleData(response.data);
          })
        : api.getFactoryInventory(league).then((response) => {
            if (active) setInventory(response.data);
          })
    ).catch((cause: unknown) => {
      if (active)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось прочитать журнал.',
        );
    });
    return () => {
      active = false;
    };
  }, [league, sales, revision, retry]);
  const data = sales ? saleData : inventory;
  if (error)
    return (
      <StatusPanel tone="danger" title="Журнал недоступен">
        {error}
        <Button onClick={() => setRetry((value) => value + 1)}>
          Повторить
        </Button>
      </StatusPanel>
    );
  if (!league) return <StatusPanel tone="info" title="Выберите лигу" />;
  if (!data)
    return <StatusPanel tone="info" title="Загрузка журнала мастерской" />;
  const items =
    inventory?.items.filter(
      (item) => status === 'all' || item.status === status,
    ) ?? [];
  return (
    <section>
      <h2>{sales ? 'Подтверждённые продажи' : 'Инвентарь мастерской'}</h2>
      <p className="catalog-price-note">
        {league} · {data.coverage.includedBatches} из{' '}
        {data.coverage.totalBatches} партий. Себестоимость и курс сохранены в
        событиях.
      </p>
      {!data.coverage.complete ? (
        <p className="recipe-warning">
          Неполное покрытие: показаны не все партии.
        </p>
      ) : null}
      {sales ? (
        <>
          <p className="catalog-price-note">
            Прибыль рассчитана доменным журналом: подтверждённая выручка −
            отнесённая себестоимость − расходы продажи. При неполном
            распределении затрат результат предварительный.
          </p>
          {saleData?.sales.length ? (
            <LedgerTable
              name="Продажи"
              columns={[
                'Предмет / партия',
                'Подтверждено',
                'Выручка',
                'Себестоимость',
                'Расходы',
                'Реализованная прибыль',
              ]}
            >
              {saleData.sales.map((sale) => (
                <tr key={sale.eventId}>
                  <th scope="row">
                    <Link
                      to={`/factory?view=batch&batch=${sale.batchId}&league=${encodeURIComponent(league)}&recipe=${encodeURIComponent(sale.recipeId)}`}
                    >
                      {sale.itemId.slice(0, 8)} · {sale.batchId.slice(0, 8)}
                    </Link>
                  </th>
                  <td>{formatTimestamp(sale.soldAt)}</td>
                  <td>{factoryMoney(sale.revenue)}</td>
                  <td>{factoryMoney(sale.allocatedCost)}</td>
                  <td>{factoryMoney(sale.transactionExpenses)}</td>
                  <td>{factoryMoney(sale.realizedProfit)}</td>
                </tr>
              ))}
            </LedgerTable>
          ) : (
            <StatusPanel tone="info" title="Подтверждённых продаж пока нет">
              Откройте партию и зарегистрируйте фактическую продажу через форму
              событий. Исчезновение объявления продажей не считается.
            </StatusPanel>
          )}
        </>
      ) : (
        <>
          <label className="plan-count">
            Статус предмета
            <NativeSelect
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">Все статусы</option>
              {[
                'held',
                'listed',
                'sold',
                'consumed',
                'recycled',
                'discarded',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </NativeSelect>
          </label>
          {items.length ? (
            <LedgerTable
              name="Предметы"
              columns={[
                'Предмет',
                'Статус',
                'Себестоимость',
                'Партия',
                'Произведён',
              ]}
            >
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    {item.description}
                    <small>{item.id.slice(0, 8)}</small>
                  </th>
                  <td>{item.status}</td>
                  <td>{factoryMoney(item.allocatedCost)}</td>
                  <td>
                    <Link
                      to={`/factory?view=batch&batch=${item.batchId}&league=${encodeURIComponent(league)}&recipe=${encodeURIComponent(item.recipeId)}`}
                    >
                      {item.batchId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{formatTimestamp(item.producedAt)}</td>
                </tr>
              ))}
            </LedgerTable>
          ) : (
            <StatusPanel tone="info" title="Нет предметов с выбранным статусом">
              Произведённые предметы появляются после подтверждения события в
              партии.
            </StatusPanel>
          )}
        </>
      )}
    </section>
  );
}
function LedgerTable({
  name,
  columns,
  children,
}: {
  name: string;
  columns: string[];
  children: ReactNode;
}) {
  return (
    <div className="data-scroll" role="region" aria-label={name} tabIndex={0}>
      <TableSurface>
        <table className="table__content factory-table">
          <thead>
            <tr>
              {columns.map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </TableSurface>
    </div>
  );
}
