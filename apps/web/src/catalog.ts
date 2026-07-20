import type { CatalogEntry } from '@poe-worksmith/contracts';

export type CatalogSort = 'profit' | 'margin' | 'capital' | 'freshness';

export interface CatalogFilters {
  budget: string;
  category: string;
  method: string;
  search: string;
  sort: CatalogSort;
  status: string;
  tag: string;
}

export const defaultCatalogFilters: CatalogFilters = {
  budget: 'all',
  category: 'all',
  method: 'all',
  search: '',
  sort: 'profit',
  status: 'all',
  tag: 'all',
};

export function filterAndSortCatalog(
  entries: CatalogEntry[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  const budget = filters.budget === 'all' ? null : Number(filters.budget);
  const filtered = entries.filter(({ evaluation, recipe }) => {
    const matchesSearch =
      search.length === 0 ||
      `${recipe.title} ${recipe.summary}`.toLocaleLowerCase().includes(search);

    return (
      matchesSearch &&
      (filters.category === 'all' || recipe.category === filters.category) &&
      (filters.method === 'all' || recipe.craftMethod === filters.method) &&
      (filters.tag === 'all' || recipe.tags.includes(filters.tag)) &&
      (filters.status === 'all' || evaluation.status === filters.status) &&
      (budget === null || recipe.minimumCapital.amount <= budget)
    );
  });

  return filtered.sort((left, right) => {
    if (filters.sort === 'capital') {
      const leftCapital =
        left.evaluation.status === 'error'
          ? Number.POSITIVE_INFINITY
          : left.recipe.minimumCapital.amount;
      const rightCapital =
        right.evaluation.status === 'error'
          ? Number.POSITIVE_INFINITY
          : right.recipe.minimumCapital.amount;

      return leftCapital - rightCapital;
    }

    if (filters.sort === 'freshness') {
      return snapshotTimestamp(right) - snapshotTimestamp(left);
    }

    const leftValue =
      filters.sort === 'margin'
        ? left.evaluation.marginPercent
        : left.evaluation.profit?.amount;
    const rightValue =
      filters.sort === 'margin'
        ? right.evaluation.marginPercent
        : right.evaluation.profit?.amount;

    return (
      (rightValue ?? Number.NEGATIVE_INFINITY) -
      (leftValue ?? Number.NEGATIVE_INFINITY)
    );
  });
}

export function snapshotAgeSeconds(entry: CatalogEntry, now: string) {
  if (!entry.snapshot) return null;
  return Math.max(
    0,
    Math.floor(
      (Date.parse(now) - Date.parse(entry.snapshot.capturedAt)) / 1000,
    ),
  );
}

function snapshotTimestamp(entry: CatalogEntry) {
  return entry.snapshot ? Date.parse(entry.snapshot.capturedAt) : 0;
}
