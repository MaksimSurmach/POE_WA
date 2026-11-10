import type { RateLimitDiagnosticsResponse } from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';
import { createApiClient } from './apiClient.js';

const api = createApiClient();
const dateTime = new Intl.DateTimeFormat('en', {
  dateStyle: 'short',
  timeStyle: 'medium',
});
const count = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

type Diagnostics = RateLimitDiagnosticsResponse['data'];

const operations: Record<string, string> = {
  search: 'Searching Trade',
  fetch: 'Fetching listings',
  economy: 'Collecting economy prices',
  league: 'Checking league',
  retention: 'Cleaning history',
  evaluation: 'Evaluating recipes',
  permit: 'Waiting for a request permit',
  cooldown: 'Cooling down',
  pause: 'Paused',
  'session-recovery': 'Restoring Trade session',
  'auth-blocked': 'Trade authorization required',
  idle: 'Waiting for scheduled work',
};

const reasons: Record<string, string> = {
  pacing: 'Request pacing',
  'rate-limit': 'HTTP 429 rate limit',
  'provider-error': 'Provider failure',
  authorization: 'Trade authorization',
  restriction: 'Provider restriction',
  retry: 'Scheduled retry',
  PROVIDER_RATE_LIMITED: 'Trade returned HTTP 429',
  PROVIDER_UNAVAILABLE: 'Trade is temporarily unavailable',
  PROVIDER_AUTH_FAILED: 'Trade authorization failed',
  ECONOMY_RATE_LIMITED: 'Economy provider returned HTTP 429',
  ECONOMY_UNAVAILABLE: 'Economy provider is temporarily unavailable',
};

function reasonLabel(reason: string) {
  return (
    reasons[reason] ??
    reason.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ')
  );
}

function time(value: string | null) {
  return value ? (
    <time dateTime={value}>{dateTime.format(new Date(value))}</time>
  ) : (
    'unknown'
  );
}

function duration(ms: number) {
  return ms >= 60_000
    ? `${count.format(ms / 60_000)} min`
    : `${count.format(ms / 1000)} s`;
}

function range(
  sample: { average: number | null; max: number | null },
  format: (value: number) => string,
) {
  return sample.average === null || sample.max === null
    ? 'unknown'
    : `${format(sample.average)} average · ${format(sample.max)} highest observed`;
}

export function CollectorDetails() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Diagnostics>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState === 'visible') {
        try {
          const { data } = await api.getRateLimitDiagnostics(
            AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
          );
          if (!stop.signal.aborted) {
            setData(data);
            setUnavailable(false);
          }
        } catch {
          if (!stop.signal.aborted) setUnavailable(true);
        }
      }
      if (!stop.signal.aborted) timer = setTimeout(() => void poll(), 30_000);
    }
    void poll();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [open]);

  return (
    <details
      className="collector-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Collector details</summary>
      {open ? (
        <>
          {unavailable ? (
            <p role="status">
              Collector telemetry unavailable
              {data ? ' · showing last read' : ''}
            </p>
          ) : !data ? (
            <p role="status">Loading collector telemetry</p>
          ) : null}
          {data ? <CollectorTelemetry data={data} /> : null}
        </>
      ) : null}
    </details>
  );
}

