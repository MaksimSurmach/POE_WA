import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  factoryAppendEventInputSchema,
  factoryCreateBatchInputSchema,
  type CatalogResponse,
  type CraftAnalysis,
  type FactoryAppendEventInput,
  type FactoryBatchListResponse,
  type FactoryBatchRecord,
  type FactoryCreateBatchInput,
  type FactorySummaryResponse,
  type LeaguesResponse,
} from '@poe-worksmith/contracts';
import { ApiClientError, createApiClient } from './apiClient.js';
import { FactoryField, TransactionFields } from './FactoryFields.js';
import { FactoryEventForm } from './FactoryEventForm.js';
import {
  FactoryBatchSummary,
  FactoryMetrics,
  factoryMoney,
} from './FactorySummary.js';
import {
  buildFactoryEvent,
  factoryErrorMessage,
  factoryFormFingerprint,
  factoryText,
  factoryTransaction,
  prepareFactoryRequest,
  reconcileFactoryPending,
  type PendingFactoryRequest,
} from './factoryForm.js';
import './factory.css';

const api = createApiClient();
function cachePending<T>(
  key: string,
  pending: PendingFactoryRequest<T> | null,
) {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch {
    /* Memory still protects retries when browser storage is unavailable. */
  }
}
function readPending<T>(
  key: string,
  parse: (input: unknown) => T,
): PendingFactoryRequest<T> | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      raw &&
      typeof raw === 'object' &&
      'fingerprint' in raw &&
      typeof raw.fingerprint === 'string' &&
      'request' in raw
    )
      return {
        fingerprint: raw.fingerprint,
        request: parse(raw.request),
        ...('rejectedConflict' in raw && raw.rejectedConflict === true
          ? { rejectedConflict: true as const }
          : {}),
      };
  } catch {
    /* Invalid or unavailable browser storage is not authoritative. */
  }
  return null;
}

