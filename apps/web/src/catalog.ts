import type { CatalogEntry } from '@poe-worksmith/contracts';

export interface CatalogFilters {
  search: string;
  tag: string;
}

export const defaultCatalogFilters: CatalogFilters = { search: '', tag: 'all' };

export function filterCatalog(
  entries: CatalogEntry[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return entries.filter(({ itemPreview, recipe }) => {
    const text =
      `${recipe.title} ${recipe.summary} ${itemPreview?.name ?? ''} ${recipe.tags.join(' ')}`.toLocaleLowerCase();
    return (
      (!search || text.includes(search)) &&
      (filters.tag === 'all' || recipe.tags.includes(filters.tag))
    );
  });
}