export function CollectorTelemetry({
  data,
  now = Date.now(),
}: {
  data: Diagnostics;
  now?: number;
}) {
  const collector = data.collector;
  if (!collector) return <p>HA worker telemetry has not been recorded yet.</p>;

  const { current, queue } = collector;
  return (
    <>
      <dl className="collector-details__state">
        <dt>HA worker</dt>
        <dd>
          {collector.role} · last contact {time(collector.contactedAt)}
          {collector.stale ? ' · stale telemetry' : ''}
        </dd>
        <dt>Operation</dt>
        <dd>
          {current ? (
            <>
              {operations[current.operation] ?? current.operation}
              {current.target ? ` · ${current.target}` : ''} · since{' '}
              {time(current.startedAt)}
              {current.taskStartedAt
                ? ` · task running ${duration(Math.max(0, now - Date.parse(current.taskStartedAt)))}`
                : ''}
              {current.reason ? ` · ${reasonLabel(current.reason)}` : ''}
              {current.until ? <> · until {time(current.until)}</> : null}
            </>
          ) : (
            'unknown'
          )}
        </dd>
        <dt>Schedule</dt>
        <dd>
          {queue.due} due · {queue.enabled} enabled ·{' '}
          {count.format(queue.tradeCapturesPerHour)} planned Trade captures/h
          {queue.oldestDueAt ? (
            <> · oldest due {time(queue.oldestDueAt)}</>
          ) : null}
          {' · next allowed '}
          {queue.nextDueAt ? time(queue.nextDueAt) : 'unavailable'}
        </dd>
      </dl>
      <h3>Trade rate limits</h3>
      {collector.rateLimits.length === 0 ? (
        <p>No Trade limits have been observed by this worker.</p>
      ) : (
        <ul>
          {collector.rateLimits.map((policy) => (
            <li key={policy.endpoint}>
              <strong>{policy.endpoint}</strong> · {policy.policy} · observed{' '}
              {time(policy.observedAt)} · next permit{' '}
              {time(policy.waitingUntil)}
              {Date.parse(policy.blockedUntil) > now ? (
                <> · restricted until {time(policy.blockedUntil)}</>
              ) : null}
              {policy.headersComplete ? '' : ' · incomplete limit headers'}
              <ul>
                {policy.windows.map((window) => (
                  <li key={`${window.rule}-${window.periodSeconds}`}>
                    {window.rule} · {duration(window.periodSeconds * 1000)} ·{' '}
                    {window.currentHits}/{window.maximumHits} at observation
                    {now - Date.parse(policy.observedAt) >=
                    window.periodSeconds * 1000
                      ? ' · window observation expired'
                      : ''}
                    {window.activeRestrictionSeconds
                      ? ` · restriction at observation ${duration(window.activeRestrictionSeconds * 1000)}`
                      : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {collector.windows.map((window) => (
        <section key={window.hours} aria-label={`Last ${window.hours}h`}>
          <h3>Last {window.hours === 1 ? 'hour' : '24 hours'}</h3>
          {window.trackedSince ? (
            <>
              <p>Tracked since {time(window.trackedSince)}</p>
              <ul>
                {window.requests.map((row) => (
                  <li key={`${row.provider}/${row.endpoint}`}>
                    {row.provider} / {row.endpoint} · {row.success} 2xx ·{' '}
                    {row.rateLimited} 429 · {row.auth} 401–403 ·{' '}
                    {row.serverError} 5xx · {row.networkError} network errors ·{' '}
                    {row.other} other
                  </li>
                ))}
                {!window.requests.length ? (
                  <li>No recorded HTTP requests</li>
                ) : null}
              </ul>
              <p>
                Last 429{' '}
                {window.last429 ? (
                  <>
                    {time(window.last429.at)} · Retry-After{' '}
                    {window.last429.retryAfterMs === null
                      ? 'unknown'
                      : duration(window.last429.retryAfterMs)}
                  </>
                ) : (
                  'none recorded in this period'
                )}
              </p>
              <ul>
                {window.waits.map((wait) => (
                  <li key={wait.reason}>
                    {reasonLabel(wait.reason)} · {wait.count} waits ·{' '}
                    {duration(wait.durationMs)}
                  </li>
                ))}
              </ul>
              <p>
                Captures · {window.captures.planned} attempts started ·{' '}
                {window.captures.successful} successful (
                {window.captures.complete} complete, {window.captures.partial}{' '}
                partial) · {window.captures.failed} failed ·{' '}
                {window.captures.interrupted} interrupted ·{' '}
                {window.captures.targets} targets
              </p>
              {Object.keys(window.captures.partialReasons).length ? (
                <p>
                  Partial causes ·{' '}
                  {Object.entries(window.captures.partialReasons)
                    .map(
                      ([reason, value]) => `${reasonLabel(reason)} (${value})`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
              <p>
                Latest capture {time(window.captures.latestCaptureAt)} ·
                observed span{' '}
                {window.captures.observedSpanMs === null
                  ? 'unknown'
                  : duration(window.captures.observedSpanMs)}
              </p>
              <ul>
                <li>
                  Observation interval per target ·{' '}
                  {range(window.captures.intervalMs, duration)}
                </li>
                <li>
                  Capture duration ·{' '}
                  {range(window.captures.durationMs, duration)}
                </li>
                <li>
                  Search requests per capture ·{' '}
                  {range(window.captures.searchRequests, count.format)}
                </li>
                <li>
                  Fetch requests per capture ·{' '}
                  {range(window.captures.fetchRequests, count.format)}
                </li>
              </ul>
            </>
          ) : (
            <p>No telemetry coverage for this period.</p>
          )}
        </section>
      ))}
    </>
  );
}
