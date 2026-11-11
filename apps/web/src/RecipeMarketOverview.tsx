import { Button, TableSurface } from './ui.js';
import type {
  CatalogEntry,
  CatalogResponse,
  TrendOverview,
} from '@poe-worksmith/contracts';

import { observedAsk } from './catalog.js';
import { Money, StatusPanel, economicClass } from './components.js';
import { formatUtc, formatPercent } from './PriceTrendChart.js';
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
  const entries = response?.data?.entries ?? [];
  const points = entries.map(marketRecipePoint);
  const priced = points.filter((point) => point.price !== null);
  const selected = points.find((point) => point.id === selectedId);
  return (
    <section className="recipe-market" aria-label="All recipes market overview">
      <header>
        <h2>All recipes · current market</h2>
        <p className="recipe-market__note">
          {entries.length} recipes · {priced.length} with observed asks ·{' '}
          {points.filter((point) => point.exits !== null).length} with
          measurable activity. Asking prices and inferred listing exits, not
          confirmed sales or profit.
        </p>
      </header>
      {failed || (response && !response.data) ? (
        <StatusPanel title="Market overview unavailable" tone="danger">
          <Button type="button" onClick={onRetry}>
            Retry market overview
          </Button>
        </StatusPanel>
      ) : !response ? (
        <StatusPanel title="Loading all recipes" tone="info" />
      ) : !response.data?.league ? (
        <StatusPanel title="Current market league unresolved" tone="warning">
          <Button type="button" onClick={onRetry}>
            Reload current market
          </Button>
        </StatusPanel>
      ) : (
        <>
          {response.isStale ? (
            <p className="recipe-warning">
              Stored catalog is outdated. Check collection on Craft
              opportunities.
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p>
              No recipes are available yet. Check collection on Craft
              opportunities.
            </p>
          ) : null}
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
          {selected ? (
            <p className="recipe-market__selection" role="status">
              <strong>{selected.name}</strong>
              {' · '}
              {selected.price ? (
                <Money price={selected.price} />
              ) : (
                'No fresh ask'
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
                View recipe price history ↓
              </Button>
            </p>
          ) : (
            <p className="recipe-market__note">
              Select a point or recipe to inspect its history. The overview
              stays visible.
            </p>
          )}
          <details className="recipe-market__recipes">
            <summary>
              All {entries.length} recipes · prices, activity and collection
              status
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
                      <th className="table__column">Recipe</th>
                      <th className="table__column">Observed ask</th>
                      <th className="table__column">
                        Recorded ask change · {trends?.range ?? '7d'}
                      </th>
                      <th className="table__column">
                        Inferred exits · 24h window
                      </th>
                      <th className="table__column">Collection evidence</th>
                    </tr>
                  </thead>
                  <tbody className="table__body">
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
                              onClick={() => onSelect(point.id)}
                            >
                              {point.name}
                            </Button>
                          </td>
                          <td className="table__cell">
                            {point.price ? (
                              <Money price={point.price} />
                            ) : (
                              'No fresh ask'
                            )}
                          </td>
                          <td
                            className={`table__cell ${change == null ? 'economic-unknown' : economicClass(change)}`}
                          >
                            {change == null
                              ? history
                                ? 'Insufficient history'
                                : trends
                                  ? 'No history'
                                  : 'History unavailable'
                              : formatPercent(change)}
                          </td>
                          <td className="table__cell">
                            {point.exits ?? 'Not measurable'}
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
                          <td className="table__cell">
                            {readiness ? (
                              <>
                                {readiness.currentListings} listings ·{' '}
                                {readiness.currentSellers} sellers
                                <small>
                                  {readiness.fresh
                                    ? (readiness.coverage ?? 'No capture')
                                    : 'Outdated or missing capture'}
                                  {readiness.capturedAt
                                    ? ` · ${formatUtc(readiness.capturedAt)}`
                                    : ''}
                                </small>
                              </>
                            ) : (
                              'Collection evidence unavailable'
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
        </>
      )}
    </section>
  );
}
