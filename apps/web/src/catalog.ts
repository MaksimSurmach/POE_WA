import type { CatalogEntry } from '@poe-worksmith/contracts';

const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

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

export function getPriceStatus(status: CatalogEntry['evaluation']['status']) {
  return {
    success: 'Updated',
    stale: 'Outdated',
    loading: 'Updating',
    partial: 'Partial',
    error: 'Unavailable',
  }[status];
}

export function formatMarginPercent(value: number) {
  const rounded = Number(value.toFixed(1));
  return `${percentFormatter.format(Object.is(rounded, -0) ? 0 : rounded)}%`;
}
