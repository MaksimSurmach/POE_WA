import { Button, Input, NativeSelect, TableSurface, TextArea } from './ui.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  CraftAnalysis,
  CraftRiskRun,
  CraftModelSaveInput,
  CraftModelRecord,
} from '@poe-worksmith/contracts';
import {
  outcomeAnalysisInputSchema,
  outcomeActionValuesSchema,
  recommendOutcomeAction,
  type OutcomeAnalysisInput,
  type OutcomeModel,
} from '@poe-worksmith/domain';
import { createApiClient } from './apiClient.js';
import { GuidedOutcomeEditor, modelInputError } from './GuidedOutcomeEditor.js';
import {
  CraftEconomicsSummary,
  CraftRiskResult,
  OutcomeModelSummary,
  OutcomePriceEvidence,
} from './CraftRiskSummary.js';

const api = createApiClient();
const activeStatuses = new Set(['queued', 'running']);

export function parseAdvancedOutcomeInput(
  text: string,
  league: string,
  now: string,
) {
  if (new TextEncoder().encode(text).length > 128 * 1024)
    throw new Error('Model input exceeds 128 KiB.');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'Enter an object containing model, currency, prices and valuations.',
    );
  return outcomeAnalysisInputSchema.parse({ ...value, league, now });
}

export function outcomeEditorDocument(
  record: Pick<
    CraftModelRecord,
    'model' | 'currency' | 'prices' | 'valuations'
  > | null,
  embeddedModel: OutcomeModel | null,
) {
  if (record)
    return JSON.stringify(
      {
        model: record.model,
        currency: record.currency,
        prices: record.prices,
        valuations: record.valuations,
      },
      null,
      2,
    );
  return embeddedModel
    ? JSON.stringify(
        { model: embeddedModel, currency: 'chaos', prices: {}, valuations: {} },
        null,
        2,
      )
    : '';
}

function riskStorageKey(recipeId: string, leagueId: string) {
  return `worksmith-risk:${recipeId}:${leagueId}`;
}

