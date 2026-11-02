import {
  apiErrorEnvelopeSchema,
  marketAdminRunSchema,
  marketAdminSettingsResponseSchema,
  marketAdminSettingsSchema,
  marketAdminStatusSchema,
  type MarketAdminRefresh,
  type MarketAdminRun,
  type MarketAdminSettings,
  type MarketAdminSettingsResponse,
  type MarketAdminStatus,
} from '@poe-worksmith/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { StatusPanel } from './components.js';
import './adminMarket.css';

type Contract<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export function createAdminMarketClient(
  fetchImplementation = globalThis.fetch,
) {
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetchImplementation(`/api/admin/market${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Admin access requires a local connection or an SSH tunnel. Remote proxy access is disabled.',
      );
    if (response.status === 409)
      throw new Error(
        'Settings changed or another operation is active. Reload settings before retrying; unsaved values are preserved.',
      );
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = apiErrorEnvelopeSchema.safeParse(payload);
      throw new Error(
        error.success
          ? error.data.error.message
          : `Admin request failed (${response.status}).`,
      );
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload))
      throw new Error('The admin API returned an invalid response.');
    return payload.data;
  }
  async function read<T>(path: string, contract: Contract<T>) {
    const parsed = contract.safeParse(await request(path));
    if (!parsed.success)
      throw new Error('The admin API returned an invalid response.');
    return parsed.data;
  }
  return {
    settings: () => read('/settings', marketAdminSettingsResponseSchema),
    status: () => read('/status', marketAdminStatusSchema),
    runs: () => read('/runs', marketAdminRunSchema.array()),
    async save(version: number, settings: Partial<MarketAdminSettings>) {
      return marketAdminSettingsResponseSchema.parse(
        await request('/settings', 'PATCH', { version, settings }),
      );
    },
    async pause(paused: boolean, version: number) {
      return marketAdminSettingsResponseSchema.parse(
        await request(paused ? '/pause' : '/resume', 'POST', { version }),
      );
    },
    refresh: (input: MarketAdminRefresh) => request('/refresh', 'POST', input),
    cancel: (id: string) =>
      request(`/runs/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  };
}

const client = createAdminMarketClient();
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-GB') : '—';

const numericSettings = [
  {
    key: 'requestTimeoutMs',
    label: 'Request timeout (seconds)',
    factor: 1000,
    min: 1,
    max: 30,
  },
  {
    key: 'collectionConcurrency',
    label: 'Collection concurrency',
    factor: 1,
    min: 1,
    max: 4,
  },
  {
    key: 'snapshotReuseTtlMs',
    label: 'Snapshot reuse TTL (minutes)',
    factor: 60_000,
    min: 1 / 60,
    max: 120,
  },
  {
    key: 'freshnessWarningMs',
    label: 'Freshness warning (minutes)',
    factor: 60_000,
    min: 1,
    max: 120,
  },
  {
    key: 'maximumQuoteAgeMs',
    label: 'Maximum quote age (minutes)',
    factor: 60_000,
    min: 1,
    max: 120,
  },
  {
    key: 'rawRetentionHours',
    label: 'Raw snapshot retention (hours)',
    factor: 1,
    min: 24,
    max: 2160,
  },
  {
    key: 'historyRetentionDays',
    label: 'Price history retention (days)',
    factor: 1,
    min: 14,
    max: 730,
  },
] as const;

