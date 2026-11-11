import { formatTimestamp } from './dateTime.js';
import { Button } from './ui.js';
import type {
  CollectorStatus,
  MarketAdminSettingsResponse,
} from '@poe-worksmith/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CollectorDetails } from './CollectorDetails.js';
import { createApiClient } from './apiClient.js';
import { createHomeSettingsClient } from './homeSettingsClient.js';

const api = createApiClient();

export type CollectionPauseClient = Pick<
  ReturnType<typeof createHomeSettingsClient>,
  'settings' | 'pause'
>;

export type CollectionPauseChange = {
  /** Latest settings the server confirmed; null when even a re-read failed. */
  settings: MarketAdminSettingsResponse | null;
  outcome: 'changed' | 'already' | 'failed';
  message?: string;
};

/**
 * Applies exactly the pause state the operator clicked for. Settings are
 * re-read first so a version made stale by another tab or a quote-age save is
 * never sent, and nothing is written when the server already holds that state.
 * A rejected write is not retried: the current state is re-read and returned
 * so the operator decides again from what is true now.
 */
export async function changeCollectionPause(
  client: CollectionPauseClient,
  paused: boolean,
): Promise<CollectionPauseChange> {
  let current: MarketAdminSettingsResponse | null = null;
  try {
    current = await client.settings();
    if (current.configured.collectionsPaused === paused)
      return { settings: current, outcome: 'already' };
    return {
      settings: await client.pause(paused, current.version),
      outcome: 'changed',
    };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Settings unavailable.';
    if (!current) return { settings: null, outcome: 'failed', message };
    return {
      settings: await client.settings().catch(() => null),
      outcome: 'failed',
      message,
    };
  }
}

type PauseChange = 'pause' | 'resume';

export function CollectorControls({
  onResultsChanged,
  client,
}: {
  onResultsChanged?: () => void;
  client?: CollectionPauseClient;
}) {
  const settingsApi = useMemo(
    () => client ?? createHomeSettingsClient(),
    [client],
  );
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [settings, setSettings] = useState<MarketAdminSettingsResponse | null>(
    null,
  );
  const [settingsUnavailable, setSettingsUnavailable] = useState(false);
  const [changing, setChanging] = useState<PauseChange | null>(null);
  const [pauseNote, setPauseNote] = useState('');
  const [sending, setSending] = useState(false);
  const [runError, setRunError] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const lastFinish = useRef<string | null>(null);
  // Polled settings older than an operator's pause/resume must not overwrite it.
  const settingsEpoch = useRef(0);
  const resultsChanged = useRef(onResultsChanged);
  useEffect(() => {
    resultsChanged.current = onResultsChanged;
  }, [onResultsChanged]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 30_000;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(() => void poll(), delay);
        return;
      }
      const epoch = settingsEpoch.current;
      const [nextStatus, nextSettings] = await Promise.allSettled([
        api.getCollectorStatus(),
        settingsApi.settings(),
      ]);
      if (!active) return;
      if (epoch === settingsEpoch.current) {
        if (nextSettings.status === 'fulfilled')
          setSettings(nextSettings.value);
        setSettingsUnavailable(nextSettings.status === 'rejected');
      }
      if (nextStatus.status === 'fulfilled') {
        const next = nextStatus.value;
        setStatus(next);
        setStatusUnavailable(false);
        const finishedAt = next.collectorState?.lastRunFinishedAt ?? null;
        if (finishedAt !== lastFinish.current) {
          lastFinish.current = finishedAt;
          resultsChanged.current?.();
        }
        if (
          next.lockHeld &&
          (next.latestRequest?.state === 'queued' ||
            next.latestRequest?.state === 'running')
        )
          delay = 5_000;
      } else {
        setStatusUnavailable(true);
      }
      timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollRevision, settingsApi]);

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

  async function changePause(paused: boolean) {
    settingsEpoch.current += 1;
    setChanging(paused ? 'pause' : 'resume');
    setPauseNote('');
    const result = await changeCollectionPause(settingsApi, paused);
    settingsEpoch.current += 1;
    if (result.settings) setSettings(result.settings);
    setSettingsUnavailable(!result.settings);
    setPauseNote(
      result.outcome === 'failed'
        ? `Could not ${paused ? 'pause' : 'resume'} collection: ${result.message} ${
            result.settings
              ? 'The state shown was re-read from the server.'
              : 'The current state could not be re-read.'
          }`
        : result.outcome === 'already'
          ? `Collection was already ${paused ? 'paused' : 'resumed'} elsewhere; nothing was changed.`
          : '',
    );
    setChanging(null);
  }

  const requestState = status?.latestRequest?.state;
  const busy =
    sending || requestState === 'queued' || requestState === 'running';
  const connected = Boolean(status?.lockHeld) && !statusUnavailable;
  const paused = settings ? settings.configured.collectionsPaused : null;
  return (
    <div
      className="handbook-refresh"
      role="group"
      aria-label="Collector controls"
    >
      <div className="collector-controls__actions">
        {paused === null ? (
          <Button
            type="button"
            style={buttonStyle}
            disabled={changing !== null}
            onClick={() => setPollRevision((value) => value + 1)}
          >
            Check collection state
          </Button>
        ) : (
          <Button
            type="button"
            style={buttonStyle}
            // Resuming only clears the pause flag; it cannot start a collector process.
            disabled={changing !== null || (paused && !connected)}
            liveAction
            onClick={() => void changePause(!paused)}
          >
            {paused ? 'Resume collection' : 'Pause collection'}
          </Button>
        )}
        <Button
          variant="primary"
          type="button"
          style={buttonStyle}
          disabled={
            !connected ||
            paused !== false ||
            settingsUnavailable ||
            changing !== null ||
            busy
          }
          liveAction
          onClick={() => void runNow()}
        >
          Run now
        </Button>
      </div>
      <CollectorStatusLine
        status={status}
        statusUnavailable={statusUnavailable}
        runError={runError}
        paused={paused}
        pauseUnavailable={settingsUnavailable}
        pauseChange={changing}
        pauseNote={pauseNote}
      />
      <CollectorDetails />
    </div>
  );
}

