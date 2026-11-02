import type { CatalogEntry, MarketTargetInput } from '@poe-worksmith/contracts';

const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export interface CatalogFilters {
  category: string;
  search: string;
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
  return entries.filter(({ itemPreview, recipe }) => {
    const text =
      `${recipe.title} ${recipe.summary} ${recipe.category} ${itemPreview?.name ?? ''}`.toLocaleLowerCase();
    return (
      (!search || text.includes(search)) &&
      (filters.category === 'all' || recipe.category === filters.category)
    );
  });
}

export function marketTargetItemType(slot: string) {
  const normalized = slot.trim().toLocaleLowerCase();
  return itemTypeBySlot[normalized] ?? normalized.replaceAll(' ', '-');
}

export function marketTargetTitle(target: MarketListTarget) {
  return [target.builds[0], target.baseTypes.join(' / ')]
    .filter(Boolean)
    .join(' — ');
}

export function filterMarketTargets<T extends MarketListTarget>(
  targets: T[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return targets.filter((target) => {
    const itemType = marketTargetItemType(target.slot);
    const text =
      `${marketTargetTitle(target)} ${target.name} ${target.slot} ${target.baseTypes.join(' ')}`.toLocaleLowerCase();
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