export function AdminMarketPage() {
  const generation = useRef(0);
  const actionPending = useRef(false);
  const [settings, setSettings] = useState<MarketAdminSettingsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<MarketAdminSettings | null>(null);
  const [status, setStatus] = useState<MarketAdminStatus | null>(null);
  const [runs, setRuns] = useState<MarketAdminRun[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'all' | 'economy' | 'recipe'>('all');
  const [recipeId, setRecipeId] = useState('');
  const dirty =
    settings !== null &&
    JSON.stringify(draft) !== JSON.stringify(settings.configured);

  useEffect(() => {
    let active = true;
    let polling = false;
    client
      .settings()
      .then((value) => {
        if (active) {
          setSettings(value);
          setDraft(value.configured);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    async function poll() {
      if (polling || actionPending.current) return;
      polling = true;
      const currentGeneration = generation.current;
      try {
        const [nextStatus, nextRuns] = await Promise.all([
          client.status(),
          client.runs(),
        ]);
        if (active && currentGeneration === generation.current) {
          setStatus(nextStatus);
          setRuns(nextRuns);
        }
      } catch (cause) {
        if (active && currentGeneration === generation.current)
          setError(errorMessage(cause));
      } finally {
        polling = false;
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  async function act(operation: () => Promise<unknown>, success: string) {
    if (actionPending.current) return;
    actionPending.current = true;
    generation.current++;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      generation.current++;
      setMessage(success);
      const [nextStatus, nextRuns] = await Promise.all([
        client.status(),
        client.runs(),
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      generation.current++;
      actionPending.current = false;
      setBusy(false);
    }
  }
  function acceptSettings(value: MarketAdminSettingsResponse) {
    setSettings(value);
    setDraft(value.configured);
  }

  return (
    <div className="market-admin">
      <header className="market-admin__heading">
        <div>
          <Link className="back-link" to="/">
            ← Recipe handbook
          </Link>
          <h1>Market administration</h1>
          <p>
            Local operational controls · live status refreshes every 3 seconds
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(
              async () => acceptSettings(await client.settings()),
              'Settings reloaded.',
            )
          }
        >
          Reload settings
        </button>
      </header>
      {error ? (
        <StatusPanel tone="danger" title="Operation unavailable">
          {error}
        </StatusPanel>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!settings || !draft || !status ? (
        <StatusPanel tone="info" title="Loading market controls">
          Connect through the local application address. No browser token is
          required.
        </StatusPanel>
      ) : (
        <>
          <MarketConnectionStatus status={status} />
          {[...new Set([...status.warnings, ...settings.warnings])].map(
            (warning) => (
              <StatusPanel key={warning} tone="warning" title="Operating limit">
                {warning}
              </StatusPanel>
            ),
          )}
          <div className="market-admin__columns">
            <section
              className="market-admin__panel"
              aria-labelledby="admin-settings-heading"
            >
              <h2 id="admin-settings-heading">Collection & settings</h2>
              <p>
                Version {settings.version} · Schedule timezone:{' '}
                {settings.timezone}
              </p>
              <p>
                {settings.applies}
                {settings.restartRequired ? ' Restart required.' : ''}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = marketAdminSettingsSchema.safeParse(draft);
                  if (!parsed.success) {
                    setError('Check the setting limits before saving.');
                    return;
                  }
                  void act(
                    async () =>
                      acceptSettings(
                        await client.save(settings.version, parsed.data),
                      ),
                    'Settings saved.',
                  );
                }}
              >
                <fieldset disabled={busy}>
                  <legend className="visually-hidden">
                    Persistent market settings
                  </legend>
                  {(
                    [
                      ['automaticRefreshEnabled', 'Automatic recipe refresh'],
                      [
                        'scheduledCollectionEnabled',
                        'Scheduled market observations',
                      ],
                      ['manualRefreshEnabled', 'Allow manual refresh'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="market-admin__check" key={key}>
                      <input
                        type="checkbox"
                        checked={draft[key]}
                        onChange={(event) =>
                          setDraft({ ...draft, [key]: event.target.checked })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  <label className="market-admin__field">
                    Refresh schedule (cron)
                    <input
                      required
                      maxLength={100}
                      value={draft.refreshCron}
                      onChange={(event) =>
                        setDraft({ ...draft, refreshCron: event.target.value })
                      }
                    />
                    <small>
                      At least 5 minutes between scheduled refreshes.
                    </small>
                  </label>
                  <div className="market-admin__fields">
                    {numericSettings.map(({ key, label, factor, min, max }) => (
                      <label className="market-admin__field" key={key}>
                        {label}
                        <input
                          type="number"
                          required
                          min={min}
                          max={max}
                          step={key.endsWith('Ms') ? 'any' : 1}
                          value={
                            Number.isFinite(draft[key])
                              ? draft[key] / factor
                              : ''
                          }
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [key]: event.target.valueAsNumber * factor,
                            })
                          }
                        />
                        <small>
                          Effective: {settings.effective[key] / factor}
                        </small>
                      </label>
                    ))}
                  </div>
                  <p className="market-admin__explanation">
                    The collection interval controls when new requests run.
                    Reuse TTL controls whether an existing snapshot can avoid a
                    request. Maximum quote age controls whether a price is
                    usable. A 4-hour interval with a 30-minute TTL leaves a
                    freshness gap; retained data stays available as history.{' '}
                    History retention must cover the raw retention period.
                  </p>
                  <button type="submit" disabled={!dirty || busy}>
                    {busy ? 'Applying…' : 'Save settings'}
                  </button>
                  {dirty ? (
                    <span className="market-admin__dirty" role="status">
                      Unsaved changes
                    </span>
                  ) : null}
                </fieldset>
              </form>
            </section>
            <section
              className="market-admin__panel"
              aria-labelledby="admin-run-heading"
            >
              <h2 id="admin-run-heading">Refresh controls</h2>
              <p>
                Collections are{' '}
                <strong>
                  {status.collection.paused ? 'paused' : 'accepting new work'}
                </strong>
                . Active work finishes when paused. Cancel a run separately to
                request its safe stop.
              </p>
              <button
                type="button"
                disabled={busy || dirty}
                onClick={() =>
                  void act(
                    async () =>
                      acceptSettings(
                        await client.pause(
                          !settings.configured.collectionsPaused,
                          settings.version,
                        ),
                      ),
                    settings.configured.collectionsPaused
                      ? 'Collections resumed.'
                      : 'New collections paused; active work may finish.',
                  )
                }
              >
                {settings.configured.collectionsPaused
                  ? 'Resume collections'
                  : 'Pause new collections'}
              </button>
              {dirty ? (
                <p>Save or reload settings before pausing or resuming.</p>
              ) : null}
              <form
                className="market-admin__manual"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(
                    () =>
                      client.refresh(
                        scope === 'recipe'
                          ? { scope, recipeId: recipeId.trim() }
                          : { scope },
                      ),
                    'Refresh requested. Watch recent runs for progress.',
                  );
                }}
              >
                <label className="market-admin__field">
                  Refresh scope
                  <select
                    value={scope}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === 'all' ||
                        value === 'economy' ||
                        value === 'recipe'
                      )
                        setScope(value);
                    }}
                  >
                    <option value="all">All active recipes</option>
                    <option value="economy">
                      Economy / material prices only
                    </option>
                    <option value="recipe">One recipe</option>
                  </select>
                </label>
                {scope === 'recipe' ? (
                  <label className="market-admin__field">
                    Recipe ID
                    <input
                      required
                      maxLength={200}
                      value={recipeId}
                      onChange={(event) => setRecipeId(event.target.value)}
                    />
                  </label>
                ) : null}
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !status.collection.manualAvailable ||
                    !!status.activeRun ||
                    (scope === 'recipe' && !recipeId.trim())
                  }
                >
                  Run now
                </button>
                {!status.collection.manualAvailable ? (
                  <p>
                    Manual refresh is unavailable while collection is paused or
                    manual refresh is disabled.
                  </p>
                ) : null}
              </form>
              <h3>Rate limits & cooldowns</h3>
              {status.ninja.cooldownUntil ? (
                <p>
                  poe.ninja cooldown until {time(status.ninja.cooldownUntil)}
                </p>
              ) : null}
              {status.rateLimits.length ? (
                <ul className="market-admin__limits">
                  {status.rateLimits.map((policy) => (
                    <li key={policy.policy}>
                      <strong>{policy.policy}</strong>
                      <br />
                      Last HTTP: {policy.lastStatus ?? '—'} · Minimum delay:{' '}
                      {policy.minimumDelayMs} ms
                      <br />
                      Next permitted request: {time(policy.waitingUntil)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recorded rate limits.</p>
              )}
            </section>
          </div>
          <MarketRunHistory
            runs={runs}
            busy={busy}
            onCancel={(id) =>
              void act(
                () => client.cancel(id),
                'Cancellation requested. The run stops at its next safe boundary.',
              )
            }
          />
        </>
      )}
    </div>
  );
}

export function MarketConnectionStatus({
  status,
}: {
  status: MarketAdminStatus;
}) {
  return (
    <section
      className="market-admin__panel"
      aria-labelledby="admin-status-heading"
    >
      <h2 id="admin-status-heading">Market connection</h2>
      <dl className="market-admin__status">
        <div>
          <dt>Current league</dt>
          <dd>
            {status.league
              ? `${status.league.name} · ${status.league.confirmed ? 'Confirmed' : 'Last known / unconfirmed'}`
              : 'Unresolved'}
          </dd>
        </div>
        <div>
          <dt>Trade</dt>
          <dd>
            {status.trade.configured ? status.trade.status : 'Not configured'}
            {status.trade.reason ? <small>{status.trade.reason}</small> : null}
          </dd>
        </div>
        <div>
          <dt>poe.ninja</dt>
          <dd>
            {status.ninja.configured ? status.ninja.status : 'Not configured'}
          </dd>
        </div>
        <div>
          <dt>Worker / scheduler</dt>
          <dd>
            {status.worker.healthy ? 'Healthy' : 'Unavailable'} /{' '}
            {status.scheduler.healthy ? 'Healthy' : 'Unavailable'}
            <small>
              Worker heartbeat: {time(status.worker.heartbeatAt)} · Settings
              version: {status.worker.settingsVersion ?? '—'}
            </small>
          </dd>
        </div>
        <div>
          <dt>Last successful refresh</dt>
          <dd>{time(status.lastSuccessful?.finishedAt ?? null)}</dd>
        </div>
        <div>
          <dt>Last failed refresh</dt>
          <dd>
            {time(status.lastFailed?.finishedAt ?? null)}
            {status.lastFailed?.errorCode ? (
              <small>{status.lastFailed.errorCode}</small>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Next refresh</dt>
          <dd>
            {status.scheduler.enabled
              ? time(status.scheduler.nextRefreshAt)
              : 'Automatic refresh disabled'}
            <small>{status.scheduler.cron}</small>
          </dd>
        </div>
        <div>
          <dt>Recipe coverage</dt>
          <dd>
            {status.coverage.freshRecipes}/{status.coverage.activeRecipes} fresh
            · {status.coverage.pricedRecipes} priced ·{' '}
            {status.coverage.warningRecipes} near expiry
            <small>
              Latest snapshot: {time(status.coverage.latestSnapshotAt)}
            </small>
          </dd>
        </div>
        <div>
          <dt>Active refresh</dt>
          <dd>
            {status.activeRun
              ? `${status.activeRun.status} · ${status.activeRun.completedQueries + status.activeRun.failedQueries}/${status.activeRun.totalQueries} queries`
              : 'None'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function MarketRunHistory({
  runs,
  busy,
  onCancel,
}: {
  runs: MarketAdminRun[];
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  return (
    <section
      className="market-admin__panel"
      aria-labelledby="admin-history-heading"
    >
      <h2 id="admin-history-heading">Recent runs</h2>
      {runs.length ? (
        <ol className="market-admin__runs">
          {runs.map((run) => (
            <li key={run.id}>
              <div className="market-admin__run-heading">
                <strong>
                  {run.scope === 'recipe'
                    ? `Recipe: ${run.recipeId}`
                    : run.scope === 'economy'
                      ? 'Economy / material prices'
                      : 'All active recipes'}
                </strong>
                <span>
                  {run.status}
                  {run.cancelRequested ? ' · Cancellation requested' : ''}
                </span>
              </div>
              <p>
                {run.source} · Requested {time(run.requestedAt)} ·{' '}
                {run.durationMs === null
                  ? 'Not finished'
                  : `${Math.round(run.durationMs / 1000)} seconds`}
              </p>
              <p>
                {run.completedQueries}/{run.totalQueries} queries complete ·{' '}
                {run.failedQueries} failed · Source freshness:{' '}
                {time(run.sourceFreshness)}
              </p>
              {run.errorCode ? (
                <p className="market-admin__error">{run.errorCode}</p>
              ) : null}
              {run.cooldownUntil ? (
                <p>Cooldown until {time(run.cooldownUntil)}</p>
              ) : null}
              <details>
                <summary>Run details</summary>
                <dl>
                  <dt>Run ID</dt>
                  <dd>{run.id}</dd>
                  <dt>Started</dt>
                  <dd>{time(run.startedAt)}</dd>
                  <dt>Finished</dt>
                  <dd>{time(run.finishedAt)}</dd>
                </dl>
              </details>
              {['queued', 'running'].includes(run.status) ? (
                <button
                  type="button"
                  disabled={busy || run.cancelRequested}
                  onClick={() => onCancel(run.id)}
                  aria-label={`Cancel run ${run.id}`}
                >
                  {run.cancelRequested
                    ? 'Cancellation requested'
                    : 'Cancel run'}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>No refresh runs recorded yet.</p>
      )}
    </section>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : 'The market controls are unavailable.';
}