export function CraftRiskSection({ recipeId }: { recipeId: string }) {
  const [data, setData] = useState<CraftAnalysis | null>(null);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [advanced, setAdvanced] = useState('');
  const [modelError, setModelError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<CraftRiskRun | null>(null);
  const [riskError, setRiskError] = useState('');
  const [starting, setStarting] = useState(false);
  const [objective, setObjective] = useState<
    'single-target' | 'attempts' | 'successes'
  >('single-target');
  const [count, setCount] = useState('1');
  const [budget, setBudget] = useState('');
  const [seed, setSeed] = useState('worksmith-1');
  const [trials, setTrials] = useState('1000');
  const [withinRuns, setWithinRuns] = useState('100');
  const [maxTransitions, setMaxTransitions] = useState('10000');
  const modelOperation = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await api.getCraftAnalysis(recipeId);
        if (active) {
          setData(response.data);
          setLoadError('');
        }
      } catch (error) {
        if (active) setLoadError(modelInputError(error));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recipeId, revision]);

  const model = data?.modelRecord;
  const visibleModel = model?.model ?? data?.embeddedModel;
  useEffect(() => {
    setAdvanced(
      outcomeEditorDocument(model ?? null, data?.embeddedModel ?? null),
    );
    setJob(null);
    setRiskError('');
    if (!data?.canEdit || !data.leagueId || !model) return;
    let active = true;
    try {
      const savedId = sessionStorage.getItem(
        riskStorageKey(recipeId, data.leagueId),
      );
      if (savedId)
        void api
          .getCraftRisk(savedId)
          .then((response) => {
            if (
              active &&
              response.data.modelId === model.id &&
              response.data.recipeHash === data.recipeHash
            ) {
              setJob(response.data);
              const request = response.data.request;
              setObjective(request.objective.kind);
              setCount(String(request.objective.count));
              setBudget(request.budget);
              setSeed(request.seed);
              setTrials(String(request.trials));
              setWithinRuns(String(request.reachWithinAttempts));
              setMaxTransitions(String(request.maxTransitions));
            }
          })
          .catch(() => {
            /* A missing historical job does not block a new simulation. */
          });
    } catch {
      /* Session storage can be disabled; server results remain durable. */
    }
    return () => {
      active = false;
    };
  }, [recipeId, model?.id, data?.leagueId, data?.recipeHash, data?.canEdit]);

  useEffect(() => {
    if (!job || !activeStatuses.has(job.status) || riskError) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .getCraftRisk(job.id)
        .then((response) => {
          if (active) setJob(response.data);
        })
        .catch((error) => {
          if (active) setRiskError(modelInputError(error));
        });
    }, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [job, riskError]);

  async function saveModel(input: OutcomeAnalysisInput) {
    if (!data?.canEdit || !data.league)
      throw new Error('Owner access and a current league are required.');
    if (input.currency !== 'chaos' && input.currency !== 'divine')
      throw new Error('Choose chaos or divine for the model currency.');
    const payload: Omit<CraftModelSaveInput, 'idempotencyKey'> = {
      recipeId,
      recipeHash: data.recipeHash,
      league: data.league,
      expectedRevision: model?.revision ?? null,
      model: input.model,
      currency: input.currency,
      prices: input.prices,
      valuations: input.valuations,
    };
    const fingerprint = JSON.stringify(payload);
    if (modelOperation.current?.fingerprint !== fingerprint)
      modelOperation.current = { fingerprint, id: crypto.randomUUID() };
    const response = await api.saveCraftModel({
      ...payload,
      idempotencyKey: modelOperation.current.id,
    });
    setData({
      ...data,
      modelRecord: response.data,
      analysis: null,
      unavailableReasons: ['Recalculating the saved model.'],
    });
    setNotice(
      `Model revision ${response.data.revision} saved. Earlier revisions remain preserved.`,
    );
    setRevision((value) => value + 1);
  }

  async function saveAdvanced(event: FormEvent) {
    event.preventDefault();
    if (!data?.league) return;
    setSaving(true);
    setModelError('');
    try {
      await saveModel(
        parseAdvancedOutcomeInput(
          advanced,
          data.league,
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      setModelError(modelInputError(error));
    } finally {
      setSaving(false);
    }
  }

  async function startRisk(event: FormEvent) {
    event.preventDefault();
    if (!data?.league || !model) return;
    setStarting(true);
    setRiskError('');
    try {
      const response = await api.createCraftRisk({
        recipeId,
        recipeHash: data.recipeHash,
        league: data.league,
        modelId: model.id,
        idempotencyKey: crypto.randomUUID(),
        simulation: {
          objective: {
            kind: objective,
            count: objective === 'single-target' ? 1 : Number(count),
          },
          budget: budget.trim(),
          seed,
          trials: Number(trials),
          maxTransitions: Number(maxTransitions),
          reachWithinAttempts: Number(withinRuns),
        },
      });
      setJob(response.data);
      if (data.leagueId) {
        try {
          sessionStorage.setItem(
            riskStorageKey(recipeId, data.leagueId),
            response.data.id,
          );
        } catch {
          /* Optional browser resume only. */
        }
      }
    } catch (error) {
      setRiskError(modelInputError(error));
    } finally {
      setStarting(false);
    }
  }

  async function cancelRisk() {
    if (!job) return;
    try {
      setJob((await api.cancelCraftRisk(job.id, crypto.randomUUID())).data);
      setRiskError('');
    } catch (error) {
      setRiskError(modelInputError(error));
    }
  }

  const running = Boolean(job && activeStatuses.has(job.status));
  return (
    <section
      className="detail-section craft-risk"
      aria-labelledby="craft-risk-heading"
    >
      <h2 id="craft-risk-heading">Expected value &amp; risk</h2>
      <div className="craft-risk__body">
        {loadError ? (
          <div role="alert" className="recipe-warning">
            <p>Analysis could not be checked: {loadError}</p>
            <Button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry analysis
            </Button>
          </div>
        ) : !data ? (
          <p role="status">Loading outcome analysis…</p>
        ) : null}
        {data ? (
          <>
            <p className="catalog-price-note">
              {data.league ?? 'No current league'} · Recipe revision{' '}
              {data.recipeHash.slice(0, 10)}
              {model ? ` · Model revision ${model.revision}` : ''} · Checked{' '}
              <time dateTime={data.evaluatedAt}>
                {new Date(data.evaluatedAt).toLocaleString('en-US')}
              </time>
            </p>
            {!loadError && data.analysis ? (
              <CraftEconomicsSummary analysis={data.analysis} />
            ) : (
              <div className="craft-risk__notice" role="status">
                <strong>EV unavailable</strong>
                <ul>
                  {(loadError
                    ? ['Current evidence could not be rechecked.']
                    : data.unavailableReasons.length
                      ? data.unavailableReasons
                      : ['Missing outcome probabilities.']
                  ).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {visibleModel ? (
              <details>
                <summary>Method outcomes and probability evidence</summary>
                <OutcomeModelSummary model={visibleModel} />
                <OutcomePriceEvidence
                  prices={data.prices}
                  valuations={data.valuations}
                />
              </details>
            ) : (
              <p className="catalog-price-note">
                The existing target-cost estimate does not define salvage
                outcomes or a full probability distribution. No rates have been
                inferred from it.
              </p>
            )}
            {notice ? <p role="status">{notice}</p> : null}
            {data.canEdit && data.league ? (
              <>
                <details>
                  <summary>
                    {model
                      ? 'Create a replacement model revision'
                      : 'Define outcome probabilities and values'}
                  </summary>
                  <GuidedOutcomeEditor
                    key={`${data.recipeHash}:${data.league}`}
                    league={data.league}
                    disabled={saving || Boolean(loadError)}
                    onSave={saveModel}
                  />
                </details>
                <details>
                  <summary>
                    Advanced model: conditional stages, retries and recovery
                  </summary>
                  <p className="catalog-price-note">
                    Import an object with model, currency, prices and
                    valuations. Stage costs are paid on entry; outcome costs on
                    that transition. Initial non-base setup is paid once; an
                    initial base is repurchased after a consumed result. Every
                    numerical probability and price needs provenance. Unknown
                    probability must remain null. Maximum 128 KiB.
                  </p>
                  <p className="catalog-price-note">
                    For matching.kind = exact-target, this recipe's signature is{' '}
                    <code className="craft-risk__signature">
                      {data.targetSignature}
                    </code>
                    . Only matching, sufficiently supported market evidence may
                    supply a resale value.
                  </p>
                  <form onSubmit={saveAdvanced} className="craft-risk__editor">
                    <label>
                      Model and valuation JSON
                      <TextArea
                        className="craft-risk__json"
                        rows={12}
                        value={advanced}
                        onChange={(event) => setAdvanced(event.target.value)}
                        placeholder='{"model": {"version": 1, "id": "your-model", "startStageId": "...", "stages": [...]}, "currency": "chaos", "prices": {}, "valuations": {}}'
                        spellCheck={false}
                      />
                    </label>
                    {modelError ? (
                      <p role="alert" className="recipe-warning">
                        {modelError}
                      </p>
                    ) : null}
                    <Button
                      type="submit"
                      disabled={saving || Boolean(loadError)}
                    >
                      {saving ? 'Saving…' : 'Validate and save new revision'}
                    </Button>
                  </form>
                </details>
              </>
            ) : (
              <p className="catalog-price-note">
                Model editing and simulations require local owner access.
              </p>
            )}
            <h3>Budget for your crafting objective</h3>
            <p className="catalog-price-note">
              One target item, a fixed number of method runs, and a number of
              successful target items have different bankroll distributions. A
              method run ends in a terminal outcome and includes its declared
              retries; it is not one currency roll.
            </p>
            <form onSubmit={startRisk} className="craft-risk__simulation">
              <fieldset
                disabled={
                  !data.canEdit ||
                  !model ||
                  starting ||
                  running ||
                  Boolean(loadError)
                }
                className="craft-risk__fields"
              >
                <legend className="visually-hidden">Simulation inputs</legend>
                <label>
                  Objective
                  <NativeSelect
                    value={objective}
                    onChange={(event) =>
                      setObjective(event.target.value as typeof objective)
                    }
                  >
                    <option value="single-target">One target item</option>
                    <option value="attempts">N method runs</option>
                    <option value="successes">N target items</option>
                  </NativeSelect>
                </label>
                <label>
                  {objective === 'attempts' ? 'Method runs' : 'Target items'}
                  <Input
                    type="number"
                    min="1"
                    max="1000"
                    value={objective === 'single-target' ? '1' : count}
                    disabled={objective === 'single-target'}
                    onChange={(event) => setCount(event.target.value)}
                  />
                </label>
                <label>
                  Available budget ({model?.currency ?? 'model currency'})
                  <Input
                    inputMode="decimal"
                    maxLength={40}
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="Enter your budget"
                  />
                </label>
                <label>
                  Seed
                  <Input
                    value={seed}
                    onChange={(event) => setSeed(event.target.value)}
                    maxLength={100}
                  />
                </label>
                <label>
                  Simulation trials
                  <NativeSelect
                    value={trials}
                    onChange={(event) => setTrials(event.target.value)}
                  >
                    <option value="1000">1,000</option>
                    <option value="5000">5,000</option>
                    <option value="10000">10,000</option>
                  </NativeSelect>
                </label>
                <label>
                  Check first target within N method runs
                  <Input
                    type="number"
                    min="1"
                    max="1000000"
                    value={withinRuns}
                    onChange={(event) => setWithinRuns(event.target.value)}
                  />
                </label>
                <label>
                  Maximum stage steps per trial
                  <Input
                    type="number"
                    min="1"
                    max="100000"
                    value={maxTransitions}
                    onChange={(event) => setMaxTransitions(event.target.value)}
                  />
                </label>
              </fieldset>
              <div className="craft-risk__actions">
                <Button
                  type="submit"
                  disabled={
                    !data.canEdit ||
                    !model ||
                    starting ||
                    running ||
                    Boolean(loadError)
                  }
                >
                  {starting ? 'Starting simulation…' : 'Simulate objective'}
                </Button>
                {running ? (
                  <Button
                    type="button"
                    onClick={() => void cancelRisk()}
                    disabled={job?.cancelRequested}
                  >
                    Cancel simulation
                  </Button>
                ) : null}
              </div>
            </form>
            {job ? (
              <div aria-live="polite">
                <p>
                  {job.cancelRequested && running
                    ? 'Cancellation requested'
                    : `Simulation ${job.status}`}
                  {running ? ` · ${job.progress}%` : ''}
                </p>
                {running ? (
                  <progress
                    max={100}
                    value={job.progress}
                    aria-label="Simulation progress"
                  />
                ) : null}
                {job.error ? (
                  <p className="recipe-warning">{job.error}</p>
                ) : null}
              </div>
            ) : null}
            {riskError ? (
              <div role="alert" className="recipe-warning">
                <p>{riskError}</p>
                {job && running ? (
                  <Button type="button" onClick={() => setRiskError('')}>
                    Resume progress checks
                  </Button>
                ) : null}
              </div>
            ) : null}
            {job?.result ? (
              <>
                <p className="catalog-price-note">
                  Saved objective:{' '}
                  {job.request.objective.kind === 'single-target'
                    ? 'one target item'
                    : `${job.request.objective.count} ${job.request.objective.kind === 'attempts' ? 'method runs' : 'target items'}`}{' '}
                  · Budget: {job.request.budget} {job.request.analysis.currency}{' '}
                  · Evidence captured{' '}
                  {new Date(job.request.analysis.now).toLocaleString('en-US')}.
                  Results are fixed to this saved input, not live prices.
                </p>
                <CraftRiskResult result={job.result} />
                {job.result.status === 'complete' && data.league ? (
                  <Link
                    to={`/factory?recipe=${encodeURIComponent(recipeId)}&league=${encodeURIComponent(data.league)}&forecast=${encodeURIComponent(job.id)}`}
                  >
                    Start a batch with this frozen forecast →
                  </Link>
                ) : null}
              </>
            ) : null}
            <details>
              <summary>Compare next action for an observed result</summary>
              <OutcomeActionComparison currency={model?.currency ?? 'chaos'} />
            </details>
          </>
        ) : null}
      </div>
    </section>
  );
}

const actionNames = {
  'keep-crafting': 'Keep crafting',
  sell: 'Sell result',
  recover: 'Recover',
  stop: 'Stop',
};
export function OutcomeActionComparison({ currency }: { currency: string }) {
  const [values, setValues] = useState(
    Object.fromEntries(
      Object.keys(actionNames).map((key) => [key, { min: '', max: '' }]),
    ),
  );
  const [source, setSource] = useState('');
  const parsed = outcomeActionValuesSchema.safeParse(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value.min.trim() && value.max.trim()
          ? { min: value.min.trim(), max: value.max.trim() }
          : null,
      ]),
    ),
  );
  const recommendation = !source.trim()
    ? {
        action: null,
        reason:
          'Decision unavailable — document the source and assumptions for these alternatives.',
      }
    : parsed.success
      ? recommendOutcomeAction(parsed.data)
      : {
          action: null,
          reason:
            'Decision unavailable — use ordered numeric ranges in every alternative.',
        };
  return (
    <div className="craft-risk__editor">
      <p className="catalog-price-note">
        Unsaved what-if scenario for the item you currently hold. Enter
        incremental net proceeds from this point onward, after additional costs;
        exclude money already spent. Include all four alternatives. Zero for
        stopping must be an explicit assumption, not a hidden default.
      </p>
      <div className="craft-risk__table-wrap">
        <TableSurface>
          <table className="table__content">
            <caption>Incremental net value ({currency})</caption>
            <thead className="table__header">
              <tr className="table__row">
                <th className="table__column">Action</th>
                <th className="table__column">Minimum</th>
                <th className="table__column">Maximum</th>
              </tr>
            </thead>
            <tbody className="table__body">
              {Object.entries(actionNames).map(([key, label]) => (
                <tr className="table__row" key={key}>
                  <th className="table__column">{label}</th>
                  {(['min', 'max'] as const).map((bound) => (
                    <td className="table__cell" key={bound}>
                      <Input
                        aria-label={`${label} ${bound === 'min' ? 'minimum' : 'maximum'} net value`}
                        inputMode="decimal"
                        maxLength={40}
                        value={values[key]![bound]}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [key]: {
                              ...current[key]!,
                              [bound]: event.target.value,
                            },
                          }))
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableSurface>
      </div>
      <label>
        Evidence and assumptions for these action values
        <TextArea
          rows={2}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          maxLength={2000}
        />
      </label>
      <p role="status">
        <strong>
          {recommendation.action
            ? actionNames[recommendation.action]
            : 'No recommendation'}
        </strong>{' '}
        · {recommendation.reason}
      </p>
      {recommendation.action ? (
        <p className="catalog-price-note">
          Based on your supplied ranges: {source}
        </p>
      ) : null}
    </div>
  );
}
