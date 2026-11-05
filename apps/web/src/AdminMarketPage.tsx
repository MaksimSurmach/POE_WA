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

import { createApiClient } from './apiClient.js';
import './adminMarket.css';
import { IntelligenceSettingsFields } from './IntelligenceSettingsFields.js';

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
const catalogClient = createApiClient('', (url, options) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
);
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
    if (
      key === 'intelligence'
        ? JSON.stringify(base[key]) !== JSON.stringify(draft[key])
        : base[key] !== draft[key]
    )
      changes[key] = draft[key];
  }
  for (const key of marketAdminSettingsSchema.keyof().options) copy(key);
  return changes;
}

export function validateSettings(draft: MarketAdminSettings) {
  const errors: Record<string, string> = {};
  const parsed = marketAdminSettingsSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      errors[issue.path.join('.')] = issue.message;
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
  const settingsRef = useRef<HTMLDetailsElement>(null);
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
  const [recipes, setRecipes] = useState<Array<{ id: string; title: string }>>(
    [],
  );
  const [catalogState, setCatalogState] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  const dirty =
    !!settings &&
    !!draft &&
    Object.keys(settingsChanges(settings.configured, draft)).length > 0;

  useEffect(() => {
    if (
      dirty ||
      settingsError ||
      Object.keys(fieldErrors).length ||
      (feedback.area === 'settings' && feedback.error)
    ) {
      if (settingsRef.current) settingsRef.current.open = true;
    }
  }, [dirty, settingsError, fieldErrors, feedback]);

  useEffect(() => {
    if (scope !== 'recipe') return;
    let active = true;
    setCatalogState('loading');
    catalogClient
      .getCatalog()
      .then((result) => {
        if (!active) return;
        setRecipes(
          result.data?.entries.map(({ recipe }) => ({
            id: recipe.id,
            title: recipe.title,
          })) ?? [],
        );
        setCatalogState('ready');
      })
      .catch(() => {
        if (active) setCatalogState('failed');
      });
    return () => {
      active = false;
    };
  }, [scope]);

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
              : scope === 'recipe' && ['idle', 'loading'].includes(catalogState)
                ? 'Loading recipes…'
                : scope === 'recipe' && !recipeId.trim()
                  ? 'Choose a recipe to continue.'
                  : '';

  return (
    <div className="market-admin" aria-busy={busy}>
      <header className="market-admin__heading">
        <div>
          <Link className="back-link" to="/">
            ← Recipe handbook
          </Link>
          <h1>Market administration</h1>
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
          {status?.collector ? (
            <p role="status">
              {status.collector.runner === 'go'
                ? 'Go collector'
                : 'Node collector'}
              :{' '}
              {status.collector.enabled
                ? (status.collector.state ?? 'waiting for heartbeat')
                : 'disabled'}
              {' · heartbeat '}
              {time(status.collector.heartbeatAt)}
              {' · queued '}
              {status.collector.queuedRequests}
              {' · claimed '}
              {status.collector.claimedRequests}
            </p>
          ) : null}
        </div>
      </header>
      <section
        className="market-admin__action-bar"
        aria-labelledby="admin-run-heading"
      >
        <h2 id="admin-run-heading" className="visually-hidden">
          Run a refresh
        </h2>
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
              <option value="all">All recipes</option>
              <option value="economy">Materials only</option>
              <option value="recipe">One recipe</option>
            </select>
          </label>
          {scope === 'recipe' ? (
            <label className="market-admin__field market-admin__recipe-field">
              Recipe
              {catalogState === 'loading' || catalogState === 'idle' ? (
                <select disabled aria-label="Recipe">
                  <option>Loading recipes…</option>
                </select>
              ) : recipes.length ? (
                <select
                  required
                  value={recipeId}
                  disabled={busy}
                  onChange={(event) => setRecipeId(event.target.value)}
                >
                  <option value="">Choose a recipe</option>
                  {recipes.map((recipe) => (
                    <option value={recipe.id} key={recipe.id}>
                      {recipe.title}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    required
                    maxLength={200}
                    value={recipeId}
                    disabled={busy}
                    onChange={(event) => setRecipeId(event.target.value)}
                  />
                  <small>
                    {catalogState === 'failed'
                      ? 'Recipe list unavailable.'
                      : 'No catalog recipes available.'}{' '}
                    Enter the recipe ID from its handbook URL.
                  </small>
                </>
              )}
            </label>
          ) : null}
          <button
            type="submit"
            disabled={!!runDisabledReason}
            aria-describedby={
              runDisabledReason ? 'admin-run-reason' : undefined
            }
          >
            {busy && feedback.area === 'refresh' ? 'Requesting…' : 'Run now'}
          </button>
          {runDisabledReason ? (
            <p id="admin-run-reason" className="market-admin__hint">
              {runDisabledReason}
            </p>
          ) : null}
          {notice('refresh')}
        </form>
      </section>
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
      {status?.warnings
        .filter(
          (warning) =>
            status.scheduler.enabled || !settings?.warnings.includes(warning),
        )
        .map((warning) => (
          <p
            className="market-admin__warning market-admin__alert"
            key={warning}
          >
            {warning}
          </p>
        ))}
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
      <section
        className="market-admin__settings"
        aria-labelledby="admin-settings-heading"
      >
        <details className="market-admin__drawer" ref={settingsRef}>
          <summary>
            <h2 id="admin-settings-heading">Settings</h2>
            {dirty ? (
              <span className="market-admin__warning">Unsaved changes</span>
            ) : null}
          </summary>
          <div className="market-admin__heading">
            <div>
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
                    <div className="market-admin__setting-group">
                      <h3>
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
                      </h3>
                      {(
                        [
                          [
                            'automaticRefreshEnabled',
                            'Automatic recipe refresh',
                          ],
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
                              setDraft({
                                ...draft,
                                [key]: event.target.checked,
                              })
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
                    </div>
                    {(
                      [
                        ['Requests', numericSettings.slice(0, 2)],
                        ['Freshness', numericSettings.slice(2, 5)],
                        ['Retention', numericSettings.slice(5)],
                      ] as const
                    ).map(([title, fields]) => (
                      <div className="market-admin__setting-group" key={title}>
                        <h3>
                          {title}
                          <small>
                            {title === 'Requests'
                              ? `${draft.requestTimeoutMs / 1000}s timeout · ${draft.collectionConcurrency} concurrent`
                              : title === 'Freshness'
                                ? `${draft.maximumQuoteAgeMs / 60_000} min maximum quote age`
                                : `${draft.rawRetentionHours}h raw · ${draft.historyRetentionDays}d history`}
                          </small>
                        </h3>
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
                      </div>
                    ))}
                    <IntelligenceSettingsFields
                      value={draft.intelligence}
                      errors={fieldErrors}
                      onChange={(intelligence) =>
                        setDraft({ ...draft, intelligence })
                      }
                    />
                  </div>
                  {dirty ? (
                    <div className="market-admin__save">
                      <button type="submit" disabled={!dirty || busy}>
                        {busy && feedback.area === 'settings'
                          ? 'Saving…'
                          : 'Save settings'}
                      </button>
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
                    </div>
                  ) : null}
                </fieldset>
              </form>
              <p className="market-admin__hint">
                Pause blocks new collection; active work can finish. Cancel an
                active run separately. {settings.applies}
                {settings.restartRequired ? ' Restart required.' : ''}
              </p>
            </>
          ) : !settingsError ? (
            <p role="status">Loading settings…</p>
          ) : null}
          {notice('settings')}
        </details>
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
      className="market-admin__connection"
      aria-labelledby="admin-status-heading"
    >
      <h2 id="admin-status-heading" className="visually-hidden">
        Market status
      </h2>
      <dl className="market-admin__overview">
        <div>
          <dt>League</dt>
          <dd>
            {status.league
              ? `${status.league.name} · ${status.league.confirmed ? 'Confirmed' : 'Last known / unconfirmed'}`
              : 'Unresolved'}
          </dd>
        </div>
        <div>
          <dt>Fresh recipes</dt>
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
          <dt>Next refresh</dt>
          <dd>
            {status.scheduler.enabled
              ? time(status.scheduler.nextRefreshAt)
              : 'Automatic refresh disabled'}
          </dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            <span
              className={
                status.trade.configured &&
                ['OK', 'succeeded'].includes(status.trade.status)
                  ? ''
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
      </dl>
      {!status.worker.healthy || !status.scheduler.healthy ? (
        <p className="market-admin__error" role="alert">
          Worker / scheduler:{' '}
          {status.worker.healthy ? 'Healthy' : 'Unavailable'} /{' '}
          {status.scheduler.healthy ? 'Healthy' : 'Unavailable'}. Check
          connection details before starting work.
        </p>
      ) : null}
      {status.ninja.cooldownUntil ? (
        <p className="market-admin__warning">
          poe.ninja is cooling down until {time(status.ninja.cooldownUntil)}.
        </p>
      ) : null}
      <details className="market-admin__diagnostics">
        <summary>Connection details</summary>
        <dl className="market-admin__status">
          <div>
            <dt>Updated</dt>
            <dd>{time(status.serverTime)}</dd>
          </div>
          <div>
            <dt>Worker / scheduler</dt>
            <dd>
              {status.worker.healthy ? 'Healthy' : 'Unavailable'} /{' '}
              {status.scheduler.healthy ? 'Healthy' : 'Unavailable'}
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
        {status.ninja.cooldownUntil ? (
          <p className="market-admin__warning">
            poe.ninja cooldown until {time(status.ninja.cooldownUntil)}
          </p>
        ) : null}
        {status.rateLimits.length ? (
          <ul className="market-admin__limits">
            {status.rateLimits.map((policy) => (
              <li key={policy.policy}>
                <strong>{policy.policy}</strong> · HTTP{' '}
                {policy.lastStatus ?? '—'} · Minimum delay{' '}
                {policy.minimumDelayMs} ms
                <br />
                Next permitted request: {time(policy.waitingUntil)}
              </li>
            ))}
          </ul>
        ) : null}
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
  const active = (run: MarketAdminRun) =>
    run.status === 'queued' || run.status === 'running';
  const ordered = [
    ...runs.filter(active),
    ...runs.filter((run) => !active(run)),
  ];
  function row(run: MarketAdminRun) {
    return (
      <li key={run.id}>
        <details className="market-admin__run-details">
          <summary>
            <span className="market-admin__run-heading">
              <strong>
                {run.scope === 'recipe'
                  ? `Recipe: ${run.recipeId}`
                  : run.scope === 'economy'
                    ? 'Material prices'
                    : 'All recipes'}
              </strong>
              <span
                className={`market-admin__badge ${run.status === 'succeeded' ? 'market-admin__success' : run.status === 'failed' ? 'market-admin__error' : 'market-admin__warning'}`}
              >
                {
                  {
                    queued: 'Queued',
                    running: 'Running',
                    succeeded: 'Completed',
                    failed: 'Failed',
                    cancelled: 'Cancelled',
                    skipped: 'Skipped',
                  }[run.status]
                }
                {run.cancelRequested ? ' · Cancellation requested' : ''}
              </span>
              <time dateTime={run.requestedAt} title={time(run.requestedAt)}>
                {new Date(run.requestedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </span>
          </summary>
          <dl>
            <dt>Source</dt>
            <dd>{run.source}</dd>
            <dt>Requested</dt>
            <dd>{time(run.requestedAt)}</dd>
            <dt>Started</dt>
            <dd>{time(run.startedAt)}</dd>
            <dt>Finished</dt>
            <dd>{time(run.finishedAt)}</dd>
            <dt>Duration</dt>
            <dd>
              {run.durationMs === null
                ? run.finishedAt
                  ? 'Finished · duration unavailable'
                  : 'In progress'
                : `${Math.round(run.durationMs / 1000)} seconds`}
            </dd>
            <dt>Queries</dt>
            <dd>
              {run.completedQueries}/{run.totalQueries} queries complete ·{' '}
              {run.failedQueries} failed
            </dd>
            <dt>Source freshness</dt>
            <dd>{time(run.sourceFreshness)}</dd>
            <dt>Error code</dt>
            <dd>{run.errorCode ?? '—'}</dd>
            <dt>Run ID</dt>
            <dd>{run.id}</dd>
          </dl>
        </details>
        {active(run) ? (
          <>
            <p>
              {run.totalQueries
                ? `${run.completedQueries + run.failedQueries}/${run.totalQueries} queries processed`
                : 'Planning queries…'}
              {run.failedQueries ? ` · ${run.failedQueries} failed` : ''}
            </p>
            <progress
              aria-label="Refresh query progress"
              max={run.totalQueries > 0 ? run.totalQueries : undefined}
              value={
                run.totalQueries > 0
                  ? run.completedQueries + run.failedQueries
                  : undefined
              }
            />
            <button
              type="button"
              disabled={busy || run.cancelRequested}
              onClick={() => onCancel(run.id)}
              aria-label={`Cancel run ${run.id}`}
            >
              {run.cancelRequested ? 'Cancellation requested' : 'Cancel run'}
            </button>
          </>
        ) : null}
        {run.errorCode ? (
          <p
            className={
              run.status === 'skipped' || run.status === 'cancelled'
                ? 'market-admin__hint'
                : 'market-admin__error'
            }
          >
            {runErrorLabel(run.errorCode)}
          </p>
        ) : null}
        {run.cooldownUntil ? (
          <p className="market-admin__warning">
            Cooldown until {time(run.cooldownUntil)}
          </p>
        ) : null}
      </li>
    );
  }
  return (
    <section
      className="market-admin__history"
      aria-labelledby="admin-history-heading"
    >
      <h2 id="admin-history-heading">Recent runs</h2>
      {runs.length ? (
        <>
          <ol className="market-admin__runs">{ordered.slice(0, 3).map(row)}</ol>
          {ordered.length > 3 ? (
            <details className="market-admin__older">
              <summary>More runs ({ordered.length - 3})</summary>
              <ol className="market-admin__runs">
                {ordered.slice(3).map(row)}
              </ol>
            </details>
          ) : null}
        </>
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
