import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  OpportunitiesResponse,
  OpportunityView,
  SignalHistoryResponse,
} from '@poe-worksmith/contracts';
import { ApiClientError, createApiClient } from './apiClient.js';
import { CapitalAllocator } from './CapitalAllocator.js';
import { factoryErrorMessage } from './factoryForm.js';
import {
  intelligenceMoney,
  OpportunityEvidence,
  OwnSaleEvidence,
  SignalState,
} from './IntelligenceEvidence.js';
import './intelligence.css';

const api = createApiClient();
function intelligenceError(error: unknown) {
  return error instanceof ApiClientError &&
    error.envelope.error.code === 'OPERATOR_AUTH_REQUIRED'
    ? 'Market intelligence and allocation require local owner access. Public recipe estimates remain available.'
    : `Intelligence unavailable: ${factoryErrorMessage(error)}`;
}

export function OpportunitiesIntelligence({
  league,
}: {
  league: string | undefined;
}) {
  const [data, setData] = useState<OpportunitiesResponse['data'] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState('actionable');
  useEffect(() => {
    if (!league) {
      setData(null);
      return;
    }
    let active = true;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const response = await api.getOpportunities(league!);
        if (active) {
          setData(response.data);
          setError('');
        }
      } catch (failure) {
        if (active) {
          setData(null);
          setError(intelligenceError(failure));
        }
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    }
    setData(null);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [league, refresh]);
  const visible =
    data?.opportunities.filter(
      (opportunity) =>
        filter === 'all' ||
        (filter === 'actionable'
          ? opportunity.signal.state !== 'INSUFFICIENT_DATA'
          : opportunity.signal.state === filter),
    ) ?? [];
  const insufficient =
    data?.opportunities.filter(
      (value) => value.signal.state === 'INSUFFICIENT_DATA',
    ) ?? [];
  const missingReasons = [
    ...new Set(insufficient.flatMap((value) => value.signal.reasons)),
  ].slice(0, 2);
  return (
    <section className="intelligence" aria-labelledby="intelligence-heading">
      <div className="intelligence-panel">
        <div className="intelligence-actions">
          <h2 id="intelligence-heading">Production signals and liquidity</h2>
          <button
            type="button"
            disabled={!league || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? 'Checking intelligence…' : 'Update intelligence'}
          </button>
        </div>
        <p className="intelligence-note">
          Private owner analysis uses saved market evidence and confirmed
          factory sales. Listing supply is a proxy, not observed market demand.
          Signals and saved objectives have separate horizons from the
          indicative target estimates below.
        </p>
        {error ? (
          <p role="status" className="recipe-warning">
            {error}
          </p>
        ) : null}
        {!league ? (
          <p className="intelligence-note">
            Select a current league before evaluating opportunities.
          </p>
        ) : null}
        {data ? (
          <>
            <div className="intelligence-actions">
              <p className="intelligence-note">
                {data.league} · evaluated{' '}
                {new Date(data.asOf).toLocaleString('en-US')} ·{' '}
                {data.coverage.includedRecipes} / {data.coverage.totalRecipes}{' '}
                recipes
              </p>
              <label>
                Opportunity signal
                <select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="actionable">Craft / Watch / Stop</option>
                  <option value="all">All states</option>
                  {['CRAFT', 'WATCH', 'STOP', 'INSUFFICIENT_DATA'].map(
                    (state) => (
                      <option key={state} value={state}>
                        {state.replaceAll('_', ' ')}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            {!data.coverage.complete ? (
              <p className="recipe-warning">
                Partial recipe coverage. Missing recipes are not implied
                opportunities.
              </p>
            ) : null}
            {insufficient.length ? (
              <p className="intelligence-note">
                {insufficient.length} recipes have insufficient data. Choose All
                states to inspect them.
                {!visible.length && filter === 'actionable'
                  ? ` ${missingReasons.join(' · ')}`
                  : ''}
              </p>
            ) : null}
            {visible.length ? (
              <div className="intelligence-table-scroll">
                <table className="intelligence-table">
                  <thead>
                    <tr>
                      <th>Recipe / signal</th>
                      <th>Comparable asking supply</th>
                      <th>Own confirmed-sale evidence</th>
                      <th>Decision evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((opportunity) => (
                      <tr key={opportunity.recipeId}>
                        <td>
                          <Link
                            to={`/recipes/${encodeURIComponent(opportunity.recipeId)}`}
                          >
                            {opportunity.title}
                          </Link>
                          <small>
                            <SignalState state={opportunity.signal.state} />
                          </small>
                        </td>
                        <td>
                          {opportunity.liquidity.snapshotId
                            ? `${opportunity.liquidity.sellers} sellers · ${opportunity.liquidity.listings} listings`
                            : 'No comparable listing evidence'}
                          <small>
                            {opportunity.liquidity.asking
                              ? `${intelligenceMoney(opportunity.liquidity.asking.min)} – ${intelligenceMoney(opportunity.liquidity.asking.max)}`
                              : 'Asking range unavailable'}
                          </small>
                          <small>
                            {opportunity.liquidity.competitionTrend} competition
                            · {opportunity.liquidity.coverage} coverage
                          </small>
                        </td>
                        <td>
                          <OwnSaleEvidence liquidity={opportunity.liquidity} />
                        </td>
                        <td>
                          {opportunity.signal.reasons[0] ??
                            opportunity.reasons[0] ??
                            'See decision evidence.'}
                          <details>
                            <summary>Why this signal?</summary>
                            <OpportunityEvidence opportunity={opportunity} />
                          </details>
                        </td>
                      </tr>
                    ))}
                    {!visible.length ? (
                      <tr>
                        <td colSpan={4}>No recipes match this signal state.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="intelligence-note">
                No recipes match this signal filter.
              </p>
            )}
          </>
        ) : !error && league ? (
          <p role="status">Loading saved opportunity evidence…</p>
        ) : null}
      </div>
      {data ? (
        <CapitalAllocator
          key={data.league}
          league={data.league}
          opportunities={data.opportunities}
        />
      ) : null}
    </section>
  );
}

export function RecipeIntelligencePanel({ recipeId }: { recipeId: string }) {
  const [data, setData] = useState<OpportunityView | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const league = await api.getCurrentLeague();
        const response = await api.getOpportunity(recipeId, league.data.name);
        if (active) {
          setData(response.data);
          setError('');
        }
      } catch (failure) {
        if (active) {
          setData(null);
          setError(intelligenceError(failure));
        }
      } finally {
        inFlight = false;
      }
    }
    setData(null);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [recipeId, refresh]);
  return (
    <section
      className="intelligence intelligence-panel"
      aria-labelledby="recipe-intelligence-heading"
    >
      <div className="intelligence-actions">
        <h2 id="recipe-intelligence-heading">Market decision and liquidity</h2>
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>
          Update decision evidence
        </button>
      </div>
      {error ? (
        <p role="status" className="recipe-warning">
          {error}
        </p>
      ) : data ? (
        <>
          <OpportunityEvidence opportunity={data} />
          <SignalHistory
            recipeId={data.recipeId}
            league={data.signal.cohort.league}
          />
        </>
      ) : (
        <p role="status">Loading saved market evidence…</p>
      )}
    </section>
  );
}

function SignalHistory({
  recipeId,
  league,
}: {
  recipeId: string;
  league: string;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<SignalHistoryResponse['data'] | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api
      .getOpportunityHistory(recipeId, league)
      .then((response) => {
        if (active) {
          setHistory(response.data);
          setError('');
        }
      })
      .catch((failure) => {
        if (active) setError(intelligenceError(failure));
      });
    return () => {
      active = false;
    };
  }, [recipeId, league, open]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Decision history</summary>
      <p className="intelligence-note">
        Historical decisions preserve their original recipe revision and
        evidence. They are not current opportunities.
      </p>
      {error ? (
        <p role="status">{error}</p>
      ) : history ? (
        <div className="intelligence-table-scroll">
          <table className="intelligence-table">
            <thead>
              <tr>
                <th>Evaluated / state</th>
                <th>Recipe revision</th>
                <th>Triggers and evidence</th>
              </tr>
            </thead>
            <tbody>
              {history.decisions.map((decision) => (
                <tr key={decision.id}>
                  <td>
                    {new Date(decision.signal.evaluatedAt).toLocaleString(
                      'en-US',
                    )}
                    <small>
                      <SignalState state={decision.signal.state} />
                    </small>
                  </td>
                  <td>
                    {decision.signal.recipeHash.slice(0, 12)}
                    <small className="intelligence-signature">
                      Output{' '}
                      {decision.signal.cohort.targetSignature.slice(0, 12)}
                    </small>
                  </td>
                  <td>
                    {decision.signal.triggers.join(' · ')}
                    <small>{decision.signal.reasons.join(' · ')}</small>
                    <details>
                      <summary>Evidence references</summary>
                      <ul className="intelligence-evidence-list">
                        {decision.signal.evidenceIds.map((id) => (
                          <li key={id}>{id}</li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!history.decisions.length ? (
            <p className="intelligence-note">No recorded decisions yet.</p>
          ) : null}
        </div>
      ) : (
        <p role="status">Loading decision history…</p>
      )}
    </details>
  );
}
