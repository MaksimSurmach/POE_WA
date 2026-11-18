import type { CatalogEntry, Price } from '@poe-worksmith/contracts';
import type { CraftFamily } from '@poe-worksmith/domain';
import { lowestAskInCurrency, observedAsk } from './catalog.js';

const craftFamilyLabels: Record<CraftFamily, string> = {
  alteration: 'Alteration',
  chaos: 'Chaos Orb',
  essence: 'Essence',
  fossil: 'Fossil',
  harvest: 'Harvest',
  bench: 'Bench finish',
  other: 'Other',
};
const categoryLabels: Record<string, string> = {
  'cluster-jewel': 'Cluster jewels',
  belt: 'Belts',
  'body-armour': 'Body armour',
  boots: 'Boots',
  bow: 'Bows',
  flask: 'Flasks',
  gloves: 'Gloves',
  helmet: 'Helmets',
  quiver: 'Quivers',
  ring: 'Rings',
  shield: 'Shields',
  wand: 'Wands',
  amulet: 'Amulets',
};
export function itemClassLabel(category: string) {
  return (
    categoryLabels[category] ??
    category.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase())
  );
}
function routeFamilies(entry: CatalogEntry): CraftFamily[] {
  return entry.recipe.craftFamilies ?? ['other'];
}
export function libraryQuote(entry: CatalogEntry, currency: Price['currency']) {
  const readiness = entry.readiness;
  if (readiness) {
    const current = observedAsk(entry);
    return {
      price: current?.currency === currency ? current : null,
      at: readiness.capturedAt,
      stale: !readiness.fresh,
      evidence: {
        comparableOnly: false,
        captured: readiness.currentListings,
        reported: readiness.currentTotalListings ?? null,
        sellers: readiness.currentSellers,
        exits: readiness.activityMeasurable
          ? readiness.last24h.inferredExits
          : null,
        coverage: readiness.coverage,
        seen: readiness.activityMeasurable ? readiness.last24h.listings : null,
        repriced: readiness.activityMeasurable
          ? readiness.last24h.repriced
          : null,
      },
    };
  }
  const snapshot = entry.snapshot;
  const price = lowestAskInCurrency(snapshot, currency)?.price;
  return price && snapshot
    ? {
        price,
        at: snapshot.capturedAt,
        stale: snapshot.expiresAt
          ? Date.parse(snapshot.expiresAt) <= Date.now()
          : null,
        evidence: {
          comparableOnly: true,
          captured: snapshot.listings.length,
          reported: snapshot.totalResults,
          sellers: new Set(snapshot.listings.map((l) => l.seller)).size,
          exits: null,
          coverage: snapshot.coverage ?? null,
          seen: null,
          repriced: null,
        },
      }
    : null;
}
export function favoriteTargetIds(ids: string[], entries: CatalogEntry[]) {
  const aliases = new Map(
    entries.map((e) => [e.recipe.id, e.recipe.targetSignature]),
  );
  return [...new Set(ids.map((id) => aliases.get(id) ?? id))];
}
interface RecipeLibraryFilters {
  search?: string;
  category?: string;
  family?: string;
  sort?: string;
  estimatesOnly?: boolean;
  favoritesOnly?: boolean;
  favoriteIds?: string[];
  currency?: Price['currency'];
}
export function selectRecipeLibrary(
  entries: CatalogEntry[],
  filters: RecipeLibraryFilters = {},
) {
  const currency = filters.currency ?? 'chaos';
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const id = entry.recipe.targetSignature;
    const group = groups.get(id);
    if (group) group.push(entry);
    else groups.set(id, [entry]);
  }
  const full = [...groups].map(([id, methods], order) => {
    const entry = methods[0]!;
    return {
      id,
      methods,
      recipeIds: methods.map((e) => e.recipe.id),
      order,
      entry,
      name: entry.recipe.title,
      category: entry.recipe.category,
    };
  });
  const categories = [...new Set(full.map((o) => o.category))]
    .sort((a, b) =>
      a === 'cluster-jewel'
        ? -1
        : b === 'cluster-jewel'
          ? 1
          : itemClassLabel(a).localeCompare(itemClassLabel(b)),
    )
    .map((id) => ({
      id,
      label: itemClassLabel(id),
      count: full.filter((o) => o.category === id).length,
    }));
  const families = Object.entries(craftFamilyLabels).map(([id, label]) => ({
    id,
    label,
    count: full.filter((o) =>
      o.methods.some((e) => routeFamilies(e).some((f) => f === id)),
    ).length,
  }));
  const favorites = favoriteTargetIds(filters.favoriteIds ?? [], entries);
  const search = filters.search?.trim().toLocaleLowerCase() ?? '';
  const knownCost = (entry: CatalogEntry) => {
    const price = entry.evaluation.expectedCraftCost;
    return price?.currency === currency ? price : null;
  };
  const outputs = full.flatMap((output) => {
    if (
      filters.category &&
      filters.category !== 'all' &&
      filters.category !== output.category
    )
      return [];
    if (filters.favoritesOnly && !favorites.includes(output.id)) return [];
    const item = output.entry.itemPreview;
    const outputText = [
      output.name,
      output.entry.recipe.baseName,
      item?.name,
      output.category,
      itemClassLabel(output.category),
      ...(item?.properties.map((p) => `${p.label} ${p.value ?? ''}`) ?? []),
      ...(item?.modifiers.map((m) => m.label) ?? []),
    ]
      .join(' ')
      .toLocaleLowerCase();
    const methods = output.methods.filter((entry) => {
      const families = routeFamilies(entry);
      return (
        (!filters.family ||
          filters.family === 'all' ||
          families.some((f) => f === filters.family)) &&
        (!search ||
          `${outputText} ${families.map((f) => craftFamilyLabels[f]).join(' ')} ${entry.recipe.methodName ?? entry.recipe.craftMethod}`
            .toLocaleLowerCase()
            .includes(search))
      );
    });
    if (
      !methods.length ||
      (filters.estimatesOnly && !methods.some((e) => knownCost(e)))
    )
      return [];
    const ranked = methods
      .filter((e) => knownCost(e))
      .sort(
        (a, b) =>
          knownCost(a)!.amount - knownCost(b)!.amount ||
          a.recipe.id.localeCompare(b.recipe.id),
      );
    // Quotes describe this exact output; never aggregate duplicate method samples.
    const quote = output.methods
      .flatMap((entry) => {
        const evidence = libraryQuote(entry, currency);
        return evidence ? [evidence] : [];
      })
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0];
    const estimated = ranked.length;
    return [
      {
        ...output,
        currency,
        methods,
        selectedRecipeId: (ranked[0] ?? methods[0])!.recipe.id,
        cost: ranked[0] ? knownCost(ranked[0]) : null,
        ask: quote?.price ?? null,
        quoteAt: quote?.at ?? null,
        quoteStale: quote?.stale ?? null,
        quoteEvidence: quote?.evidence ?? null,
        coverage: {
          total: methods.length,
          estimated,
          unknown: methods.length - estimated,
          partial: estimated > 0 && estimated < methods.length,
        },
      },
    ];
  });
  outputs.sort((a, b) => {
    const left = filters.sort === 'ask' ? a.ask : a.cost;
    const right = filters.sort === 'ask' ? b.ask : b.cost;
    if (filters.sort === 'cost' || filters.sort === 'ask') {
      if (!left) return !right ? a.order - b.order : 1;
      if (!right) return -1;
      return (
        (filters.sort === 'ask'
          ? right.amount - left.amount
          : left.amount - right.amount) || a.order - b.order
      );
    }
    return (
      (filters.sort === 'name' ? a.name.localeCompare(b.name) : 0) ||
      a.order - b.order
    );
  });
  return {
    outputs,
    categories,
    families,
    total: full.length,
    methodCount: outputs.reduce((n, o) => n + o.methods.length, 0),
  };
}
export type RecipeLibraryOutput = ReturnType<
  typeof selectRecipeLibrary
>['outputs'][number];
