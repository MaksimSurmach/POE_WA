import {
  tradeDashboardItemSchema,
  type TradeDashboardItem,
  type TradeDashboardPoint,
} from '@poe-worksmith/contracts';
import { z } from 'zod';

const hour = 3_600_000;
const day = 24 * hour;

export const tradeDashboardHistorySchema = z.array(
  z.strictObject({
    ...tradeDashboardItemSchema.pick({ id: true, name: true, slot: true })
      .shape,
    intervalMinutes: z.number().positive(),
    captures: z.array(
      z.strictObject({
        ...tradeDashboardItemSchema.shape.latest.unwrap().shape,
        identities: z.array(z.string().nullable()).nullable(),
        sellers: z.array(z.string().nullable()).nullable(),
      }),
    ),
  }),
);
type History = z.infer<typeof tradeDashboardHistorySchema>[number];

function publicCapture({
  id,
  at,
  currency,
  ask,
  captured,
  coverage,
}: History['captures'][number]) {
  return { id, at, currency, ask, captured, coverage };
}

export function summarizeTradeHistory(
  history: History,
  start: number,
  end: number,
  includePoints: boolean,
): { item: TradeDashboardItem; points: TradeDashboardPoint[] } {
  const captures = history.captures;
  const times = captures.map(({ at }) => Date.parse(at));
  const lastSeen = new Map<string, number>();
  const seen = new Set<string>();
  const identitySets = captures.map(({ identities }, index) => {
    const ids = new Set(
      (identities ?? []).filter((id): id is string => id !== null),
    );
    for (const id of ids) lastSeen.set(id, index);
    return ids;
  });
  const full = (index: number) => {
    const capture = captures[index];
    return (
      capture?.coverage === 'complete' &&
      capture.identities !== null &&
      identitySets[index]?.size === capture.identities.length
    );
  };
  const comparable = (index: number) => {
    const elapsed = (times[index] ?? 0) - (times[index - 1] ?? 0);
    return (
      full(index - 1) &&
      full(index) &&
      elapsed > 0 &&
      elapsed <= history.intervalMinutes * 90_000
    );
  };
  const points = captures.map((capture, index) => {
    const current = identitySets[index] ?? new Set<string>();
    const firstSeen = [...current].filter((id) => !seen.has(id)).length;
    for (const id of current) seen.add(id);
    const previous = captures[index - 1];
    const prior = identitySets[index - 1];
    const missing =
      previous && prior && comparable(index)
        ? [...prior].filter((id) => !current.has(id))
        : null;
    const sustained =
      missing && comparable(index + 1) && comparable(index + 2)
        ? missing.filter((id) => lastSeen.get(id) === index - 1).length
        : null;
    return {
      ...publicCapture(capture),
      previousId: missing && previous ? previous.id : null,
      firstSeen: missing ? firstSeen : null,
      missing: missing?.length ?? null,
      sustained,
    };
  });

  function interval(from: number, to: number) {
    let exits = 0;
    let exposure = 0;
    let fresh = 0;
    let firstSeenAvailable = true;
    let lastInWindow: number | undefined;
    points.forEach((point, index) => {
      const timestamp = times[index] ?? 0;
      if (timestamp <= from || timestamp > to) return;
      lastInWindow = timestamp;
      if (point.firstSeen === null) firstSeenAvailable = false;
      fresh += point.firstSeen ?? 0;
      const previous = times[index - 1];
      // Avoid attributing an exit to a window if the change could predate it.
      if (point.sustained === null || previous === undefined || previous < from)
        return;
      exits += point.sustained;
      exposure += timestamp - previous;
    });
    return {
      exits: exposure > 0 ? exits : null,
      rate: exposure >= (to - from) / 2 ? (exits * day) / exposure : null,
      hours: exposure / hour,
      fresh:
        firstSeenAvailable &&
        lastInWindow !== undefined &&
        to - lastInWindow <= history.intervalMinutes * 90_000
          ? fresh
          : null,
    };
  }

  const now = interval(start, end);
  const before = interval(start - (end - start), start);
  const latest = captures.at(-1);
  const lastIndex = captures.length - 1;
  const ageStart = (times.at(-1) ?? 0) - 2 * day;
  const ageBaseline = times.reduce(
    (last, at, index) => (at <= ageStart ? index : last),
    -1,
  );
  let visible48h: number | null = null;
  if (
    ageBaseline >= 0 &&
    full(ageBaseline) &&
    captures
      .slice(ageBaseline + 1)
      .every((_, offset) => comparable(ageBaseline + offset + 1))
  ) {
    visible48h = [...(identitySets[lastIndex] ?? [])].filter((id) =>
      identitySets.slice(ageBaseline).every((ids) => ids.has(id)),
    ).length;
  }
  const sellerCounts = new Map<string, number>();
  for (const seller of latest?.sellers ?? []) {
    if (seller) sellerCounts.set(seller, (sellerCounts.get(seller) ?? 0) + 1);
  }
  const sellerEvidence =
    latest?.sellers?.every((seller) => seller !== null) ?? false;
  const ranked =
    full(lastIndex) &&
    latest &&
    end - Date.parse(latest.at) <= history.intervalMinutes * 90_000
      ? now.rate
      : null;
  return {
    item: {
      id: history.id,
      name: history.name,
      slot: history.slot,
      latest: latest ? publicCapture(latest) : null,
      firstSeen: now.fresh,
      exits: now.exits,
      exitsPerDay: ranked,
      changePerDay:
        ranked !== null && before.rate !== null ? ranked - before.rate : null,
      settledHours: now.hours,
      visible48h,
      sellers: sellerEvidence ? sellerCounts.size : null,
      topSellerListings: sellerEvidence
        ? Math.max(0, ...sellerCounts.values())
        : null,
      sellerListings: sellerEvidence ? (latest?.sellers?.length ?? null) : null,
    },
    points: includePoints
      ? points.filter((point) => Date.parse(point.at) > start)
      : [],
  };
}
