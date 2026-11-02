import type { CatalogEntry } from '@poe-worksmith/contracts';

export interface CatalogFilters {
  category: string;
  search: string;
}

export const defaultCatalogFilters: CatalogFilters = {
  category: 'all',
  search: '',
};

export function filterCatalog(
  entries: CatalogEntry[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return entries.filter(({ itemPreview, recipe }) => {
    const text =
      `${recipe.title} ${recipe.summary} ${recipe.category} ${itemPreview?.name ?? ''}`.toLocaleLowerCase();
    return (
      (!search || text.includes(search)) &&
      (filters.category === 'all' || recipe.category === filters.category)
    );
  });
}

export function getPriceStatus(
  status: CatalogEntry['evaluation']['status'],
  lastSuccessfulAt: string | null,
  now: number,
) {
  const ageHours = lastSuccessfulAt
    ? (now - Date.parse(lastSuccessfulAt)) / 3_600_000
    : null;

  // shortcut: freshness follows the default four-hour refresh cadence; use server cadence if deployments diverge.
  if (
    status === 'stale' ||
    (status === 'success' && ageHours !== null && ageHours > 4)
  ) {
    return 'Outdated';
  }

  return {
    success: 'Current',
    stale: 'Outdated',
    loading: 'Updating',
    partial: 'Partial',
    error: 'Unavailable',
  }[status];
}