const buttonStyle = { minHeight: 44, cursor: 'pointer' } as const;

function CollectionState({
  paused,
  connected,
  unavailable,
  change,
}: {
  paused: boolean | null;
  connected: boolean;
  unavailable: boolean;
  change: PauseChange | null;
}) {
  if (change)
    return (
      <strong>
        {change === 'pause' ? 'Pausing collection…' : 'Resuming collection…'}
      </strong>
    );
  if (paused === null)
    return unavailable ? (
      <strong className="recipe-warning">
        Collection state unavailable — Run now stays off until it can be read
      </strong>
    ) : (
      <strong>Checking collection state</strong>
    );
  const stale = unavailable ? ' (last known; could not be re-read)' : '';
  if (paused)
    return (
      <span className="recipe-warning">
        <strong>Collection paused</strong>
        {stale}
        {
          ' — no new market collection starts, scheduled or manual; a capture already in progress finishes'
        }
        {connected
          ? null
          : '. Resume needs a connected collector; this control does not start the collector process'}
      </span>
    );
  return (
    <span>
      <strong>
        {connected ? 'Collection active' : 'Collection not paused'}
      </strong>
      {stale}
    </span>
  );
}

export function CollectorStatusLine({
  status,
  statusUnavailable = false,
  runError = false,
  now = Date.now(),
  paused,
  pauseUnavailable = false,
  pauseChange = null,
  pauseNote = '',
}: {
  status: CollectorStatus | null;
  statusUnavailable?: boolean;
  runError?: boolean;
  now?: number;
  /** Omit to render the collector line alone; null means not known yet. */
  paused?: boolean | null;
  pauseUnavailable?: boolean;
  pauseChange?: PauseChange | null;
  pauseNote?: string;
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
      {paused === undefined ? null : (
        <>
          <CollectionState
            paused={paused}
            connected={connected}
            unavailable={pauseUnavailable}
            change={pauseChange}
          />
          {pauseNote ? (
            <span className="recipe-warning">{` · ${pauseNote}`}</span>
          ) : null}
          {' · '}
        </>
      )}
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
            {formatTimestamp(finishedAt)}
          </time>
          {state?.lastRunStatus ? ` (${state.lastRunStatus})` : null}
        </>
      ) : (
        'none yet'
      )}
      {connected && nextDueAt && paused !== true && paused !== null ? (
        <>
          {' · Next due '}
          <time aria-label="Next due" dateTime={nextDueAt}>
            {Date.parse(nextDueAt) <= now ? 'now' : formatTimestamp(nextDueAt)}
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
