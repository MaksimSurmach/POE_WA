import { formatTimestamp } from './dateTime.js';
import type {
  CollectorReadinessResponse,
  MarketReadiness as Readiness,
} from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';

import { createApiClient } from './apiClient.js';
import { Money } from './components.js';

const api = createApiClient();

export const readinessLabels: Record<Readiness['level'], string> = {
  insufficient: 'Insufficient observations',
  'price-observed': 'Price observed',
  'activity-measurable': 'Supply activity measurable',
  'preliminary-candidate': 'Preliminary candidate',
};

export function isSingleSellerHypothesis(r: Readiness) {
  return r.fresh && (r.comparableSellers ?? r.currentSellers) === 1;
}

function AskRange({ range }: { range: Readiness['currentAskRange'] }) {
  if (!range) return <>Unknown</>;
  return (
    <>
      <Money price={range.min} />
      {range.min.amount !== range.max.amount ? (
        <>
          {' '}
          – <Money price={range.max} />
        </>
      ) : null}
    </>
  );
}

function time(at: string | null) {
  return at ? <time dateTime={at}>{formatTimestamp(at)}</time> : 'Unknown';
}

export function MarketReadiness({
  readiness,
  output = true,
}: {
  readiness: Readiness;
  output?: boolean;
}) {
  const r = readiness;
  const d = r.last24h;
  return (
    <div data-market-readiness data-readiness-level={r.level}>
      <p>
        <strong>{readinessLabels[r.level]}</strong>
        {isSingleSellerHypothesis(r) ? ' · Single-seller price hypothesis' : ''}
      </p>
      <p>
        Latest capture {time(r.capturedAt)}.{' '}
        {r.fresh ? 'Fresh' : r.capturedAt ? 'Outdated' : 'Awaiting observation'}
        .
        {r.coverage === 'partial'
          ? ' Partial coverage. These asks describe the sample.'
          : r.coverage === 'complete'
            ? ' Complete coverage.'
            : ''}
      </p>
      <p>
        Observed asks <AskRange range={r.currentAskRange} /> ·{' '}
        {r.currentSellers} priced sellers · {r.currentListings} listings
        {r.comparableSellers !== null
          ? ` · ${r.comparableSellers} comparable sellers`
          : ''}
        {r.staleFloorCount
          ? ` · ${r.staleFloorCount} at the observed floor unchanged for at least 7 days`
          : ''}
      </p>
      <ul>
        <li>
          {r.comparableAsks
            ? 'Comparable asks'
            : 'Comparable asks still needed'}
        </li>
        {output ? (
          <>
            <li>
              {r.costVerified
                ? 'Verified craft cost available'
                : 'Verified craft cost still needed'}
            </li>
            <li>
              {r.saleEligible
                ? 'Ask-based comparison allowed'
                : 'Ask-based profit comparison withheld'}
            </li>
          </>
        ) : null}
        <li>
          {r.activityMeasurable
            ? 'Enough time coverage to measure supply activity'
            : 'Need a complete baseline and two complete follow-ups at least 2 hours apart'}
        </li>
      </ul>
      <details>
        <summary>Last 24 hours</summary>
        <p>
          {d.complete} complete · {d.partial} partial ·{' '}
          {d.failed === null ? 'Failed count unknown' : `${d.failed} failed`}
          {d.failuresTrackedSince && (
            <> · failures tracked since {time(d.failuresTrackedSince)}</>
          )}
        </p>
        <p>
          {d.spanMinutes} min observed span ·{' '}
          {d.largestGapMinutes === null
            ? 'Capture interval unknown'
            : `largest gap ${d.largestGapMinutes} min`}{' '}
          ·{' '}
          {d.overdueIntervals === null
            ? 'missed intervals unknown'
            : `${d.overdueIntervals} nominal intervals missed`}
        </p>
        <p>
          {d.listings} distinct listings · {d.sellers} distinct sellers ·
          Observed range <AskRange range={d.askRange} />
        </p>
        <p>
          {d.repriced ?? 'Unknown'} repriced · {d.uncertainExits ?? 'Unknown'}{' '}
          uncertain exits · {d.relisted ?? 'Unknown'} possible relists
        </p>
        <p>
          {d.inferredExits === null
            ? 'Insufficient observations for exit counts.'
            : d.inferredExits === 0
              ? 'No qualified inferred exits observed.'
              : `${d.inferredExits} qualified inferred exits from ${d.exitSellers ?? 'unknown'} sellers.`}
        </p>
        {output ? (
          <p>
            Preliminary candidate thresholds · {d.complete}/6 complete
            observations · {(d.completeSpanMinutes / 60).toFixed(1)}/5 hours of
            complete coverage · {d.inferredExits ?? '?'}/3 inferred exits ·{' '}
            {d.exitSellers ?? '?'}/2 exit sellers
          </p>
        ) : null}
        <p>Asks and inferred exits describe listings. Sales are unknown.</p>
      </details>
    </div>
  );
}

export function CollectorReadinessReport() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<CollectorReadinessResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    async function load() {
      try {
        const next = await api.getCollectorReadiness(
          AbortSignal.timeout(15_000),
        );
        if (active) {
          setReport(next);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 120_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  return (
    <details
      className="detail-section"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>All Trade targets · 24-hour readiness</summary>
      {open && failed ? (
        <p role="status">Readiness report unavailable.</p>
      ) : null}
      {open && !report && !failed ? (
        <p role="status">Loading readiness report…</p>
      ) : null}
      {open && report ? (
        <>
          <p>
            Report at {time(report.evaluatedAt)}. Each exact query is reported
            separately. Discovery targets can overlap.
          </p>
          <p>
            {Object.entries(readinessLabels)
              .map(
                ([level, label]) =>
                  `${label}: ${report.targets.filter(({ readiness }) => readiness.level === level).length}`,
              )
              .join(' · ')}
          </p>
          {report.targets.map(
            ({ key, name, league, role, intervalMinutes, readiness }) => (
              <details key={key}>
                <summary>
                  {name} · {role} · {readinessLabels[readiness.level]}
                </summary>
                <p>
                  {league} · planned every {intervalMinutes} min
                </p>
                <MarketReadiness
                  readiness={readiness}
                  output={role === 'output'}
                />
              </details>
            ),
          )}
        </>
      ) : null}
    </details>
  );
}
