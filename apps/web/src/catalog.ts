import type {
  CatalogEntry,
  MarketTargetInput,
  Price,
} from '@poe-worksmith/contracts';

const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export interface CatalogFilters {
  category: string;
  search: string;
  tag?: string;
  sort?: 'title' | 'cost' | 'profit' | 'roi' | 'freshness';
}

export type MarketListTarget = Pick<
  MarketTargetInput,
  'baseTypes' | 'builds' | 'name' | 'slot' | 'sources'
>;

const itemTypeBySlot: Record<string, string> = {
  amulet: 'amulet',
  belt: 'belt',
  boots: 'boots',
  'body armour': 'body-armour',
  'body-armour': 'body-armour',
  gloves: 'gloves',
  helmet: 'helmet',
  jewel: 'jewel',
  quiver: 'quiver',
  ring: 'ring',
  shield: 'shield',
  weapon: 'weapon',
  амулет: 'amulet',
  ботинки: 'boots',
  пояс: 'belt',
  кольцо: 'ring',
  самоцвет: 'jewel',
  щит: 'shield',
  'кластерный самоцвет': 'cluster-jewel',
  жезл: 'weapon',
  колчан: 'quiver',
  лук: 'weapon',
  нагрудник: 'body-armour',
  перчатки: 'gloves',
  шлем: 'helmet',
};

export const defaultCatalogFilters: CatalogFilters = {
  category: 'all',
  search: '',
};

export function filterCatalog(
  entries: CatalogEntry[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return entries
    .filter(({ itemPreview, recipe }) => {
      const text =
        `${recipe.title} ${recipe.summary} ${recipe.category} ${recipe.craftMethod} ${recipe.tags.join(' ')} ${itemPreview?.name ?? ''}`.toLocaleLowerCase();
      return (
        (!search || text.includes(search)) &&
        (filters.category === 'all' || recipe.category === filters.category) &&
        (!filters.tag ||
          filters.tag === 'all' ||
          recipe.tags.includes(filters.tag))
      );
    })
    .sort((a, b) => {
      if (!filters.sort || filters.sort === 'title')
        return a.recipe.title.localeCompare(b.recipe.title);
      const value = (e: CatalogEntry) =>
        filters.sort === 'cost'
          ? (e.evaluation.expectedCraftCost?.amount ?? null)
          : filters.sort === 'profit'
            ? (e.evaluation.profit?.amount ?? null)
            : filters.sort === 'roi'
              ? e.evaluation.marginPercent
              : e.snapshot
                ? Date.parse(e.snapshot.capturedAt)
                : null;
      const left = value(a),
        right = value(b);
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      // Never compare nominal amounts in different currencies.
      if (filters.sort === 'cost' || filters.sort === 'profit') {
        const lc = a.evaluation.expectedCraftCost?.currency,
          rc = b.evaluation.expectedCraftCost?.currency;
        if (lc !== rc) return (lc ?? '').localeCompare(rc ?? '');
      }
      return filters.sort === 'cost' ? left - right : right - left;
    });
}

export function marketTargetItemType(slot: string) {
  const normalized = slot.trim().toLocaleLowerCase();
  return itemTypeBySlot[normalized] ?? normalized.replaceAll(' ', '-');
}

export function marketTargetTitle(target: MarketListTarget) {
  return target.baseTypes.join(' / ');
}

export function lowestAskInCurrency(
  snapshot: CatalogEntry['snapshot'],
  currency: Price['currency'] | null,
) {
  if (!snapshot || !currency) return undefined;
  return snapshot.listings.reduce<
    (typeof snapshot.listings)[number] | undefined
  >(
    (lowest, listing) =>
      listing.price.currency === currency &&
      (!lowest || listing.price.amount < lowest.price.amount)
        ? listing
        : lowest,
    undefined,
  );
}

export function filterMarketTargets<T extends MarketListTarget>(
  targets: T[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return targets.filter((target) => {
    const itemType = marketTargetItemType(target.slot);
    const text =
      `${marketTargetTitle(target)} ${target.name} ${target.slot} ${target.baseTypes.join(' ')} ${target.builds.join(' ')}`.toLocaleLowerCase();
    return (
      (!search || text.includes(search)) &&
      (filters.category === 'all' || itemType === filters.category)
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
