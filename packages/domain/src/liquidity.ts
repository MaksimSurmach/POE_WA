import { Decimal } from 'decimal.js';
import {
  liquidityInputSchema,
  liquidityAssessmentSchema,
  type LiquidityInput,
  type LiquidityAssessment,
} from './intelligence.js';
const D = Decimal.clone({ precision: 80 });
const money = (v: Decimal) => v.toFixed();
const quantile = <T>(sorted: T[], p: number): T =>
  sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
export function analyzeLiquidity(raw: LiquidityInput): LiquidityAssessment {
  const input = liquidityInputSchema.parse(raw),
    now = Date.parse(input.now),
    reasons: string[] = [];
  const cohortMatches = (c: { league: string; targetSignature: string }) =>
    c.league === input.cohort.league &&
    c.targetSignature === input.cohort.targetSignature;
  const snapshots = [
    ...new Map(
      input.snapshots
        .filter(
          (s) => cohortMatches(s.cohort) && Date.parse(s.capturedAt) <= now,
        )
        .map((s) => [s.id, s]),
    ).values(),
  ].sort(
    (a, b) =>
      Date.parse(b.capturedAt) - Date.parse(a.capturedAt) ||
      a.id.localeCompare(b.id),
  );
  const latest = snapshots[0];
  const fresh = (s: NonNullable<typeof latest>) =>
    Date.parse(s.expiresAt) > now &&
    now - Date.parse(s.capturedAt) <=
      input.settings.maxSnapshotAgeSeconds * 1000 &&
    Date.parse(s.expiresAt) >= Date.parse(s.capturedAt);
  const listings = latest
    ? [
        ...new Map(
          latest.listings.map((l) => [
            l.id,
            { ...l, seller: l.seller.trim().toLowerCase() },
          ]),
        ).values(),
      ]
    : [];
  const prices = listings
    .map((l) => new D(l.askChaos))
    .sort((a, b) => a.cmp(b));
  const sellers = new Map<string, number>();
  listings.forEach((l) =>
    sellers.set(l.seller, (sellers.get(l.seller) ?? 0) + 1),
  );
  const complete = Boolean(
    latest?.coverage === 'complete' &&
    latest.sortedSampleComplete &&
    latest.totalListings === listings.length,
  );
  if (!latest) reasons.push('No matching stored listing snapshot');
  else {
    if (!fresh(latest)) reasons.push('Listing evidence is stale');
    if (!complete) reasons.push('Listing coverage is incomplete');
    if (
      listings.some(
        (l) => Date.parse(l.indexedAt) > Date.parse(latest.capturedAt),
      )
    )
      reasons.push('Listing timestamps are in the future');
  }
  if (sellers.size < input.settings.minIndependentSellers)
    reasons.push('Too few independent sellers');
  const independent: typeof snapshots = [];
  for (const snapshot of snapshots)
    if (
      snapshot.queryHash === latest?.queryHash &&
      snapshot.listings.every(
        (l) => Date.parse(l.indexedAt) <= Date.parse(snapshot.capturedAt),
      ) &&
      fresh(snapshot) &&
      snapshot.coverage === 'complete' &&
      snapshot.sortedSampleComplete &&
      snapshot.totalListings ===
        new Set(snapshot.listings.map((l) => l.id)).size &&
      (!independent.length ||
        Date.parse(independent.at(-1)!.capturedAt) -
          Date.parse(snapshot.capturedAt) >=
          input.settings.minObservationGapSeconds * 1000)
    )
      independent.push(snapshot);
  const previous = snapshots.find(
    (s) =>
      s.id !== latest?.id &&
      s.queryHash === latest?.queryHash &&
      Date.parse(s.capturedAt) < Date.parse(latest!.capturedAt) &&
      s.coverage === 'complete' &&
      s.sortedSampleComplete &&
      s.totalListings === new Set(s.listings.map((l) => l.id)).size,
  );
  const percent = (a: Decimal, b: Decimal) =>
    a.eq(0) ? null : b.sub(a).div(a).mul(100).toDecimalPlaces(8).toFixed();
  let changes: LiquidityAssessment['changes'] = null;
  if (previous && complete) {
    const oldIds = new Set(previous.listings.map((l) => l.id)),
      currentIds = new Set(listings.map((l) => l.id));
    const olderIds = new Set(
      snapshots
        .filter(
          (s) =>
            s.queryHash === latest?.queryHash &&
            Date.parse(s.capturedAt) < Date.parse(previous.capturedAt),
        )
        .flatMap((s) => s.listings.map((l) => l.id)),
    );
    const oldPrices = previous.listings
      .map((l) => new D(l.askChaos))
      .sort((a, b) => a.cmp(b));
    changes = {
      new: listings.filter((l) => !oldIds.has(l.id) && !olderIds.has(l.id))
        .length,
      reappeared: listings.filter(
        (l) => !oldIds.has(l.id) && olderIds.has(l.id),
      ).length,
      missing: [...oldIds].filter((id) => !currentIds.has(id)).length,
      supplyPercent: percent(new D(oldIds.size), new D(currentIds.size)),
      sellerPercent: percent(
        new D(
          new Set(previous.listings.map((l) => l.seller.trim().toLowerCase()))
            .size,
        ),
        new D(sellers.size),
      ),
      askPercent:
        oldPrices.length && prices.length
          ? percent(quantile(oldPrices, 0.5), quantile(prices, 0.5))
          : null,
    };
  }
  const windowStart = new Date(
    now - input.settings.ownSalesWindowDays * 86400000,
  ).toISOString();
  const inventory = input.ownInventory.filter(
    (i) =>
      i.targetSignature !== null &&
      cohortMatches({ league: i.league, targetSignature: i.targetSignature }),
  );
  const byId = new Map(inventory.map((i) => [i.id, i]));
  const ownSales = [
    ...new Map(
      input.ownSales
        .filter(
          (s) =>
            s.targetSignature !== null &&
            cohortMatches({
              league: s.league,
              targetSignature: s.targetSignature,
            }) &&
            Date.parse(s.soldAt) >= Date.parse(windowStart) &&
            Date.parse(s.soldAt) <= now,
        )
        .map((s) => [s.eventId, s]),
    ).values(),
  ];
  const confirmedSales = ownSales.map((s) => {
    const item = byId.get(s.itemId);
    const holding = item
      ? (Date.parse(s.soldAt) - Date.parse(item.producedAt)) / 1000
      : null;
    return {
      id: s.eventId,
      soldAt: s.soldAt,
      timeToSellSeconds: s.timeToSellSeconds,
      holdingSeconds: holding !== null && holding >= 0 ? holding : null,
    };
  });
  const saleTimes = confirmedSales
    .flatMap((s) => (s.timeToSellSeconds === null ? [] : [s.timeToSellSeconds]))
    .sort((a, b) => a - b);
  const holdingTimes = confirmedSales
    .flatMap((s) => (s.holdingSeconds === null ? [] : [s.holdingSeconds]))
    .sort((a, b) => a - b);
  const unsold = inventory.filter(
    (i) =>
      ['held', 'listed'].includes(i.status) && Date.parse(i.producedAt) <= now,
  );
  return liquidityAssessmentSchema.parse({
    cohort: input.cohort,
    status: !latest ? 'unavailable' : reasons.length ? 'partial' : 'supported',
    reasons,
    snapshotId: latest?.id ?? null,
    observedAt: latest?.capturedAt ?? null,
    expiresAt: latest?.expiresAt ?? null,
    evidenceIds: snapshots.map((s) => s.id),
    coverage: latest?.coverage ?? 'unknown',
    independentObservations: independent.length,
    sellers: sellers.size,
    listings: listings.length,
    totalListings: latest?.totalListings ?? 0,
    asking: prices.length
      ? {
          min: money(prices[0]!),
          p25: money(quantile(prices, 0.25)),
          median: money(quantile(prices, 0.5)),
          p75: money(quantile(prices, 0.75)),
          max: money(prices.at(-1)!),
        }
      : null,
    depth: prices.length
      ? [prices[0]!, quantile(prices, 0.5), prices.at(-1)!]
          .filter((p, i, a) => a.findIndex((v) => v.eq(p)) === i)
          .map((p) => ({
            ask: money(p),
            listings: prices.filter((v) => v.lte(p)).length,
          }))
      : [],
    largestSellerShare: listings.length
      ? Math.max(...sellers.values()) / listings.length
      : null,
    concentrationIndex: listings.length
      ? [...sellers.values()].reduce(
          (sum, n) => sum + (n / listings.length) ** 2,
          0,
        )
      : null,
    competitionTrend:
      changes?.supplyPercent !== null && changes?.supplyPercent !== undefined
        ? new D(changes.supplyPercent).gt(0)
          ? 'rising'
          : new D(changes.supplyPercent).lt(0)
            ? 'falling'
            : 'stable'
        : 'unknown',
    changes,
    own: {
      coverageComplete: input.ownCoverageComplete,
      sampleSize: holdingTimes.length,
      saleTimeSampleSize: saleTimes.length,
      medianSellSeconds: saleTimes.length ? quantile(saleTimes, 0.5) : null,
      p75SellSeconds: saleTimes.length ? quantile(saleTimes, 0.75) : null,
      medianHoldingSeconds: holdingTimes.length
        ? quantile(holdingTimes, 0.5)
        : null,
      p75HoldingSeconds: holdingTimes.length
        ? quantile(holdingTimes, 0.75)
        : null,
      unsoldCount: unsold.length,
      oldestUnsoldSeconds: unsold.length
        ? Math.max(
            ...unsold.map((i) => (now - Date.parse(i.producedAt)) / 1000),
          )
        : null,
      confirmedSales,
      windowStart,
      windowEnd: input.now,
    },
    basis: 'listing-supply-proxies-and-own-confirmed-sales',
  });
}
