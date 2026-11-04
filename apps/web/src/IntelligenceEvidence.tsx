import type { OpportunityView } from '@poe-worksmith/contracts';
import type { LiquidityAssessment } from '@poe-worksmith/domain';
import { Link } from 'react-router-dom';
import { formatRiskMoney } from './CraftRiskSummary.js';

export const intelligenceMoney = (value: string | null) =>
  formatRiskMoney(value, 'chaos');
export const intelligenceNumber = (value: number | string) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
    Number(value),
  );
export const intelligencePercent = (value: number) =>
  `${intelligenceNumber(value * 100)}%`;
export function intelligenceTime(seconds: number | null) {
  return seconds === null
    ? 'Unavailable'
    : seconds < 60
      ? `${intelligenceNumber(seconds)} sec`
      : seconds < 3600
        ? `${intelligenceNumber(seconds / 60)} min`
        : seconds < 86400
          ? `${intelligenceNumber(seconds / 3600)} h`
          : `${intelligenceNumber(seconds / 86400)} d`;
}
export function objectiveLabel(objective: {
  kind: 'attempts' | 'successes' | 'single-target';
  count: number;
}) {
  return objective.kind === 'single-target'
    ? 'One target item'
    : `${objective.count} ${objective.kind === 'attempts' ? 'complete method runs' : 'target items'}`;
}
export function SignalState({
  state,
}: {
  state: OpportunityView['signal']['state'];
}) {
  return (
    <span className={`intelligence-state intelligence-state--${state}`}>
      {state.replaceAll('_', ' ')}
    </span>
  );
}
export function OwnSaleEvidence({
  liquidity,
}: {
  liquidity: LiquidityAssessment;
}) {
  const own = liquidity.own;
  return (
    <>
      <span>{own.sampleSize} own confirmed-sale observations</span>
      <small>
        Holding P75: {intelligenceTime(own.p75HoldingSeconds)} · listing-to-sale
        timing sample: {own.saleTimeSampleSize}
      </small>
      <small>
        Median: {intelligenceTime(own.medianSellSeconds)} · P75:{' '}
        {intelligenceTime(own.p75SellSeconds)}
      </small>
      <small>
        {own.unsoldCount} currently held / listed · oldest:{' '}
        {intelligenceTime(own.oldestUnsoldSeconds)}
      </small>
      {!own.coverageComplete ? (
        <small className="recipe-warning">Own ledger coverage incomplete</small>
      ) : null}
    </>
  );
}
export function LiquidityEvidence({
  liquidity,
}: {
  liquidity: LiquidityAssessment;
}) {
  return (
    <div className="intelligence">
      <dl className="intelligence-metrics">
        <div>
          <dt>Independent sellers</dt>
          <dd>{liquidity.snapshotId ? liquidity.sellers : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Comparable listings observed</dt>
          <dd>
            {liquidity.snapshotId
              ? `${liquidity.listings} / ${liquidity.totalListings} reported`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Asking range</dt>
          <dd>
            {liquidity.asking
              ? `${intelligenceMoney(liquidity.asking.min)} – ${intelligenceMoney(liquidity.asking.max)}`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Median ask</dt>
          <dd>{intelligenceMoney(liquidity.asking?.median ?? null)}</dd>
        </div>
        <div>
          <dt>Largest seller share</dt>
          <dd>
            {liquidity.largestSellerShare === null
              ? 'Unavailable'
              : intelligencePercent(liquidity.largestSellerShare)}
          </dd>
        </div>
        <div>
          <dt>Competition trend</dt>
          <dd>{liquidity.competitionTrend}</dd>
        </div>
        <div>
          <dt>Data quality</dt>
          <dd>
            {liquidity.status} · {liquidity.coverage} coverage
          </dd>
        </div>
      </dl>
      <p className="intelligence-note">
        Observed listing supply is a liquidity proxy. Asking prices are not
        completed sales; missing listings are not inferred sales.{' '}
        {liquidity.observedAt
          ? `Observed ${new Date(liquidity.observedAt).toLocaleString('en-US')}.`
          : 'No comparable observation.'}{' '}
        {liquidity.expiresAt
          ? `Evidence expires ${new Date(liquidity.expiresAt).toLocaleString('en-US')}.`
          : ''}
      </p>
      {liquidity.reasons.length ? (
        <ul className="intelligence-evidence-list">
          {liquidity.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Listing depth and observed changes</summary>
        {liquidity.depth.length ? (
          <div className="intelligence-table-scroll">
            <table className="intelligence-table">
              <thead>
                <tr>
                  <th>Asking price threshold</th>
                  <th>Comparable offers at or below</th>
                </tr>
              </thead>
              <tbody>
                {liquidity.depth.map((level, index) => (
                  <tr key={`${level.ask}:${index}`}>
                    <td>{intelligenceMoney(level.ask)}</td>
                    <td>{level.listings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="intelligence-note">Listing depth unavailable.</p>
        )}
        {liquidity.changes ? (
          <p className="intelligence-note">
            New: {liquidity.changes.new} · reappeared:{' '}
            {liquidity.changes.reappeared} · missing:{' '}
            {liquidity.changes.missing}. Supply change:{' '}
            {liquidity.changes.supplyPercent === null
              ? 'unavailable'
              : `${intelligenceNumber(liquidity.changes.supplyPercent)}%`}
            ; sellers:{' '}
            {liquidity.changes.sellerPercent === null
              ? 'unavailable'
              : `${intelligenceNumber(liquidity.changes.sellerPercent)}%`}
            ; asks:{' '}
            {liquidity.changes.askPercent === null
              ? 'unavailable'
              : `${intelligenceNumber(liquidity.changes.askPercent)}%`}
            .
          </p>
        ) : (
          <p className="intelligence-note">
            Comparable prior observations unavailable.
          </p>
        )}
        <p className="intelligence-note">
          Independent observations: {liquidity.independentObservations}. Seller
          concentration (0–1):{' '}
          {liquidity.concentrationIndex === null
            ? 'unavailable'
            : intelligenceNumber(liquidity.concentrationIndex)}
          .
        </p>
      </details>
      <details>
        <summary>Own confirmed sales and inventory</summary>
        <p className="intelligence-note">
          <OwnSaleEvidence liquidity={liquidity} />
        </p>
        <p className="intelligence-note">
          Window: {new Date(liquidity.own.windowStart).toLocaleString('en-US')}{' '}
          – {new Date(liquidity.own.windowEnd).toLocaleString('en-US')}. Only
          this league and exact output signature are included.
        </p>
        <Link
          to={`/factory?league=${encodeURIComponent(liquidity.cohort.league)}`}
        >
          Open My Factory
        </Link>
        {liquidity.own.confirmedSales.length ? (
          <div className="intelligence-table-scroll">
            <table className="intelligence-table">
              <thead>
                <tr>
                  <th>Confirmed sale</th>
                  <th>Sold at</th>
                  <th>Observed time to sell</th>
                </tr>
              </thead>
              <tbody>
                {liquidity.own.confirmedSales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.id.slice(0, 12)}</td>
                    <td>{new Date(sale.soldAt).toLocaleString('en-US')}</td>
                    <td>{intelligenceTime(sale.timeToSellSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </details>
      <details>
        <summary>Evidence references</summary>
        <p className="intelligence-note intelligence-signature">
          Exact output: {liquidity.cohort.targetSignature} · League:{' '}
          {liquidity.cohort.league}
        </p>
        <ul className="intelligence-evidence-list">
          {liquidity.evidenceIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
export function OpportunityEvidence({
  opportunity,
}: {
  opportunity: OpportunityView;
}) {
  const signal = opportunity.signal;
  return (
    <div className="intelligence">
      <div className="intelligence-actions">
        <SignalState state={signal.state} />
        <span className="intelligence-note">
          Candidate: {signal.candidate.replaceAll('_', ' ')} · confirmations{' '}
          {signal.confirmations} · evaluated{' '}
          {new Date(signal.evaluatedAt).toLocaleString('en-US')}
        </span>
      </div>
      <ul className="intelligence-evidence-list">
        {[...new Set([...signal.reasons, ...opportunity.reasons])].map(
          (reason) => (
            <li key={reason}>{reason}</li>
          ),
        )}
      </ul>
      {signal.triggers.length ? (
        <p className="intelligence-note">
          Triggers:{' '}
          {signal.triggers
            .map((trigger) => trigger.replaceAll('-', ' '))
            .join(' · ')}
        </p>
      ) : null}
      <LiquidityEvidence liquidity={opportunity.liquidity} />
      <details>
        <summary>
          Saved whole-objective risk options (
          {opportunity.availableRiskOptions.length})
        </summary>
        <p className="intelligence-note">
          Each row is one complete saved objective. These budgets are not
          per-item estimates to multiply; the initial method-run EV and legacy
          target-only ROI have different horizons.
        </p>
        {opportunity.availableRiskOptions.length ? (
          <div className="intelligence-table-scroll">
            <table className="intelligence-table">
              <thead>
                <tr>
                  <th>Objective</th>
                  <th>Expected cash result</th>
                  <th>P90 budget</th>
                  <th>P95 budget</th>
                </tr>
              </thead>
              <tbody>
                {opportunity.availableRiskOptions.map((option) => (
                  <tr key={option.id}>
                    <td>
                      {objectiveLabel(option.objective)}
                      <small>{option.id.slice(0, 12)}</small>
                    </td>
                    <td>
                      {formatRiskMoney(option.expectedProfit, option.currency)}
                    </td>
                    <td>{formatRiskMoney(option.p90, option.currency)}</td>
                    <td>{formatRiskMoney(option.p95, option.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="intelligence-note">
            Run and save a supported risk simulation for the required objective
            first.
          </p>
        )}
      </details>
    </div>
  );
}
