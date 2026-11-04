import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  capitalPlanCreateInputSchema,
  type CapitalPlanCreateInput,
  type CapitalPlanResponse,
  type OpportunityView,
} from '@poe-worksmith/contracts';
import { createApiClient } from './apiClient.js';
import { CapitalFields } from './CapitalFields.js';
import { factoryErrorMessage, factoryText } from './factoryForm.js';
import {
  intelligenceMoney,
  intelligenceNumber,
  intelligencePercent,
  objectiveLabel,
} from './IntelligenceEvidence.js';

const api = createApiClient();
export function buildCapitalPlanInput(
  form: FormData,
  league: string,
  idempotencyKey: string,
): CapitalPlanCreateInput {
  if (
    ['maxLossPercent', 'maxExposurePercent', 'horizonDays'].some(
      (key) => !factoryText(form, key),
    )
  )
    throw new Error(
      'Enter the risk limit, exposure limit and investment horizon explicitly.',
    );
  const common = {
    quantity: '1',
    currency: factoryText(form, 'currency'),
    chaosPerUnit: factoryText(form, 'chaosPerUnit'),
    rateSource: factoryText(form, 'rateSource'),
  };
  const recipeIds = form.getAll('recipeIds').map((value) => String(value));
  const categories = form.getAll('categories').map((value) => String(value));
  return capitalPlanCreateInputSchema.parse({
    league,
    capital: { ...common, unitPrice: factoryText(form, 'capital') },
    reserve: { ...common, unitPrice: factoryText(form, 'reserve') },
    maxRiskProbability: Number(factoryText(form, 'maxLossPercent')) / 100,
    maxExposurePercent: Number(factoryText(form, 'maxExposurePercent')),
    horizonDays: Number(factoryText(form, 'horizonDays')),
    ...(recipeIds.length ? { recipeIds } : {}),
    ...(categories.length ? { categories } : {}),
    idempotencyKey,
  });
}

