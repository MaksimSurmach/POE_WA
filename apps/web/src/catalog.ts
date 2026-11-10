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
  sort?: 'title' | 'category' | 'cost' | 'ask' | 'profit' | 'roi' | 'freshness';
  direction?: 'asc' | 'desc';
  minProfit?: string;
  profitCurrency?: Price['currency'];
  minRoi?: string;
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
  sort: 'profit',
};

/**
 * Groups already-sorted entries by exact target signature. Groups keep the
 * position of their first entry; inside a group the best valid profit leads.
 */
export function groupByTarget(entries: CatalogEntry[]) {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.recipe.targetSignature);
    if (group) group.push(entry);
    else groups.set(entry.recipe.targetSignature, [entry]);
  }
  return [...groups.values()].map((group) => {
    const best = group.reduce((lead, entry) => {
      const current = lead.evaluation.profit;
      const candidate = entry.evaluation.profit;
      // Never compare nominal amounts in different currencies.
      return candidate &&
        (!current ||
          (current.currency === candidate.currency &&
            candidate.amount > current.amount))
        ? entry
        : lead;
    });
    return [best, ...group.filter((entry) => entry !== best)];
  });
}

export function readCatalogFilters(params: URLSearchParams): CatalogFilters {
  const sort = params.get('sort');
  const direction = params.get('direction');
  return {
    category: params.get('category') || 'all',
    search: params.get('search') ?? '',
    tag: params.get('tag') ?? 'all',
    sort:
      sort &&
      [
        'title',
        'category',
        'cost',
        'ask',
        'profit',
        'roi',
        'freshness',
      ].includes(sort)
        ? (sort as NonNullable<CatalogFilters['sort']>)
        : 'profit',
    ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
    minProfit: params.get('minProfit') ?? '',
    profitCurrency:
      params.get('profitCurrency') === 'divine' ? 'divine' : 'chaos',
    minRoi: params.get('minRoi') ?? '',
  };
}

export function filterCatalog(
  entries: CatalogEntry[],
  filters: CatalogFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  const minimum = (value: string | undefined) =>
    value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  const minProfit = minimum(filters.minProfit);
  const minRoi = minimum(filters.minRoi);
  const sort = filters.sort ?? 'title';
  const direction =
    filters.direction ??
    (['title', 'category', 'cost'].includes(sort) ? 'asc' : 'desc');
  return entries
    .filter(({ itemPreview, recipe, evaluation }) => {
      const text =
        `${recipe.title} ${recipe.summary} ${recipe.category} ${recipe.craftMethod} ${recipe.tags.join(' ')} ${itemPreview?.name ?? ''}`.toLocaleLowerCase();
      return (
        (!search || text.includes(search)) &&
        (filters.category === 'all' || recipe.category === filters.category) &&
        (!filters.tag ||
          filters.tag === 'all' ||
          recipe.tags.includes(filters.tag)) &&
        (minProfit === null ||
          (evaluation.profit !== null &&
            evaluation.profit.currency ===
              (filters.profitCurrency ?? 'chaos') &&
            evaluation.profit.amount >= minProfit)) &&
        (minRoi === null ||
          (evaluation.marginPercent !== null &&
            evaluation.marginPercent >= minRoi))
      );
    })
    .sort((a, b) => {
      const byTitle = a.recipe.title.localeCompare(b.recipe.title);
      if (sort === 'title' || sort === 'category') {
        const order =
          sort === 'title'
            ? byTitle
            : a.recipe.category.localeCompare(b.recipe.category);
        return (direction === 'asc' ? order : -order) || byTitle;
      }
      const money = (e: CatalogEntry) =>
        sort === 'cost'
          ? e.evaluation.expectedCraftCost
          : sort === 'ask'
            ? e.evaluation.estimatedSalePrice
            : e.evaluation.profit;
      const value = (e: CatalogEntry) =>
        sort === 'roi'
          ? e.evaluation.marginPercent
          : sort === 'freshness'
            ? e.evaluation.source || e.snapshot
              ? Date.parse((e.evaluation.source ?? e.snapshot)!.capturedAt)
              : null
            : (money(e)?.amount ?? null);
      const left = value(a),
        right = value(b);
      if (left === null) return right === null ? byTitle : 1;
      if (right === null) return -1;
      // Never compare nominal amounts in different currencies.
      if (sort === 'cost' || sort === 'profit' || sort === 'ask') {
        const lc = money(a)?.currency,
          rc = money(b)?.currency;
        if (lc !== rc) return (lc ?? '').localeCompare(rc ?? '');
      }
      return (direction === 'asc' ? left - right : right - left) || byTitle;
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
