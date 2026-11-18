import type { CatalogEntry, Price } from '@poe-worksmith/contracts';

const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function evidenceRank(entry: CatalogEntry) {
  if (entry.readiness?.level === 'preliminary-candidate') return 0;
  if (entry.readiness?.comparableAsks) return 1;
  if (entry.readiness !== undefined) return 2;
  return entry.evaluation.grade === 'C' ? 2 : 1;
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

export function formatMarginPercent(value: number) {
  const rounded = Number(value.toFixed(1));
  return `${percentFormatter.format(Object.is(rounded, -0) ? 0 : rounded)}%`;
}

export function observedAsk(
  entry: Pick<CatalogEntry, 'evaluation' | 'readiness'>,
) {
  const { evaluation, readiness } = entry;
  if (!readiness) return evaluation.estimatedSalePrice ?? null;
  const source = evaluation.source;
  return readiness.fresh &&
    source?.comparable === true &&
    source.captureId &&
    source.capturedAt === readiness.capturedAt
    ? (evaluation.estimatedSalePrice ?? null)
    : null;
}
