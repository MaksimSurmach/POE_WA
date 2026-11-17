import { useState } from 'react';
import { formatTimestamp } from './dateTime.js';
import { Button, Input, NativeSelect, TableSurface } from './ui.js';
import type {
  CatalogEntry,
  CatalogResponse,
  TrendOverview,
} from '@poe-worksmith/contracts';

import { observedAsk } from './catalog.js';
import { Money, StatusPanel, economicClass } from './components.js';
import { formatPercent } from './PriceTrendChart.js';
import { TurnoverMap } from './TurnoverMap.js';

export function marketRecipePoint(entry: CatalogEntry) {
  const readiness = entry.readiness;
  // Collector asks remain useful before craft costs or profit are verified.
  const price = readiness
    ? readiness.fresh
      ? (readiness.currentAskRange?.min ?? null)
      : null
    : observedAsk(entry);
  return {
    id: entry.recipe.id,
    name: entry.recipe.title,
    price: price && price.amount > 0 ? price : null,
    exits:
      readiness?.fresh && readiness.activityMeasurable
        ? readiness.last24h.inferredExits
        : null,
  };
}

export function RecipeMarketOverview({
  response,
  failed,
  onRetry,
  selectedId,
  trends,
  onSelect,
}: {
  response: CatalogResponse | null;
  failed: boolean;
  onRetry(): void;
  selectedId: string | null;
  trends: TrendOverview | undefined;
  onSelect(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState('activity');
  const entries = [...(response?.data?.entries ?? [])]
    .filter(({ recipe }) =>
      `${recipe.title} ${recipe.craftMethod} ${recipe.category}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => {
      const a = marketRecipePoint(left),
        b = marketRecipePoint(right);
      if (order === 'activity')
        return (
          (b.exits ?? -1) - (a.exits ?? -1) ||
          left.recipe.title.localeCompare(right.recipe.title)
        );
      if (order === 'price') {
        if (!a.price || !b.price)
          return (
            Number(!a.price) - Number(!b.price) || a.name.localeCompare(b.name)
          );
        return (
          a.price.currency.localeCompare(b.price.currency) ||
          a.price.amount - b.price.amount ||
          a.name.localeCompare(b.name)
        );
      }
      return a.name.localeCompare(b.name);
    });
  const points = entries.map(marketRecipePoint);
  const priced = points.filter((point) => point.price !== null);
  const selected = points.find((point) => point.id === selectedId);
  return (
    <section className="recipe-market" aria-label="Обзор рынка всех рецептов">
      <header>
        <h2>Все цели · текущий рынок</h2>
        {response?.data ? (
          <p className="recipe-market__note">
            {entries.length} целей · {priced.length} с наблюдаемыми ценами ·{' '}
            {points.filter((point) => point.exits !== null).length} с измеренной
            активностью. Цены объявлений и их исчезновения не подтверждают
            продажи или прибыль.
          </p>
        ) : null}
      </header>
      {failed || (response && !response.data) ? (
        <StatusPanel title="Обзор рынка недоступен" tone="danger">
          <Button type="button" onClick={onRetry}>
            Повторить загрузку рынка
          </Button>
        </StatusPanel>
      ) : !response ? (
        <StatusPanel title="Загрузка целей" tone="info" />
      ) : !response.data?.league ? (
        <StatusPanel title="Текущая лига неизвестна" tone="warning">
          <Button type="button" onClick={onRetry}>
            Обновить текущий рынок
          </Button>
        </StatusPanel>
      ) : (
        <>
          {response.isStale ? (
            <p className="recipe-warning">
              Stored catalog is outdated. Check collection in Settings.
            </p>
          ) : null}
          {response.data.entries.length === 0 ? (
            <p>No recipes are available yet. Check collection in Settings.</p>
          ) : null}
          {priced.length > 0 &&
          !points.some((point) => (point.exits ?? 0) > 0) ? (
            <p className="market-activity-note" role="status">
              За наблюдаемое окно в 24 часа исчезновений объявлений не
              зафиксировано. Спрос не подтверждён. Для оценки активности нужны
              дополнительные свежие снимки.
            </p>
          ) : null}
          {selected ? (
            <p className="recipe-market__selection" role="status">
              <strong>{selected.name}</strong>
              {' · '}
              {selected.price ? (
                <Money price={selected.price} />
              ) : (
                'Нет актуальной цены'
              )}
              {' · '}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  const heading = document.getElementById(
                    'recipe-price-history',
                  );
                  heading?.scrollIntoView();
                  heading?.focus({ preventScroll: true });
                }}
              >
                Открыть историю цены ↓
              </Button>
            </p>
          ) : (
            <p className="recipe-market__note">
              Выберите рецепт для просмотра истории цен.
            </p>
          )}
          <div className="market-price-controls">
            <label>
              <span>Поиск рыночной цели</span>
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Предмет, метод или класс"
              />
            </label>
            <label>
              <span>Сортировка цен</span>
              <NativeSelect
                value={order}
                onChange={(event) => setOrder(event.target.value)}
              >
                <option value="activity">
                  Больше наблюдаемых исчезновений
                </option>
                <option value="price">Ниже цена объявления · по валютам</option>
                <option value="title">Название рецепта</option>
              </NativeSelect>
            </label>
          </div>
          <details className="recipe-market__recipes" open>
            <summary>
              {entries.length} целей · current prices and activity
            </summary>
            <div
              className="recipe-market__table-scroll"
              tabIndex={0}
              role="region"
              aria-label="All recipe market data"
            >
              <TableSurface>
                <table className="table__content recipe-market__table">
                  <thead className="table__header">
                    <tr className="table__row">
                      <th className="table__column">Рецепт</th>
                      <th className="table__column">Цена объявления</th>
                      <th className="table__column">
                        Изменение цены объявления · {trends?.range ?? '7d'}
                      </th>
                      <th className="table__column">
                        Наблюдаемые исчезновения · 24 часа
                      </th>
                      <th className="table__column">Источники сбора</th>
                    </tr>
                  </thead>
                  <tbody className="table__body">
                    {entries.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          No recipes match this search. Clear the search to see
                          current prices.
                        </td>
                      </tr>
                    ) : null}
                    {entries.map((entry, index) => {
                      const point = points[index]!;
                      const readiness = entry.readiness;
                      const history = trends?.entries.find(
                        (row) => row.recipeId === point.id,
                      )?.summary;
                      const change = history?.change?.percent;
                      return (
                        <tr className="table__row" key={point.id}>
                          <td className="table__cell">
                            <Button
                              type="button"
                              aria-pressed={point.id === selectedId}
                              onClick={() => {
                                onSelect(point.id);
                                document
                                  .getElementById('recipe-price-history')
                                  ?.scrollIntoView({ block: 'start' });
                              }}
                            >
                              {point.name}
                            </Button>
                            <small>
                              {entry.recipe.craftMethod.replaceAll('-', ' ')}
                            </small>
                            <span
                              className="market-mobile-ask"
                              aria-hidden="true"
                            >
                              {point.price ? (
                                <Money price={point.price} />
                              ) : (
                                'Нет актуальной цены'
                              )}{' '}
                              · объявление, не продажа
                            </span>
                          </td>
                          <td
                            className="table__cell"
                            data-label="Цена объявления"
                          >
                            {point.price ? (
                              <Money price={point.price} />
                            ) : (
                              'Нет актуальной цены'
                            )}
                          </td>
                          <td
                            data-label="Ask change"
                            className={`table__cell ${change == null ? 'economic-unknown' : economicClass(change)}`}
                          >
                            {change == null
                              ? history
                                ? 'Insufficient history'
                                : trends
                                  ? 'Нет истории'
                                  : 'History unavailable'
                              : formatPercent(change)}
                          </td>
                          <td
                            className="table__cell"
                            data-label="Listing exits · 24h window"
                          >
                            {point.exits ?? 'Не измерено'}
                            {point.exits !== null && readiness ? (
                              <small>
                                {Math.round(
                                  (readiness.last24h.completeSpanMinutes / 60) *
                                    10,
                                ) / 10}
                                h observed · {readiness.last24h.complete}{' '}
                                complete captures
                              </small>
                            ) : null}
                          </td>
                          <td className="table__cell" data-label="Capture">
                            {readiness ? (
                              <>
                                {readiness.currentListings} listings ·{' '}
                                {readiness.currentSellers} sellers
                                <small>
                                  {readiness.fresh
                                    ? (readiness.coverage ?? 'No capture')
                                    : 'Outdated or missing capture'}
                                  {readiness.capturedAt
                                    ? ` · ${formatTimestamp(readiness.capturedAt)}`
                                    : ''}
                                </small>
                              </>
                            ) : (
                              'Источники сбора недоступны'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableSurface>
            </div>
          </details>
          <details className="market-map-disclosure">
            <summary>График цены и активности объявлений</summary>
            {(['chaos', 'divine'] as const).map((currency) => {
              const items = priced
                .filter((point) => point.price?.currency === currency)
                .map((point) => ({
                  id: point.id,
                  name: point.name,
                  price: point.price!.amount,
                  activity: point.exits,
                }));
              return items.length ? (
                <TurnoverMap
                  key={currency}
                  items={items}
                  currency={currency}
                  activityLabel="Inferred exits · observed window within 24h"
                  activityDescription="inferred exits in the observed window"
                  selected={selectedId}
                  onSelect={onSelect}
                />
              ) : null;
            })}
          </details>
        </>
      )}
    </section>
  );
}
