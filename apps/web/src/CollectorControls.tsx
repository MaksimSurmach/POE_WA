import type { CollectorStatus } from '@poe-worksmith/contracts';
import { useEffect, useRef, useState } from 'react';
import { CollectorDetails } from './CollectorDetails.js';
import { createApiClient } from './apiClient.js';

const api = createApiClient();

export function CollectorControls({
  onResultsChanged,
}: {
  onResultsChanged: () => void;
}) {
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [sending, setSending] = useState(false);
  const [runError, setRunError] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const lastFinish = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 30_000;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(() => void poll(), delay);
        return;
      }
      try {
        const next = await api.getCollectorStatus();
        if (!active) return;
        setStatus(next);
        setStatusUnavailable(false);
        const finishedAt = next.collectorState?.lastRunFinishedAt ?? null;
        if (finishedAt !== lastFinish.current) {
          lastFinish.current = finishedAt;
          onResultsChanged();
        }
        if (
          next.lockHeld &&
          (next.latestRequest?.state === 'queued' ||
            next.latestRequest?.state === 'running')
        )
          delay = 5_000;
      } catch {
        setStatusUnavailable(true);
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollRevision, onResultsChanged]);

  async function runNow() {
    setSending(true);
    setRunError(false);
    try {
      const { requestId } = await api.runCollector();
      setStatus((value) =>
        value
          ? { ...value, latestRequest: { id: requestId, state: 'queued' } }
          : value,
      );
    } catch {
      setRunError(true);
    } finally {
      setSending(false);
      setPollRevision((value) => value + 1);
    }
  }

  const requestState = status?.latestRequest?.state;
  const busy =
    sending || requestState === 'queued' || requestState === 'running';
  return (
    <div
      className="handbook-refresh"
      role="group"
      aria-label="Collector controls"
    >
      <button
        type="button"
        disabled={!status || busy}
        onClick={() => void runNow()}
      >
        Run now
      </button>
      <CollectorStatusLine
        status={status}
        statusUnavailable={statusUnavailable}
        runError={runError}
      />
      <CollectorDetails />
    </div>
  );
}

const runTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function CollectorStatusLine({
  status,
  statusUnavailable = false,
  runError = false,
  now = Date.now(),
}: {
  status: CollectorStatus | null;
  statusUnavailable?: boolean;
  runError?: boolean;
  now?: number;
}) {
  const state = status?.collectorState;
  const request = status?.latestRequest;
  const connected = Boolean(status?.lockHeld) && !statusUnavailable;
  const active = request?.state === 'queued' || request?.state === 'running';
  const progress = request?.summary;
  const done = (progress?.succeeded ?? 0) + (progress?.failed ?? 0);
  const total = done + (progress?.pending?.length ?? 0);
  const failure =
    (request?.state === 'failed' ? progress?.error : undefined) ??
    state?.lastRunSummary?.error;
  const finishedAt = state?.lastRunFinishedAt;
  const nextDueAt = status?.nextDueAt;
  return (
    <span role="status">
      <span className={status && !connected ? 'recipe-warning' : undefined}>
        {statusUnavailable
          ? 'Collector status unavailable'
          : status
            ? connected
              ? 'Collector connected'
              : 'Collector disconnected — runs will not start'
            : 'Checking collector'}
      </span>
      {' · Last run: '}
      {finishedAt ? (
        <>
          <time aria-label="Last run" dateTime={finishedAt}>
            {runTime.format(new Date(finishedAt))}
          </time>
          {state?.lastRunStatus ? ` (${state.lastRunStatus})` : null}
        </>
      ) : (
        'none yet'
      )}
      {connected && nextDueAt ? (
        <>
          {' · Next due '}
          <time aria-label="Next due" dateTime={nextDueAt}>
            {Date.parse(nextDueAt) <= now
              ? 'now'
              : runTime.format(new Date(nextDueAt))}
          </time>
        </>
      ) : null}
      {!active
        ? null
        : !connected
          ? ' · Run waiting for collector'
          : request?.state === 'queued'
            ? ' · Queued'
            : ` · Running${total ? ` ${done}/${total}` : ''}${progress?.failed ? `, ${progress.failed} failed` : ''}`}
      {runError ? (
        ' · Could not confirm the run'
      ) : state?.blockedReason ? (
        <span className="recipe-warning">
          {` · Trade access blocked: ${state.blockedReason}`}
        </span>
      ) : request?.state === 'failed' || state?.lastRunStatus === 'failed' ? (
        <span className="recipe-warning">
          {` · Run failed${failure ? `: ${failure}` : ''}`}
        </span>
      ) : state?.sessionCheckedAt ? (
        ' · Trade session OK'
      ) : null}
    </span>
  );
}
