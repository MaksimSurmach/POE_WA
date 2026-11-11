import { Button, NativeSelect, TableSurface } from './ui.js';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import {
  type CatalogFilters,
  evidenceRank,
  formatMarginPercent,
  getPriceStatus,
  observedAsk,
  groupByTarget,
} from './catalog.js';
import { Money, ProfitBadge, economicClass } from './components.js';
import { ItemTooltip } from './ItemTooltip.js';
import {
  isSingleSellerHypothesis,
  readinessLabels,
} from './MarketReadiness.js';

const columns = [
  ['title', 'Item name'],
  ['category', 'Item class'],
  ['cost', 'Expected cost'],
  ['ask', 'Observed ask'],
  ['profit', 'Profit'],
  ['roi', 'ROI'],
  ['freshness', 'Market evidence'],
] as const;

const evidenceGroups = [
  'Preliminary candidates',
  'Comparable asks · activity or cost gates pending',
  'Price hypotheses and targets with insufficient observations',
];

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
  const grouped = groupByTarget(entries);
  const byReadiness = entries.some((entry) => entry.readiness !== undefined);
  const rank = (entry: CatalogEntry) => (byReadiness ? evidenceRank(entry) : 0);
  const rows = grouped
    .sort((a, b) => rank(a[0]!) - rank(b[0]!))
    .flatMap((group) =>
      group.map((entry, index) => ({
        entry,
        index,
        methods: group.length,
        rank: rank(group[0]!),
      })),
    );
  return (
    <div
      className="catalog-table-scroll"
      role="region"
      aria-label="Crafting targets"
    >
      <div className="catalog-mobile-sort">
        <label>
          <span>Sort by</span>
          <NativeSelect
            value={sort}
            onChange={(event) => {
              const column = columns.find(
                ([key]) => key === event.target.value,
              );
              if (column) onSort(column[0]);
            }}
          >
            {columns.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button
          type="button"
          aria-label={`Sort direction: ${direction === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`}
          onClick={() => onSort(sort)}
        >
          {direction === 'asc' ? 'Ascending ↑' : 'Descending ↓'}
        </Button>
      </div>
      <TableSurface>
        <table
          className="table__content craft-table"
          aria-describedby="catalog-price-note"
        >
          <caption className="visually-hidden">
            Crafting targets with costs, observed asks, profit, ROI and market
            evidence.
          </caption>
          <thead className="table__header">
            <tr className="table__row">
              {columns.map(([key, label]) => (
                <th
                  className="table__column"
                  key={key}
                  scope="col"
                  aria-label={label}
                  aria-sort={
                    sort === key
                      ? direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <Button type="button" onClick={() => onSort(key)}>
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
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="table__body">
            {rows.map(({ entry, index, methods, rank }, rowIndex) => {
              const { recipe, evaluation, snapshot, readiness } = entry;
              const sampleAsk =
                !evaluation.estimatedSalePrice && observedAsk(entry);
              const source =
                evaluation.source ??
                snapshot ??
                (readiness?.capturedAt
                  ? {
                      capturedAt: readiness.capturedAt,
                      coverage: readiness.coverage,
                    }
                  : null);
              const gradeReasons = evaluation.gradeReasons?.join(' · ');
              const showWithheld =
                evaluation.profit === null && evaluation.marginPercent === null;
              const sellers =
                evaluation.source?.comparableSellers ??
                (snapshot
                  ? new Set(snapshot.listings.map((listing) => listing.seller))
                      .size
                  : (readiness?.currentSellers ?? null));
              return (
                <Fragment key={recipe.id}>
                  {byReadiness && rows[rowIndex - 1]?.rank !== rank ? (
                    <tr className="table__row craft-table__readiness-group">
                      <th className="table__column" colSpan={columns.length}>
                        {evidenceGroups[rank]}
                      </th>
                    </tr>
                  ) : null}
                  <tr
                    data-readiness-level={readiness?.level}
                    className={`table__row ${index ? 'craft-table__alternative' : ''}`}
                  >
                    <th className="table__column" scope="row">
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
                          <Link to={`/recipes/${recipe.id}`}>
                            {recipe.title}
                          </Link>
                          <small>
                            <span className="craft-table__mobile-class">
                              {recipe.category.replaceAll('-', ' ')} ·{' '}
                            </span>
                            {methods > 1
                              ? index
                                ? 'Other method · '
                                : `${!byReadiness && evaluation.profit ? 'Best of ' : ''}${methods} methods · `
                              : null}
                            {recipe.craftMethod.replaceAll('-', ' ')} · Patch{' '}
                            {recipe.patch ?? 'unverified'}
                          </small>
                          {readiness ? (
                            <small>
                              {readinessLabels[readiness.level]}
                              {isSingleSellerHypothesis(readiness)
                                ? ' · Single-seller price hypothesis'
                                : ''}
                            </small>
                          ) : null}
                        </div>
                      </div>
                    </th>
                    <td className="table__cell craft-table__class">
                      {recipe.category.replaceAll('-', ' ')}
                    </td>
                    <td className="table__cell" data-label="Expected cost">
                      <Money price={evaluation.expectedCraftCost} />
                      {evaluation.budget ? (
                        <small>
                          budget for one: p50{' '}
                          <Money price={evaluation.budget.p50} /> · p90{' '}
                          <Money price={evaluation.budget.p90} />
                        </small>
                      ) : null}
                    </td>
                    <td className="table__cell" data-label="Observed ask">
                      <Money price={observedAsk(entry)} />
                      {sampleAsk ? (
                        <small>Priced sample · ROI withheld</small>
                      ) : null}
                    </td>
                    <td className="table__cell" data-label="Profit">
                      {evaluation.profit ? (
                        <ProfitBadge {...evaluation.profit} />
                      ) : (
                        <span aria-label="Profit unavailable">—</span>
                      )}
                      {evaluation.grade ? (
                        <small
                          title={gradeReasons}
                          aria-label={`Evidence grade ${evaluation.grade}`}
                        >
                          {evaluation.grade}
                        </small>
                      ) : null}
                    </td>
                    <td
                      data-label="ROI"
                      className={`table__cell ${economicClass(evaluation.marginPercent)}`}
                    >
                      {evaluation.marginPercent === null ? (
                        <span aria-label="ROI unavailable">—</span>
                      ) : (
                        formatMarginPercent(evaluation.marginPercent)
                      )}
                    </td>
                    <td
                      data-label="Market evidence"
                      className="table__cell craft-table__evidence"
                    >
                      <span>
                        {evaluation.status === 'loading'
                          ? sampleAsk
                            ? 'Price observed · evaluation pending'
                            : 'Awaiting output observation'
                          : getPriceStatus(evaluation.status)}
                        {sellers !== null
                          ? ` · ${sellers} ${sellers === 1 ? 'seller' : 'sellers'}`
                          : ''}
                      </span>
                      {sellers === 1 &&
                      !evaluation.grade &&
                      !evaluation.profitBlockedReason &&
                      showWithheld ? (
                        <small className="recipe-warning">
                          Single ask · ROI withheld
                        </small>
                      ) : null}
                      {gradeReasons ? <small>{gradeReasons}</small> : null}
                      {showWithheld && evaluation.profitBlockedReason ? (
                        <small className="recipe-warning">
                          ROI withheld: {evaluation.profitBlockedReason}
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
                      ) : evaluation.status !== 'loading' ? (
                        <small>Source details unavailable</small>
                      ) : null}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {entries.length === 0 ? (
              <tr className="table__row">
                <td
                  colSpan={columns.length}
                  className="table__cell craft-table__empty"
                >
                  No items match these filters. Adjust the limits or reset
                  filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableSurface>
    </div>
  );
}
