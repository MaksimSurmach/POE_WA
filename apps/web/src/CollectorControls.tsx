import type { CollectorStatus } from '@poe-worksmith/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CollectorDetails } from './CollectorDetails.js';
import { ApiClientError, createApiClient } from './apiClient.js';

const api = createApiClient();

function authRequired(error: unknown) {
  return error instanceof ApiClientError && error.status === 401;
}

export function CollectorControls({
  onResultsChanged,
  onOperatorConnected,
}: {
  onResultsChanged: () => void;
  onOperatorConnected?: (token: string | null) => void;
}) {
  // undefined: try loopback access; null: the server requires a bearer.
  const [token, setToken] = useState<string | null>();
  const [tokenRejected, setTokenRejected] = useState(false);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [sending, setSending] = useState(false);
  const [runError, setRunError] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const lastFinish = useRef<string | null>(null);

  useEffect(() => {
    if (token === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 30_000;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(() => void poll(), delay);
        return;
      }
      try {
        const next = await api.getCollectorStatus(token ?? undefined);
        if (!active) return;
        setStatus(next);
        onOperatorConnected?.(token ?? '');
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
      } catch (error) {
        if (!active) return;
        if (authRequired(error)) {
          setStatus(null);
          setTokenRejected(Boolean(token));
          setToken(null);
          onOperatorConnected?.(null);
          return;
        }
        setStatusUnavailable(true);
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [token, pollRevision, onResultsChanged, onOperatorConnected]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get('token') ?? '').trim();
    form.reset();
    if (value) setToken(value);
  }

  async function runNow() {
    if (token === null) return;
    setSending(true);
    setRunError(false);
    try {
      const { requestId } = await api.runCollector(token);
      setStatus((value) =>
        value
          ? { ...value, latestRequest: { id: requestId, state: 'queued' } }
          : value,
      );
    } catch (error) {
      if (authRequired(error)) {
        setStatus(null);
        setTokenRejected(Boolean(token));
        setToken(null);
      } else {
        setRunError(true);
      }
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
      {token === null ? (
        <form
          className="handbook-refresh"
          onSubmit={connect}
          autoComplete="off"
        >
          <label>
            Operator token <input name="token" type="password" required />
          </label>
          <button type="submit">Connect</button>
          {tokenRejected ? (
            <span role="status">The operator token was rejected.</span>
          ) : null}
        </form>
      ) : (
        <>
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
        </>
      )}
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
