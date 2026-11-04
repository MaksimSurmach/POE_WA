import type { CatalogEntry } from '@poe-worksmith/contracts';
import { Link } from 'react-router-dom';

import {
  type CatalogFilters,
  formatMarginPercent,
  getPriceStatus,
} from './catalog.js';
import { Money, ProfitBadge, economicClass } from './components.js';
import { ItemTooltip } from './ItemTooltip.js';

const columns = [
  ['title', 'Item name'],
  ['category', 'Item class'],
  ['cost', 'Expected cost'],
  ['ask', 'Cheapest ask'],
  ['profit', 'Profit'],
  ['roi', 'ROI'],
  ['freshness', 'Market evidence'],
] as const;

const observedAt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function CatalogTable({
  entries,
  filters,
  onSort,
}: {
  entries: CatalogEntry[];
  filters: CatalogFilters;
  onSort: (sort: NonNullable<CatalogFilters['sort']>) => void;
}) {
  const sort = filters.sort ?? 'title';
  const direction =
    filters.direction ??
    (['title', 'category', 'cost'].includes(sort) ? 'asc' : 'desc');
  return (
    <div
      className="catalog-table-scroll"
      role="region"
      aria-label="Crafting targets table, scroll for more columns"
      tabIndex={0}
    >
      <table className="craft-table" aria-describedby="catalog-price-note">
        <caption className="visually-hidden">
          Crafting targets. Click a column header to sort; click again to
          reverse.
        </caption>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th
                key={key}
                scope="col"
                aria-sort={
                  sort === key
                    ? direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button type="button" onClick={() => onSort(key)}>
                  {label}
                  <svg
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    className="sort-icon"
                  >
                    <path
                      d="m4 6 4-4 4 4"
                      opacity={sort === key && direction === 'asc' ? 1 : 0.4}
                    />
                    <path
                      d="m4 10 4 4 4-4"
                      opacity={sort === key && direction === 'desc' ? 1 : 0.4}
                    />
                  </svg>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const { recipe, evaluation, snapshot } = entry;
            const source = evaluation.source ?? snapshot;
            const sellers =
              evaluation.source?.comparableSellers ??
              (snapshot
                ? new Set(snapshot.listings.map((listing) => listing.seller))
                    .size
                : null);
            return (
              <tr key={recipe.id}>
                <th scope="row">
                  <div className="craft-table__identity">
                    {entry.itemPreview ? (
                      <ItemTooltip item={entry.itemPreview} />
                    ) : (
                      <span
                        className="craft-table__missing-art"
                        aria-hidden="true"
                      >
                        {recipe.category.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div>
                      <Link to={`/recipes/${recipe.id}`}>{recipe.title}</Link>
                      <small>Patch {recipe.patch ?? 'unverified'}</small>
                    </div>
                  </div>
                </th>
                <td className="craft-table__class">
                  {recipe.category.replaceAll('-', ' ')}
                </td>
                <td>
                  <Money price={evaluation.expectedCraftCost} />
                </td>
                <td>
                  <Money price={evaluation.estimatedSalePrice} />
                </td>
                <td>
                  {evaluation.profit ? (
                    <ProfitBadge {...evaluation.profit} />
                  ) : (
                    <span aria-label="Profit unavailable">—</span>
                  )}
                </td>
                <td className={economicClass(evaluation.marginPercent)}>
                  {evaluation.marginPercent === null ? (
                    <span aria-label="ROI unavailable">—</span>
                  ) : (
                    formatMarginPercent(evaluation.marginPercent)
                  )}
                </td>
                <td className="craft-table__evidence">
                  <span>
                    {getPriceStatus(evaluation.status)}
                    {sellers !== null
                      ? ` · ${sellers} ${sellers === 1 ? 'seller' : 'sellers'}`
                      : ''}
                  </span>
                  {sellers === 1 ? (
                    <small className="recipe-warning">
                      Single ask · ROI withheld
                    </small>
                  ) : null}
                  {source ? (
                    <>
                      <small>
                        {source.coverage} coverage ·{' '}
                        {evaluation.confidence ?? 'unknown'} confidence
                      </small>
                      <time dateTime={source.capturedAt}>
                        {observedAt.format(new Date(source.capturedAt))}
                      </time>
                    </>
                  ) : (
                    <small>Source details unavailable</small>
                  )}
                </td>
              </tr>
            );
          })}
          {entries.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="craft-table__empty">
                No items match these filters. Adjust the limits or reset
                filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