export function CapitalPlanView({
  saved,
}: {
  saved: CapitalPlanResponse['data'];
}) {
  const [selected, setSelected] = useState('balanced');
  const plan = saved.plan;
  const scenario =
    plan.scenarios.find((value) => value.name === selected) ??
    plan.scenarios[0]!;
  return (
    <div className="intelligence" aria-label="Saved production plan">
      <div className="intelligence-actions">
        <h3>Production plan</h3>
        <label>
          Allocation scenario
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {plan.scenarios.map((value) => (
              <option key={value.name} value={value.name}>
                {value.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="intelligence-note">
        Saved {new Date(saved.createdAt).toLocaleString('en-US')} · evaluated{' '}
        {new Date(plan.evaluatedAt).toLocaleString('en-US')} ·{' '}
        {plan.request.league}. This plan preserves its evidence and conversion;
        it is not a live quotation. Advisory only: no purchases or sales are
        executed.
      </p>
      {scenario.status === 'hold' ? (
        <p role="status">
          Hold capital. No whole production objective meets this scenario's
          requirements.
        </p>
      ) : null}
      <dl className="intelligence-metrics">
        <div>
          <dt>Allocated capital</dt>
          <dd>{intelligenceMoney(scenario.allocatedCapital)}</dd>
        </div>
        <div>
          <dt>Unallocated / reserved capital</dt>
          <dd>{intelligenceMoney(scenario.reservedCapital)}</dd>
        </div>
        <div>
          <dt>Expected cash result</dt>
          <dd>{intelligenceMoney(scenario.expectedProfit)}</dd>
        </div>
        <div>
          <dt>Any-loss or budget-overrun upper bound</dt>
          <dd>{intelligencePercent(scenario.unionRiskUpperBound)}</dd>
        </div>
        <div>
          <dt>Statistical confidence lower bound</dt>
          <dd>
            {intelligencePercent(scenario.statisticalConfidenceLowerBound)}
          </dd>
        </div>
      </dl>
      <p className="intelligence-note">
        Risk bounds include a cash loss or exceeding an individual objective's
        P95 budget. The combined bound is not a portfolio P95 estimate.
        Unallocated cash includes your requested reserve.
      </p>
      {scenario.lines.length ? (
        <div className="intelligence-table-scroll">
          <table className="intelligence-table">
            <thead>
              <tr>
                <th>Recipe / whole objective</th>
                <th>Planned capital / P90 / P95</th>
                <th>Expected cash result</th>
                <th>Risk bounds</th>
                <th>Liquidity / allocation reason</th>
                <th>Stop condition</th>
              </tr>
            </thead>
            <tbody>
              {scenario.lines.map((line) => (
                <tr key={`${line.recipeId}:${line.riskRunId}`}>
                  <td>
                    <Link to={`/recipes/${encodeURIComponent(line.recipeId)}`}>
                      {line.title}
                    </Link>
                    <small>{objectiveLabel(line.objective)}</small>
                    <small>
                      Saved simulation {line.riskRunId.slice(0, 12)}
                    </small>
                  </td>
                  <td>
                    {intelligenceMoney(line.plannedCapital)}
                    <small>
                      P90 {intelligenceMoney(line.p90Budget)} · P95{' '}
                      {intelligenceMoney(line.p95Budget)}
                    </small>
                  </td>
                  <td>{intelligenceMoney(line.expectedProfit)}</td>
                  <td>
                    Cash loss ≤
                    {intelligencePercent(line.lossProbabilityUpperBound)}
                    <small>
                      Budget overrun ≤
                      {intelligencePercent(line.budgetExceedanceUpperBound)}
                    </small>
                    <small>
                      Combined ≤
                      {intelligencePercent(line.combinedRiskUpperBound)}
                    </small>
                  </td>
                  <td>
                    {line.ownSaleSamples} own sale observations · holding{' '}
                    {intelligenceNumber(line.holdingDays)} d
                    <small>Liquidity capacity: {line.liquidityCapacity}</small>
                    <small>{line.reason}</small>
                    <Link
                      to={`/factory?recipe=${encodeURIComponent(line.recipeId)}&league=${encodeURIComponent(plan.request.league)}&forecast=${encodeURIComponent(line.riskRunId)}`}
                    >
                      Start this batch
                    </Link>
                  </td>
                  <td>{line.stopCondition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details>
        <summary>Input-price sensitivity</summary>
        <p className="intelligence-note">
          Inputs +{intelligenceNumber(scenario.sensitivity.inputShockPercent)}%:
          planned capital{' '}
          {intelligenceMoney(scenario.sensitivity.plannedCapital)}, expected
          cash result {intelligenceMoney(scenario.sensitivity.expectedProfit)}.{' '}
          {scenario.sensitivity.fitsCapital
            ? 'Within available capital.'
            : 'Exceeds available capital.'}{' '}
          {scenario.sensitivity.assumption}
        </p>
      </details>
      {scenario.watchlist.length ? (
        <details open={scenario.status === 'hold'}>
          <summary>Watchlist ({scenario.watchlist.length})</summary>
          <ul className="intelligence-evidence-list">
            {scenario.watchlist.map((entry) => (
              <li key={entry.recipeId}>
                <Link to={`/recipes/${encodeURIComponent(entry.recipeId)}`}>
                  {entry.recipeId}
                </Link>
                : {entry.reasons.join(' · ')}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {scenario.limitations.length ? (
        <ul className="intelligence-evidence-list">
          {scenario.limitations.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Saved plan inputs and evidence</summary>
        <p className="intelligence-note">
          Capital {plan.request.capital.unitPrice}{' '}
          {plan.request.capital.currency}; reserve{' '}
          {plan.request.reserve.unitPrice} {plan.request.reserve.currency};
          conversion {plan.request.capital.chaosPerUnit} c/unit (
          {plan.request.capital.rateSource}). Max combined risk{' '}
          {intelligencePercent(plan.request.maxRiskProbability)}, per-recipe
          exposure {intelligenceNumber(plan.request.maxExposurePercent)}%,
          horizon {plan.request.horizonDays} d.
        </p>
        <p className="intelligence-note">Plan ID: {saved.id}</p>
        <ul className="intelligence-evidence-list">
          {plan.evidenceIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function CapitalAllocator({
  league,
  opportunities,
}: {
  league: string;
  opportunities: OpportunityView[];
}) {
  const [saved, setSaved] = useState<CapitalPlanResponse['data'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const pending = useRef<{
    fingerprint: string;
    input: CapitalPlanCreateInput;
  } | null>(null);
  useEffect(() => {
    let active = true;
    try {
      const id = sessionStorage.getItem(`worksmith:capital-plan:${league}`);
      if (id)
        void api
          .getCapitalPlan(id)
          .then((response) => {
            if (active && response.data.plan.request.league === league)
              setSaved((current) => current ?? response.data);
          })
          .catch((failure) => {
            if (active) setError(factoryErrorMessage(failure));
          });
    } catch {
      /* The saved plan remains available by its API identifier. */
    }
    return () => {
      active = false;
    };
  }, [league]);
  const categories = [
    ...new Set(opportunities.map((value) => value.category)),
  ].sort();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const form = new FormData(event.currentTarget);
    const fingerprint = JSON.stringify([league, [...form.entries()]]);
    setError('');
    try {
      if (pending.current?.fingerprint !== fingerprint)
        pending.current = {
          fingerprint,
          input: buildCapitalPlanInput(form, league, crypto.randomUUID()),
        };
      active.current = true;
      setBusy(true);
      const response = await api.createCapitalPlan(pending.current.input);
      setSaved(response.data);
      try {
        sessionStorage.setItem(
          `worksmith:capital-plan:${league}`,
          response.data.id,
        );
      } catch {
        /* Optional browser resume. */
      }
      pending.current = null;
    } catch (failure) {
      setError(factoryErrorMessage(failure));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="intelligence-panel">
      <summary>Allocate available capital</summary>
      <form onSubmit={submit} aria-label="Capital allocation plan">
        <fieldset disabled={busy} className="intelligence-form-fields">
          <CapitalFields />
        </fieldset>
        <details>
          <summary>Optional recipe and category restrictions</summary>
          <p className="intelligence-note">
            Unchecked means unrestricted. Selecting recipes and categories
            applies both restrictions.
          </p>
          <div className="intelligence-restrictions">
            {categories.map((category) => (
              <label key={category}>
                <input
                  disabled={busy}
                  type="checkbox"
                  name="categories"
                  value={category}
                />
                {category.replaceAll('-', ' ')}
              </label>
            ))}
          </div>
          <div className="intelligence-restrictions">
            {opportunities.map((value) => (
              <label key={value.recipeId}>
                <input
                  disabled={busy}
                  type="checkbox"
                  name="recipeIds"
                  value={value.recipeId}
                />
                {value.title}
              </label>
            ))}
          </div>
        </details>
        <button type="submit" disabled={busy}>
          {busy ? 'Evaluating production plan…' : 'Build production plan'}
        </button>
        {error ? (
          <p role="alert" className="recipe-warning">
            {error} Inputs are preserved; retrying unchanged inputs reuses the
            pending request.
          </p>
        ) : null}
      </form>
      {saved ? (
        <CapitalPlanView key={saved.id} saved={saved} />
      ) : (
        <p className="intelligence-note">
          A defensible plan requires current prices, supported probabilities,
          saved risk objectives and enough exact-match own sales to assess the
          chosen horizon. Missing evidence produces a watchlist, not a forced
          allocation.
        </p>
      )}
    </details>
  );
}
