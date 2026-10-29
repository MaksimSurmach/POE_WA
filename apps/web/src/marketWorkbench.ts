import type {
  MarketResearchSnapshotSummary,
  MarketTarget,
} from '@poe-worksmith/contracts';

export function snapshotsForTarget(
  target: MarketTarget,
  snapshots: readonly MarketResearchSnapshotSummary[],
  dataKind: 'observed' | 'demo',
  currency?: 'chaos' | 'divine',
) {
  return snapshots
    .filter(
      (snapshot) =>
        snapshot.targetId === target.id &&
        snapshot.targetDigest === target.digest &&
        snapshot.game === target.game &&
        snapshot.realm === target.realm &&
        snapshot.league === target.league &&
        snapshot.patch === target.patch &&
        snapshot.dataKind === dataKind &&
        (!currency || snapshot.currency === currency),
    )
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

export function latestSnapshot(
  target: MarketTarget,
  snapshots: readonly MarketResearchSnapshotSummary[],
  dataKind: 'observed' | 'demo',
) {
  return snapshotsForTarget(target, snapshots, dataKind).at(-1) ?? null;
}

export function marketStatus(
  snapshot: MarketResearchSnapshotSummary | null,
  now = Date.now(),
) {
  if (!snapshot) return { label: 'Нет наблюдений', tone: 'muted' };
  if (snapshot.dataKind === 'demo') return { label: 'Пример', tone: 'demo' };
  if (now - Date.parse(snapshot.capturedAt) > 24 * 60 * 60 * 1000)
    return { label: 'Старше 24 часов', tone: 'warning' };
  if (snapshot.outcome === 'no_listings')
    return { label: 'Нет предложений', tone: 'warning' };
  if (snapshot.count < 5) return { label: 'Малая выборка', tone: 'warning' };
  return { label: 'Есть наблюдения', tone: 'success' };
}

export function displayPrice(
  value: number | null | undefined,
  currency: 'chaos' | 'divine',
) {
  if (value === null || value === undefined) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${currency === 'divine' ? 'div' : 'chaos'}`;
}

export function displayDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function filterTargets(
  targets: readonly MarketTarget[],
  search: string,
  league: string,
) {
  const needle = search.trim().toLocaleLowerCase();
  return targets.filter(
    (target) =>
      (league === 'all' || target.league === league) &&
      [
        target.name,
        target.slot,
        ...target.baseTypes,
        ...target.builds,
        ...target.requiredMods,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle),
  );
}