export function FactoryPage() {
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [leagues, setLeagues] = useState<LeaguesResponse['data']>([]);
  const [league, setLeague] = useState(params.get('league') ?? '');
  const [recipeId, setRecipeId] = useState(params.get('recipe') ?? '');
  const [selectedId, setSelectedId] = useState(params.get('batch') ?? '');
  const [analysis, setAnalysis] = useState<CraftAnalysis | null>(null);
  const [batches, setBatches] = useState<
    FactoryBatchListResponse['data'] | null
  >(null);
  const [summary, setSummary] = useState<FactorySummaryResponse['data'] | null>(
    null,
  );
  const [record, setRecord] = useState<FactoryBatchRecord | null>(null);
  const [recordReady, setRecordReady] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const explicitRefresh = useRef(false);
  const [pendingEvent, setPendingEvent] =
    useState<PendingFactoryRequest<FactoryAppendEventInput> | null>(null);
  const [pendingCreate, setPendingCreate] =
    useState<PendingFactoryRequest<FactoryCreateBatchInput> | null>(null);
  const eventKey = `worksmith:factory:event:${selectedId}`;
  const createKey = `worksmith:factory:create:${league}`;

  useEffect(() => {
    let active = true;
    void Promise.all([api.getCatalog(), api.getLeagues()])
      .then(([catalogValue, leagueValue]) => {
        if (!active) return;
        setCatalog(catalogValue);
        setLeagues(leagueValue.data);
        setLeague(
          (current) =>
            current ||
            leagueValue.data.find((value) => value.isCurrent)?.name ||
            '',
        );
      })
      .catch((failure) => {
        if (active) setError(factoryErrorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!league) return;
    let active = true;
    setBatches(null);
    setSummary(null);
    setError('');
    void Promise.all([
      api.getFactoryBatches(league, offset),
      api.getFactorySummary(league),
    ])
      .then(([list, totals]) => {
        if (active) {
          setBatches(list.data);
          setSummary(totals.data);
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            `Owner access required for My Factory. ${factoryErrorMessage(failure)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [league, offset, refresh]);
  useEffect(() => {
    setAnalysis(null);
    setAnalysisError('');
    if (!recipeId || !league) return;
    let active = true;
    void api
      .getCraftAnalysis(recipeId, league)
      .then((response) => {
        if (active) setAnalysis(response.data);
      })
      .catch((failure) => {
        if (active) setAnalysisError(factoryErrorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [recipeId, league, refresh]);
  useEffect(() => {
    setPendingCreate(
      readPending(createKey, (value) =>
        factoryCreateBatchInputSchema.parse(value),
      ),
    );
  }, [createKey]);
  useEffect(() => {
    setRecord((current) => (current?.batch.id === selectedId ? current : null));
    setRecordReady(false);
    setMutationError('');
    const pending =
      readPending(eventKey, (value) =>
        factoryAppendEventInputSchema.parse(value),
      ) ?? (record?.batch.id === selectedId ? pendingEvent : null);
    setPendingEvent(pending);
    const wasExplicitRefresh = explicitRefresh.current;
    explicitRefresh.current = false;
    if (!selectedId) return;
    let active = true;
    void api
      .getFactoryBatch(selectedId)
      .then((response) => {
        if (active) {
          setRecord(response.data);
          setRecordReady(true);
          const resolved = reconcileFactoryPending(
            pending,
            response.data.events,
            wasExplicitRefresh,
          );
          if (resolved) {
            setPendingEvent(null);
            cachePending(eventKey, null);
            setNotice(
              resolved === 'recorded'
                ? 'The pending event was already recorded. A new submission will create a new event.'
                : 'The conflicting event was not recorded. Current batch loaded; you may submit your preserved inputs again.',
            );
          }
        }
      })
      .catch((failure) => {
        if (active) setMutationError(factoryErrorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [selectedId, eventKey, refresh]);

  function selectBatch(id: string) {
    setSelectedId(id);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('batch', id);
      next.set('league', league);
      return next;
    });
  }
  function changeLeague(next: string) {
    setLeague(next);
    setSelectedId('');
    setOffset(0);
    setParams((previous) => {
      const value = new URLSearchParams(previous);
      value.set('league', next);
      value.delete('batch');
      return value;
    });
  }

  async function createBatch(form?: FormData) {
    if (mutationLock.current) return;
    setMutationError('');
    setNotice('');
    try {
      const pending = form
        ? prepareFactoryRequest(
            pendingCreate,
            `${recipeId}:${analysis?.recipeHash}:${league}:${factoryFormFingerprint(form)}`,
            () =>
              factoryCreateBatchInputSchema.parse({
                recipeId,
                recipeHash: analysis?.recipeHash,
                league,
                plannedBudget: factoryTransaction(form),
                notes: factoryText(form, 'batchNotes'),
                ...(factoryText(form, 'startedAt')
                  ? {
                      startedAt: new Date(
                        factoryText(form, 'startedAt'),
                      ).toISOString(),
                    }
                  : {}),
                ...(factoryText(form, 'forecastRunId')
                  ? { forecastRunId: factoryText(form, 'forecastRunId') }
                  : {}),
                idempotencyKey: crypto.randomUUID(),
              }),
          )
        : pendingCreate;
      if (!pending) throw new Error('No pending batch request.');
      setPendingCreate(pending);
      cachePending(createKey, pending);
      mutationLock.current = true;
      setBusy(true);
      const response = await api.createFactoryBatch(pending.request);
      setPendingCreate(null);
      cachePending(createKey, null);
      selectBatch(response.data.batch.id);
      setNotice(
        'Batch started. Record purchases, consumption and each crafted result.',
      );
      setRefresh((value) => value + 1);
    } catch (failure) {
      setMutationError(factoryErrorMessage(failure));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function appendEvent(form?: FormData): Promise<boolean> {
    if (mutationLock.current || !selectedId) return false;
    let attemptedRequest: PendingFactoryRequest<FactoryAppendEventInput> | null =
      null;
    setMutationError('');
    setNotice('');
    try {
      const pending = form
        ? prepareFactoryRequest(
            pendingEvent,
            factoryFormFingerprint(form),
            () =>
              factoryAppendEventInputSchema.parse({
                expectedVersion: record?.version,
                idempotencyKey: crypto.randomUUID(),
                event: buildFactoryEvent(
                  form,
                  crypto.randomUUID(),
                  new Date().toISOString(),
                ),
              }),
          )
        : pendingEvent;
      if (!pending) throw new Error('No pending event request.');
      attemptedRequest = pending;
      setPendingEvent(pending);
      cachePending(eventKey, pending);
      mutationLock.current = true;
      setBusy(true);
      await api.appendFactoryEvent(selectedId, pending.request);
      setPendingEvent(null);
      cachePending(eventKey, null);
      setRecordReady(false);
      const latest = await api.getFactoryBatch(selectedId);
      setRecord(latest.data);
      setRecordReady(true);
      setNotice(
        'Event recorded. Totals use the latest confirmed batch version.',
      );
      setRefresh((value) => value + 1);
      return true;
    } catch (failure) {
      if (
        failure instanceof ApiClientError &&
        failure.status === 400 &&
        failure.envelope.error.code === 'FACTORY_LEDGER_INVALID'
      ) {
        setPendingEvent(null);
        cachePending(eventKey, null);
      } else if (failure instanceof ApiClientError && failure.status === 409) {
        const pending =
          attemptedRequest ??
          readPending(eventKey, (value) =>
            factoryAppendEventInputSchema.parse(value),
          );
        if (pending) {
          const rejected = { ...pending, rejectedConflict: true as const };
          setPendingEvent(rejected);
          cachePending(eventKey, rejected);
        }
      }
      setMutationError(factoryErrorMessage(failure));
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function download(format: 'csv' | 'json') {
    try {
      const file = await api.exportFactoryBatch(selectedId, format);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setMutationError(factoryErrorMessage(failure));
    }
  }
  function submitBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createBatch(new FormData(event.currentTarget));
  }
  const recipes = catalog?.data?.entries ?? [];
  return (
    <article className="factory-page">
      <header className="catalog-heading">
        <div>
          <h1>My Factory</h1>
          <p>Actual production, inventory and confirmed sales.</p>
        </div>
        <div className="factory-actions">
          <label>
            Factory league
            <select
              value={league}
              disabled={busy}
              onChange={(event) => changeLeague(event.target.value)}
            >
              <option value="">Choose league</option>
              {leagues.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              explicitRefresh.current = true;
              setRefresh((value) => value + 1);
            }}
          >
            Refresh factory
          </button>
        </div>
      </header>
      {error ? (
        <p role="alert" className="recipe-warning">
          {error}
        </p>
      ) : null}
      {mutationError ? (
        <p role="alert" className="recipe-warning">
          {mutationError} Your inputs are preserved. If a request outcome is
          unknown, retry the exact pending request before creating another
          transaction. After a version conflict, refresh to verify the event was
          not recorded before resubmitting.
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {summary ? (
        <details className="factory-panel">
          <summary>
            League totals · {summary.coverage.includedBatches} of{' '}
            {summary.coverage.totalBatches} batches
          </summary>
          {!summary.coverage.complete ? (
            <p className="recipe-warning">
              Partial coverage. These totals do not include every batch.
            </p>
          ) : null}
          <FactoryMetrics metrics={summary.metrics} />
        </details>
      ) : null}
      {batches ? (
        <>
          <details
            className="factory-panel"
            open={Boolean(recipeId && !selectedId)}
          >
            <summary>Start a batch</summary>
            <form onSubmit={submitBatch} aria-label="Start production batch">
              <fieldset disabled={busy} className="factory-fields">
                <label>
                  Crafting recipe
                  <select
                    value={recipeId}
                    onChange={(event) => setRecipeId(event.target.value)}
                    required
                  >
                    <option value="">Choose recipe</option>
                    {recipes.map(({ recipe }) => (
                      <option key={recipe.id} value={recipe.id}>
                        {recipe.title}
                      </option>
                    ))}
                    {recipeId &&
                    !recipes.some(({ recipe }) => recipe.id === recipeId) ? (
                      <option value={recipeId}>{recipeId}</option>
                    ) : null}
                  </select>
                </label>
                <FactoryField
                  name="batchNotes"
                  label="Batch notes"
                  required={false}
                  maxLength={2000}
                />
              </fieldset>
              <FactoryField
                name="startedAt"
                label="Production started at (local; blank means now)"
                type="datetime-local"
                step="0.001"
                required={false}
              />
              <p className="factory-note">
                For historical transactions, set production start no later than
                the first recorded purchase. Future start times are not
                accepted.
              </p>
              <TransactionFields
                quantity={false}
                label="Planned budget (not actual spending)"
              />
              <FactoryField
                name="forecastRunId"
                label="Saved risk simulation ID (optional)"
                value={params.get('forecast') ?? ''}
                required={false}
              />
              <p className="factory-note">
                A linked forecast is frozen at creation. An incomplete EV model
                does not prevent tracking real spending. All accounting totals
                are chaos at recorded transaction rates.
              </p>
              {analysisError ? <p role="alert">{analysisError}</p> : null}
              <button type="submit" disabled={busy || !analysis || !recipeId}>
                {busy ? 'Saving…' : 'Start batch'}
              </button>
            </form>
            {pendingCreate ? (
              <div className="factory-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createBatch()}
                >
                  Retry exact pending batch
                </button>
                <span className="factory-note">
                  {pendingCreate.request.recipeId} ·{' '}
                  {pendingCreate.request.league}
                </span>
              </div>
            ) : null}
          </details>
          <section className="factory-panel">
            <h2>Production batches</h2>
            {batches.batches.length ? (
              <div className="factory-scroll">
                <table className="factory-table">
                  <thead>
                    <tr>
                      <th>Batch / recipe</th>
                      <th>Status</th>
                      <th>Realized profit</th>
                      <th>Cash flow</th>
                      <th>Unsold inventory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.batches.map((batch) => (
                      <tr key={batch.batch.id}>
                        <td>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => selectBatch(batch.batch.id)}
                          >
                            {batch.batch.id.slice(0, 8)} ·{' '}
                            {recipes.find(
                              (entry) =>
                                entry.recipe.id === batch.batch.recipeId,
                            )?.recipe.title ?? batch.batch.recipeId}
                          </button>
                          <small>
                            {new Date(batch.batch.startedAt).toLocaleString(
                              'en-US',
                            )}
                          </small>
                        </td>
                        <td>{batch.projection.status}</td>
                        <td>
                          {factoryMoney(
                            batch.projection.metrics.realizedProfit,
                          )}
                        </td>
                        <td>
                          {factoryMoney(batch.projection.metrics.cashFlow)}
                        </td>
                        <td>
                          {factoryMoney(batch.projection.metrics.inventoryCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="factory-note">No batches in this league yet.</p>
            )}
            <div className="factory-actions">
              <button
                type="button"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Previous batches
              </button>
              <span className="factory-note">
                {batches.total ? offset + 1 : 0}–
                {Math.min(offset + batches.batches.length, batches.total)} of{' '}
                {batches.total}
              </span>
              <button
                type="button"
                disabled={busy || offset + batches.limit >= batches.total}
                onClick={() => setOffset(offset + 20)}
              >
                Next batches
              </button>
            </div>
          </section>
        </>
      ) : !error && league ? (
        <p role="status">Loading private factory ledger…</p>
      ) : null}
      {record ? (
        <section className="factory-panel">
          <FactoryBatchSummary record={record} />
          <div className="factory-actions">
            <button type="button" onClick={() => void download('csv')}>
              Export CSV
            </button>
            <button type="button" onClick={() => void download('json')}>
              Export JSON
            </button>
          </div>
          <h2>Record production and sales</h2>
          {pendingEvent ? (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void appendEvent()}
              >
                Retry exact pending event
              </button>
              <p className="factory-note">
                {pendingEvent.request.event.payload.type} ·{' '}
                {pendingEvent.request.event.occurredAt}. The saved request keeps
                its original ID, version and exchange rate.
              </p>
            </div>
          ) : null}
          <FactoryEventForm
            key={record.batch.id}
            projection={record.projection}
            events={record.events}
            targetSignature={record.batch.targetSignature}
            outcomeModel={record.batch.forecast?.analysisInput.model ?? null}
            busy={busy || !recordReady}
            onSubmit={appendEvent}
          />
        </section>
      ) : selectedId && !mutationError ? (
        <p role="status">Loading selected batch…</p>
      ) : null}
    </article>
  );
}
