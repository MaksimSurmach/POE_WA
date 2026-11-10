import type { CollectorStatus } from '@poe-worksmith/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClientError, createApiClient } from './apiClient.js';

const api = createApiClient();

function authRequired(error: unknown) {
  return error instanceof ApiClientError && error.status === 401;
}

export function CollectorControls({
  onResultsChanged,
}: {
  onResultsChanged: () => void;
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
      try {
        const next = await api.getCollectorStatus(token ?? undefined);
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
          delay = 1_000;
      } catch (error) {
        if (!active) return;
        if (authRequired(error)) {
          setStatus(null);
          setTokenRejected(Boolean(token));
          setToken(null);
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
  }, [token, pollRevision, onResultsChanged]);

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

  const finishedAt = status?.collectorState?.lastRunFinishedAt;
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
          <span role="status">
            {statusUnavailable
              ? 'Collector status unavailable'
              : status
                ? status.lockHeld
                  ? 'Collector connected'
                  : 'Collector disconnected'
                : 'Checking collector'}
            {' · Last run: '}
            {finishedAt ? (
              <time aria-label="Last run" dateTime={finishedAt}>
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                }).format(new Date(finishedAt))}
              </time>
            ) : (
              'none yet'
            )}
            {requestState === 'queued'
              ? ' · Queued'
              : requestState === 'running'
                ? ' · Running'
                : null}
            {runError
              ? ' · Could not confirm the run'
              : status?.collectorState?.blockedReason
                ? ' · Trade access blocked'
                : requestState === 'failed' ||
                    status?.collectorState?.lastRunStatus === 'failed'
                  ? ' · Run failed'
                  : null}
          </span>
        </>
      )}
    </div>
  );
}
