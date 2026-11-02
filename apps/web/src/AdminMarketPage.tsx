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

import './adminMarket.css';

type Contract<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

class SettingsScheduleError extends Error {}

export function createAdminMarketClient(
  fetchImplementation = globalThis.fetch,
) {
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetchImplementation(`/api/admin/market${path}`, {
      method,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
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
        path === '/settings' || path === '/pause' || path === '/resume'
          ? 'Settings changed elsewhere. Compare latest settings, then retry; your edits will be preserved.'
          : 'Another run is active or this operation is no longer available. Check recent runs before retrying.',
      );
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = apiErrorEnvelopeSchema.safeParse(payload);
      if (
        response.status === 400 &&
        path === '/settings' &&
        error.success &&
        error.data.error.code === 'MARKET_QUERY_INVALID'
      )
        throw new SettingsScheduleError(
          'Use a valid five-field cron schedule with at least 5 minutes between refreshes.',
        );
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

export function settingsChanges(
  base: MarketAdminSettings,
  draft: MarketAdminSettings,
) {
  const changes: Partial<MarketAdminSettings> = {};
  function copy<Key extends keyof MarketAdminSettings>(key: Key) {
    if (base[key] !== draft[key]) changes[key] = draft[key];
  }
  for (const key of marketAdminSettingsSchema.keyof().options) copy(key);
  return changes;
}

export function validateSettings(draft: MarketAdminSettings) {
  const errors: Record<string, string> = {};
  const parsed = marketAdminSettingsSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      errors[String(issue.path[0])] = issue.message;
  }
  if (draft.refreshCron.trim().split(/\s+/).length !== 5)
    errors.refreshCron =
      'Use a five-field cron schedule, at least 5 minutes apart.';
  if (draft.snapshotReuseTtlMs > draft.maximumQuoteAgeMs)
    errors.snapshotReuseTtlMs = 'Reuse TTL must not exceed maximum quote age.';
  if (draft.freshnessWarningMs > draft.maximumQuoteAgeMs)
    errors.freshnessWarningMs =
      'Freshness warning must not exceed maximum quote age.';
  if (draft.rawRetentionHours > draft.historyRetentionDays * 24)
    errors.historyRetentionDays =
      'Price history must cover the raw snapshot retention period.';
  return errors;
}

export function AdminMarketPage() {
  const generation = useRef(0);
  const actionPending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [settings, setSettings] = useState<MarketAdminSettingsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<MarketAdminSettings | null>(null);
  const [status, setStatus] = useState<MarketAdminStatus | null>(null);
  const [runs, setRuns] = useState<MarketAdminRun[]>([]);
  const [settingsError, setSettingsError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [runsError, setRunsError] = useState('');
  const [feedback, setFeedback] = useState({
    area: '',
    error: '',
    message: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'all' | 'economy' | 'recipe'>('all');
  const [recipeId, setRecipeId] = useState('');
  const dirty =
    !!settings &&
    !!draft &&
    Object.keys(settingsChanges(settings.configured, draft)).length > 0;

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
        if (active) setSettingsError(errorMessage(cause));
      });
    async function poll() {
      if (polling || actionPending.current) return;
      polling = true;
      const currentGeneration = generation.current;
      const [nextStatus, nextRuns] = await Promise.allSettled([
        client.status(),
        client.runs(),
      ]);
      if (active) {
        if (nextStatus.status === 'fulfilled') {
          if (currentGeneration === generation.current) {
            setStatus(nextStatus.value);
            setStatusError('');
          }
        } else setStatusError(errorMessage(nextStatus.reason));
        if (nextRuns.status === 'fulfilled') {
          if (currentGeneration === generation.current) {
            setRuns(nextRuns.value);
            setRunsError('');
          }
        } else setRunsError(errorMessage(nextRuns.reason));
      }
      polling = false;
    }
    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  async function act(
    area: string,
    operation: () => Promise<void>,
    success: string,
  ) {
    if (actionPending.current) return;
    actionPending.current = true;
    generation.current++;
    setBusy(true);
    setFeedback({ area, error: '', message: '' });
    try {
      await operation();
      setFeedback({ area, error: '', message: success });
    } catch (cause) {
      setFeedback({ area, error: errorMessage(cause), message: '' });
    } finally {
      generation.current++;
      actionPending.current = false;
      setBusy(false);
    }
  }
  function acceptSettings(
    value: MarketAdminSettingsResponse,
    preserveEdits = false,
  ) {
    const changes =
      preserveEdits && settings && draft
        ? settingsChanges(settings.configured, draft)
        : {};
    // Pause is an independent operation; it must not discard unrelated form edits.
    delete changes.collectionsPaused;
    setSettings(value);
    setDraft({ ...value.configured, ...changes });
    setSettingsError('');
  }
  function focusInvalidSetting() {
    requestAnimationFrame(() => {
      const field = formRef.current?.querySelector<HTMLInputElement>(
        '[aria-invalid="true"]',
      );
      const group = field?.closest('details');
      if (group) group.open = true;
      field?.focus();
    });
  }
  function notice(area: string) {
    return feedback.area === area && (feedback.error || feedback.message) ? (
      <p
        className={
          feedback.error ? 'market-admin__error' : 'market-admin__success'
        }
        role={feedback.error ? 'alert' : 'status'}
      >
        {feedback.error || feedback.message}
      </p>
    ) : null;
  }
  const paused =
    settings?.configured.collectionsPaused ?? status?.collection.paused;
  const runDisabledReason = busy
    ? 'An operation is being applied.'
    : !status || statusError
      ? 'Waiting for current market status.'
      : status.activeRun
        ? 'A refresh is already active. Follow it in recent runs.'
        : paused
          ? 'Collections are paused. Resume collections to run now.'
          : !status.worker.healthy
            ? 'Worker unavailable. Restore worker health before starting a refresh.'
            : !status.collection.manualAvailable
              ? 'Manual refresh is disabled. Enable it in Settings to run now.'
              : scope === 'recipe' && !recipeId.trim()
                ? 'Enter a recipe ID to continue.'
                : '';

  return (
    <div className="market-admin" aria-busy={busy}>
      <header className="market-admin__heading">
        <div>
          <Link className="back-link" to="/">
            ← Recipe handbook
          </Link>
          <h1>Market administration</h1>
          <p>Local controls · status updates every 3 seconds</p>
        </div>
        <div className="market-admin__collection">
          <span
            className={`market-admin__badge ${paused === undefined ? '' : paused ? 'market-admin__warning' : 'market-admin__success'}`}
          >
            {paused === undefined
              ? 'Checking collection status'
              : paused
                ? 'Collections paused'
                : 'Accepting new work'}
          </span>
          <button
            type="button"
            disabled={busy || !settings}
            aria-describedby={
              busy || !settings ? 'admin-collection-reason' : undefined
            }
            onClick={() =>
              void act(
                'collection',
                async () => {
                  const latest = await client.settings();
                  acceptSettings(
                    await client.pause(!paused, latest.version),
                    true,
                  );
                },
                paused
                  ? 'Collections resumed. Unsaved settings kept.'
                  : 'New collections paused. Active work may finish; unsaved settings kept.',
              )
            }
          >
            {paused ? 'Resume collections' : 'Pause new collections'}
          </button>
          {busy || !settings ? (
            <p id="admin-collection-reason">
              {busy
                ? 'Applying a change…'
                : settingsError
                  ? 'Settings unavailable. Retry in Settings below.'
                  : 'Loading settings before changes can be applied.'}
            </p>
          ) : null}
          {notice('collection')}
        </div>
      </header>
      {statusError ? (
        <p className="market-admin__error" role="alert">
          Status unavailable: {statusError} Retrying automatically; displayed
          values may be stale.
        </p>
      ) : null}
      {status ? (
        <MarketConnectionStatus status={status} />
      ) : !statusError ? (
        <p role="status">Loading market controls…</p>
      ) : null}
      {status?.warnings.map((warning) => (
        <p className="market-admin__warning market-admin__alert" key={warning}>
          {warning}
        </p>
      ))}
      <div className="market-admin__columns">
        <section
          className="market-admin__panel"
          aria-labelledby="admin-run-heading"
        >
          <h2 id="admin-run-heading">Run a refresh</h2>
          <p>
            Update market observations for the selected scope. Active work
            finishes when paused. Cancel a run separately to request its safe
            stop.
          </p>
          <form
            className="market-admin__manual"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                'refresh',
                async () => {
                  const result = await client.refresh(
                    scope === 'recipe'
                      ? { scope, recipeId: recipeId.trim() }
                      : { scope },
                  );
                  if (
                    !result ||
                    typeof result !== 'object' ||
                    !('accepted' in result) ||
                    result.accepted !== true
                  )
                    throw new Error(
                      'Refresh was not accepted. Check collection status and recent runs before retrying.',
                    );
                },
                'Refresh accepted. Follow progress in recent runs.',
              );
            }}
          >
            <label className="market-admin__field">
              Refresh scope
              <select
                value={scope}
                disabled={busy}
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
                <option value="economy">Economy / material prices only</option>
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
                  disabled={busy}
                  onChange={(event) => setRecipeId(event.target.value)}
                />
                <small>Use the recipe ID from its handbook URL.</small>
              </label>
            ) : null}
            <button
              type="submit"
              disabled={!!runDisabledReason}
              aria-describedby="admin-run-reason"
            >
              {busy && feedback.area === 'refresh' ? 'Requesting…' : 'Run now'}
            </button>
            <p id="admin-run-reason" className="market-admin__hint">
              {runDisabledReason || 'Manual refresh is available.'}
            </p>
            {notice('refresh')}
          </form>
          <details className="market-admin__diagnostics">
            <summary>Rate limits & cooldowns</summary>
            {status?.ninja.cooldownUntil ? (
              <p>poe.ninja cooldown until {time(status.ninja.cooldownUntil)}</p>
            ) : null}
            {status?.rateLimits.length ? (
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
          </details>
        </section>
        <div>
          {runsError ? (
            <p className="market-admin__error" role="alert">
              Run history unavailable: {runsError} Retrying automatically.
            </p>
          ) : null}
          <MarketRunHistory
            runs={runs}
            busy={busy}
            onCancel={(id) =>
              void act(
                'runs',
                async () => {
                  await client.cancel(id);
                },
                'Cancellation requested. The run stops at its next safe boundary.',
              )
            }
          />
          {notice('runs')}
        </div>
      </div>
      <section
        className="market-admin__panel"
        aria-labelledby="admin-settings-heading"
      >
        <div className="market-admin__heading">
          <div>
            <h2 id="admin-settings-heading">Settings</h2>
            <p>
              {settings
                ? `Version ${settings.version} · ${settings.timezone}`
                : 'Persistent collection settings'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                'settings',
                async () => acceptSettings(await client.settings(), true),
                'Latest settings loaded. Your unsaved edits are kept.',
              )
            }
          >
            {settingsError ? 'Retry settings' : 'Compare latest settings'}
          </button>
        </div>
        {settingsError ? (
          <p className="market-admin__error" role="alert">
            Settings unavailable: {settingsError} Retry to load the form.
          </p>
        ) : null}
        {settings && draft ? (
          <>
            {settings.warnings
              .filter((warning) => !status?.warnings.includes(warning))
              .map((warning) => (
                <p className="market-admin__warning" key={warning}>
                  {warning}
                </p>
              ))}
            <form
              ref={formRef}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const errors = validateSettings(draft);
                setFieldErrors(errors);
                if (Object.keys(errors).length) {
                  setFeedback({
                    area: 'settings',
                    error: 'Check the highlighted settings before saving.',
                    message: '',
                  });
                  focusInvalidSetting();
                  return;
                }
                void act(
                  'settings',
                  async () => {
                    try {
                      acceptSettings(
                        await client.save(
                          settings.version,
                          settingsChanges(settings.configured, draft),
                        ),
                      );
                      setFieldErrors({});
                    } catch (cause) {
                      if (cause instanceof SettingsScheduleError) {
                        setFieldErrors({ refreshCron: cause.message });
                        focusInvalidSetting();
                      }
                      throw cause;
                    }
                  },
                  'Settings saved.',
                );
              }}
            >
              <fieldset disabled={busy}>
                <legend className="visually-hidden">
                  Persistent market settings
                </legend>
                <div className="market-admin__settings-groups">
                  <details className="market-admin__setting-group">
                    <summary>
                      Automation{' '}
                      <small>
                        {draft.automaticRefreshEnabled
                          ? 'Recipe refresh on'
                          : 'Recipe refresh off'}{' '}
                        ·{' '}
                        {draft.scheduledCollectionEnabled
                          ? 'Observations on'
                          : 'Observations off'}
                      </small>
                    </summary>
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
                        name="refreshCron"
                        required
                        maxLength={100}
                        value={draft.refreshCron}
                        aria-invalid={!!fieldErrors.refreshCron}
                        aria-describedby="admin-refreshCron-hint"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            refreshCron: event.target.value,
                          })
                        }
                      />
                      <small
                        id="admin-refreshCron-hint"
                        className={
                          fieldErrors.refreshCron ? 'market-admin__error' : ''
                        }
                      >
                        {fieldErrors.refreshCron ||
                          'Five fields. At least 5 minutes between refreshes.'}
                      </small>
                    </label>
                  </details>
                  {(
                    [
                      ['Requests', numericSettings.slice(0, 2)],
                      ['Freshness', numericSettings.slice(2, 5)],
                      ['Retention', numericSettings.slice(5)],
                    ] as const
                  ).map(([title, fields]) => (
                    <details
                      className="market-admin__setting-group"
                      key={title}
                    >
                      <summary>
                        {title}
                        <small>
                          {title === 'Requests'
                            ? `${draft.requestTimeoutMs / 1000}s timeout · ${draft.collectionConcurrency} concurrent`
                            : title === 'Freshness'
                              ? `${draft.maximumQuoteAgeMs / 60_000} min maximum quote age`
                              : `${draft.rawRetentionHours}h raw · ${draft.historyRetentionDays}d history`}
                        </small>
                      </summary>
                      <div className="market-admin__fields">
                        {fields.map(({ key, label, factor, min, max }) => (
                          <label className="market-admin__field" key={key}>
                            {label}
                            <input
                              name={key}
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
                              aria-invalid={!!fieldErrors[key]}
                              aria-describedby={`admin-${key}-hint`}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  [key]: event.target.valueAsNumber * factor,
                                })
                              }
                            />
                            <small
                              id={`admin-${key}-hint`}
                              className={
                                fieldErrors[key] ? 'market-admin__error' : ''
                              }
                            >
                              {fieldErrors[key] ||
                                `${min === 1 / 60 ? '0.017' : min}–${max}${settings.effective[key] !== draft[key] ? ` · Effective: ${settings.effective[key] / factor}` : ''}`}
                            </small>
                          </label>
                        ))}
                      </div>
                      {title === 'Freshness' ? (
                        <p className="market-admin__explanation">
                          Reuse TTL can avoid a new request. Maximum quote age
                          determines whether a price remains usable. Both reuse
                          TTL and freshness warning must fit within maximum
                          quote age.
                        </p>
                      ) : title === 'Retention' ? (
                        <p className="market-admin__explanation">
                          Price history must cover the raw snapshot retention
                          period.
                        </p>
                      ) : null}
                    </details>
                  ))}
                </div>
                <div className="market-admin__save">
                  <button type="submit" disabled={!dirty || busy}>
                    {busy && feedback.area === 'settings'
                      ? 'Saving…'
                      : 'Save settings'}
                  </button>
                  {dirty ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setDraft(settings.configured);
                          setFieldErrors({});
                          setFeedback({
                            area: 'settings',
                            error: '',
                            message: 'Unsaved edits discarded.',
                          });
                        }}
                      >
                        Discard edits
                      </button>
                      <span className="market-admin__warning">
                        Unsaved changes
                      </span>
                    </>
                  ) : (
                    <span>All changes saved</span>
                  )}
                </div>
              </fieldset>
            </form>
            <p className="market-admin__hint">
              {settings.applies}
              {settings.restartRequired ? ' Restart required.' : ''}
            </p>
          </>
        ) : !settingsError ? (
          <p role="status">Loading settings…</p>
        ) : null}
        {notice('settings')}
      </section>
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
      className="market-admin__panel market-admin__connection"
      aria-labelledby="admin-status-heading"
    >
      <div className="market-admin__heading">
        <h2 id="admin-status-heading">Market status</h2>
        <small>Updated {time(status.serverTime)}</small>
      </div>
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
          <dt>Sources</dt>
          <dd>
            <span
              className={
                status.trade.configured && status.trade.status === 'OK'
                  ? 'market-admin__success'
                  : 'market-admin__warning'
              }
            >
              Trade:{' '}
              {status.trade.configured
                ? sourceLabel(status.trade.status)
                : 'Not configured'}
            </span>
            <small>
              poe.ninja:{' '}
              {status.ninja.configured
                ? sourceLabel(status.ninja.status)
                : 'Not configured'}
            </small>
          </dd>
        </div>
        <div>
          <dt>Worker / scheduler</dt>
          <dd
            className={
              status.worker.healthy && status.scheduler.healthy
                ? 'market-admin__success'
                : 'market-admin__error'
            }
          >
            {status.worker.healthy ? 'Healthy' : 'Unavailable'} /{' '}
            {status.scheduler.healthy ? 'Healthy' : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Next refresh</dt>
          <dd>
            {status.scheduler.enabled
              ? time(status.scheduler.nextRefreshAt)
              : 'Automatic refresh disabled'}
          </dd>
        </div>
        <div>
          <dt>Recipe coverage</dt>
          <dd
            className={
              status.coverage.freshRecipes === status.coverage.activeRecipes &&
              status.coverage.activeRecipes > 0
                ? 'market-admin__success'
                : 'market-admin__warning'
            }
          >
            {status.coverage.freshRecipes}/{status.coverage.activeRecipes} fresh
            <small>
              {status.coverage.pricedRecipes} priced ·{' '}
              {status.coverage.warningRecipes} near expiry
            </small>
          </dd>
        </div>
        <div>
          <dt>Active refresh</dt>
          <dd>
            {status.activeRun
              ? `${status.activeRun.status} · ${status.activeRun.completedQueries + status.activeRun.failedQueries}/${status.activeRun.totalQueries} queries`
              : 'No active run'}
          </dd>
        </div>
      </dl>
      <details className="market-admin__diagnostics">
        <summary>Connection details</summary>
        <dl className="market-admin__status">
          <div>
            <dt>Trade diagnostic</dt>
            <dd>
              {status.trade.status}
              {status.trade.reason ? (
                <small>{status.trade.reason}</small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Worker heartbeat</dt>
            <dd>
              {time(status.worker.heartbeatAt)}
              <small>
                Settings version: {status.worker.settingsVersion ?? '—'}
              </small>
            </dd>
          </div>
          <div>
            <dt>Schedule</dt>
            <dd>{status.scheduler.cron}</dd>
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
            <dt>Latest snapshot</dt>
            <dd>{time(status.coverage.latestSnapshotAt)}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function sourceLabel(status: string) {
  return (
    {
      OK: 'Last fetch succeeded',
      succeeded: 'Last fetch succeeded',
      failed: 'Last fetch failed',
      'not-checked': 'Not checked yet',
      COOLDOWN: 'Cooling down',
      AUTH_REQUIRED: 'Access required',
      UNAVAILABLE: 'Unavailable',
      RATE_LIMITED: 'Rate limited',
      DISABLED: 'Disabled',
    }[status] ?? status.replaceAll('_', ' ').toLowerCase()
  );
}

function runErrorLabel(code: string) {
  return (
    {
      MARKET_COLLECTION_PAUSED: 'Skipped because collections are paused.',
      MARKET_COLLECTION_CANCELLED:
        'Cancelled. Check collected observations before starting another run.',
      MARKET_ACCESS_BLOCKED:
        'Source access is not authorized. Check provider configuration before retrying.',
      PROVIDER_AUTH_FAILED:
        'Provider authentication failed. Check provider configuration before retrying.',
      PROVIDER_ACCESS_DENIED:
        'Provider denied access. Check source authorization before retrying.',
      PROVIDER_CHALLENGE:
        'Provider challenge required. Automated access remains blocked.',
      PROVIDER_RATE_LIMITED:
        'Provider rate limit reached. Wait for the recorded cooldown before retrying.',
      PROVIDER_CIRCUIT_OPEN:
        'Provider is cooling down after errors. Wait before retrying.',
      PROVIDER_UNAVAILABLE:
        'Provider unavailable. Retry after the source recovers.',
      REFRESH_WORKER_INTERRUPTED:
        'Worker stopped before completion. Check worker health before retrying.',
      REFRESH_QUEUE_EXPIRED:
        'The queued refresh expired. Check worker health before retrying.',
    }[code] ??
    `Refresh could not complete. Check Run details for error code ${code}.`
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
                <span
                  className={`market-admin__badge ${run.status === 'succeeded' ? 'market-admin__success' : run.status === 'failed' ? 'market-admin__error' : 'market-admin__warning'}`}
                >
                  {run.status}
                  {run.cancelRequested ? ' · Cancellation requested' : ''}
                </span>
              </div>
              <p>
                {run.source} · Requested {time(run.requestedAt)} ·{' '}
                {run.durationMs === null
                  ? run.finishedAt
                    ? 'Finished · duration unavailable'
                    : 'In progress'
                  : `${Math.round(run.durationMs / 1000)} seconds`}
              </p>
              <p>
                {run.completedQueries}/{run.totalQueries} queries complete ·{' '}
                {run.failedQueries} failed · Source freshness:{' '}
                {time(run.sourceFreshness)}
              </p>
              {['queued', 'running'].includes(run.status) ? (
                <progress
                  aria-label="Refresh query progress"
                  max={run.totalQueries > 0 ? run.totalQueries : undefined}
                  value={
                    run.totalQueries > 0
                      ? run.completedQueries + run.failedQueries
                      : undefined
                  }
                />
              ) : null}
              {run.errorCode ? (
                <p className="market-admin__error">
                  {runErrorLabel(run.errorCode)}
                </p>
              ) : null}
              {run.cooldownUntil ? (
                <p>Cooldown until {time(run.cooldownUntil)}</p>
              ) : null}
              <details>
                <summary>Run details</summary>
                <dl>
                  <dt>Error code</dt>
                  <dd>{run.errorCode ?? '—'}</dd>
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
    ? cause.name === 'TimeoutError'
      ? 'The request timed out. Retry when the local server is available.'
      : cause.message
    : 'The market controls are unavailable.';
}
