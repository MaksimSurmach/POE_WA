import type {
  OutcomeAnalysis,
  OutcomeModel,
  OutcomeRange,
} from '@poe-worksmith/domain';

const amountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});
export function formatRiskMoney(
  amount: string | null | undefined,
  currency: string,
) {
  if (amount === null || amount === undefined) return 'Unavailable';
  const value = Number(amount);
  return Number.isFinite(value)
    ? `${amountFormatter.format(value)} ${currency === 'chaos' ? 'c' : currency === 'divine' ? 'div' : currency}`
    : 'Unavailable';
}
export function formatRiskRange(
  range: OutcomeRange | null | undefined,
  currency: string,
) {
  if (!range) return 'Unavailable';
  return range.min === range.max
    ? formatRiskMoney(range.min, currency)
    : `${formatRiskMoney(range.min, currency)} – ${formatRiskMoney(range.max, currency)}`;
}
export function formatRiskPercent(
  value: string | number | null | undefined,
  fraction = true,
) {
  if (value === null || value === undefined) return 'Unavailable';
  const number = Number(value) * (fraction ? 100 : 1);
  return Number.isFinite(number)
    ? `${amountFormatter.format(number)}%`
    : 'Unavailable';
}

export function CraftEconomicsSummary({
  analysis,
}: {
  analysis: OutcomeAnalysis;
}) {
  const currency = analysis.currency;
  return (
    <>
      <p className="catalog-price-note">
        Per completed method run, including its declared setup and internal
        retries.{' '}
        {analysis.basis === 'assumptions'
          ? 'Modelled assumptions; not observed sales.'
          : analysis.basis === 'mixed'
            ? 'Combines observations with labelled assumptions.'
            : 'Based on recorded evidence; resale asks are not completed sales.'}
      </p>
      {analysis.status !== 'complete' ? (
        <div className="craft-risk__notice" role="status">
          <strong>EV unavailable</strong>
          <ul>
            {analysis.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="craft-risk__metrics">
        <div>
          <dt>Expected cost</dt>
          <dd>{formatRiskMoney(analysis.expectedTotalCost, currency)}</dd>
        </div>
        <div>
          <dt>Net EV per run</dt>
          <dd>{formatRiskRange(analysis.expectedNetProfit, currency)}</dd>
        </div>
        <div>
          <dt>Expected ROI</dt>
          <dd>
            {analysis.expectedRoiPercent
              ? analysis.expectedRoiPercent.min ===
                analysis.expectedRoiPercent.max
                ? formatRiskPercent(analysis.expectedRoiPercent.min, false)
                : `${formatRiskPercent(analysis.expectedRoiPercent.min, false)} – ${formatRiskPercent(analysis.expectedRoiPercent.max, false)}`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Salvage resale recovery</dt>
          <dd>{formatRiskRange(analysis.expectedSalvageRecovery, currency)}</dd>
        </div>
      </dl>
      <details>
        <summary>Cost breakdown and sensitivity</summary>
        <dl className="craft-risk__metrics">
          <div>
            <dt>Expected base inputs acquired</dt>
            <dd>{analysis.expectedBaseAcquisition ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Base spending</dt>
            <dd>{formatRiskMoney(analysis.expectedCosts?.base, currency)}</dd>
          </div>
          <div>
            <dt>Materials</dt>
            <dd>
              {formatRiskMoney(analysis.expectedCosts?.material, currency)}
            </dd>
          </div>
          <div>
            <dt>Finishing</dt>
            <dd>
              {formatRiskMoney(analysis.expectedCosts?.finishing, currency)}
            </dd>
          </div>
          <div>
            <dt>Recovery expense</dt>
            <dd>
              {formatRiskMoney(analysis.expectedCosts?.recovery, currency)}
            </dd>
          </div>
          <div>
            <dt>Resource recovery credit</dt>
            <dd>
              {formatRiskMoney(analysis.expectedRecoveryCredit, currency)}
            </dd>
          </div>
          <div>
            <dt>Gross resale</dt>
            <dd>{formatRiskRange(analysis.expectedGrossResale, currency)}</dd>
          </div>
          <div>
            <dt>Saleable items per run</dt>
            <dd>{analysis.expectedSaleableItems ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Target probability per run</dt>
            <dd>{formatRiskPercent(analysis.targetProbability)}</dd>
          </div>
          <div>
            <dt>Break-even target resale</dt>
            <dd>{formatRiskRange(analysis.breakEvenOutputPrice, currency)}</dd>
          </div>
          <div>
            <dt>Break-even material spend</dt>
            <dd>{formatRiskRange(analysis.breakEvenMaterialCost, currency)}</dd>
          </div>
        </dl>
        {analysis.sensitivity.length ? (
          <div className="craft-risk__table-wrap">
            <table>
              <caption>Price sensitivity per method run</caption>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Material multiplier</th>
                  <th>Resale multiplier</th>
                  <th>Net EV</th>
                </tr>
              </thead>
              <tbody>
                {analysis.sensitivity.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.materialPriceMultiplier}×</td>
                    <td>{row.sellingPriceMultiplier}×</td>
                    <td>{formatRiskRange(row.netProfit, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </details>
    </>
  );
}

export function OutcomeModelSummary({ model }: { model: OutcomeModel }) {
  return (
    <div className="craft-risk__table-wrap">
      <table>
        <caption>
          Outcomes of this crafting method. Probabilities are conditional on
          entering their stage.
        </caption>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Outcome</th>
            <th>Probability</th>
            <th>Disposition</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {model.stages.flatMap((stage) =>
            stage.outcomes.map((outcome) => (
              <tr key={outcome.id}>
                <td>{stage.name}</td>
                <td>
                  {outcome.name}
                  <small>
                    {outcome.classification}
                    {outcome.targetSuccess ? ' · Exact target' : ''}
                  </small>
                </td>
                <td>{formatRiskPercent(outcome.probability.value)}</td>
                <td>
                  {outcome.nextStageId
                    ? `Continue → ${outcome.nextStageId}`
                    : outcome.sellable
                      ? 'Terminal · Sellable'
                      : 'Terminal · No resale'}
                </td>
                <td>
                  {outcome.probability.provenance?.reference ??
                    'Missing probability evidence'}
                  <small>
                    {outcome.probability.provenance?.kind.replaceAll('-', ' ')}
                  </small>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function CraftRiskResult({
  result,
}: {
  result: import('@poe-worksmith/domain').RiskSimulationResult;
}) {
  const currency = result.currency;
  return (
    <div className="craft-risk__simulation">
      <p className="catalog-price-note">
        Modelled results, not historical crafts. Seed: {result.seed} ·{' '}
        {result.method === 'analytical-geometric'
          ? 'Exact geometric analysis'
          : `${result.trialsCompleted.toLocaleString()} simulated trials`}{' '}
        · {result.calculationVersion}
      </p>
      {result.status !== 'complete' ? (
        <div className="craft-risk__notice" role="status">
          <strong>Risk estimate unavailable</strong>
          <ul>
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {result.censoredTrials ? (
            <p>
              {result.censoredTrials} trials reached the resource limit.
              Incomplete trials are not silently excluded.
            </p>
          ) : null}
        </div>
      ) : null}
      <dl className="craft-risk__metrics">
        <div>
          <dt>Mean cost</dt>
          <dd>{formatRiskMoney(result.meanCost, currency)}</dd>
        </div>
        <div>
          <dt>P90 budget</dt>
          <dd>{formatRiskMoney(result.costQuantiles?.p90, currency)}</dd>
        </div>
        <div>
          <dt>Chance of loss</dt>
          <dd>{formatRiskPercent(result.probabilityOfLoss)}</dd>
        </div>
        <div>
          <dt>Chance of exceeding budget</dt>
          <dd>{formatRiskPercent(result.probabilityOverBudget)}</dd>
        </div>
        <div>
          <dt>Mean profit</dt>
          <dd>{formatRiskMoney(result.meanProfit, currency)}</dd>
        </div>
        <div>
          <dt>Risk-adjusted return</dt>
          <dd>{formatRiskPercent(result.riskAdjustedRoiPercent, false)}</dd>
        </div>
      </dl>
      <p className="catalog-price-note">
        Risk-adjusted return = mean profit ÷ P95 cost. The mean is not a safe
        bankroll: the P90 budget covers 90% of modelled outcomes for your
        selected objective.
      </p>
      {result.status === 'complete' &&
      (result.histogram.length || result.costQuantiles) ? (
        <RiskDistribution result={result} />
      ) : null}
      <details>
        <summary>Quantiles, tail risk and confidence</summary>
        <div className="craft-risk__table-wrap">
          <table>
            <caption>Selected-objective distribution</caption>
            <thead>
              <tr>
                <th>Percentile</th>
                <th>Cost</th>
                <th>Profit</th>
              </tr>
            </thead>
            <tbody>
              {(['p50', 'p75', 'p90', 'p95', 'p99'] as const).map((key) => (
                <tr key={key}>
                  <th>{key.toUpperCase()}</th>
                  <td>
                    {formatRiskMoney(result.costQuantiles?.[key], currency)}
                  </td>
                  <td>
                    {formatRiskMoney(result.profitQuantiles?.[key], currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="craft-risk__metrics">
          <div>
            <dt>Mean cost in worst 5%</dt>
            <dd>{formatRiskMoney(result.expectedShortfall95Cost, currency)}</dd>
          </div>
          <div>
            <dt>Mean loss in worst 5%</dt>
            <dd>{formatRiskMoney(result.expectedShortfall95Loss, currency)}</dd>
          </div>
          <div>
            <dt>
              At least one target within {result.reachWithinAttempts} method
              runs
            </dt>
            <dd>
              {formatRiskPercent(result.atLeastOneTargetWithinRunsProbability)}
            </dd>
          </div>
          <div>
            <dt>Mean method runs</dt>
            <dd>
              {result.meanMethodRuns === null
                ? 'Unavailable'
                : amountFormatter.format(result.meanMethodRuns)}
            </dd>
          </div>
          <div>
            <dt>Mean stage executions</dt>
            <dd>
              {result.meanStageExecutions === null
                ? 'Unavailable'
                : amountFormatter.format(result.meanStageExecutions)}
            </dd>
          </div>
        </dl>
        <p className="catalog-price-note">{result.attemptDefinition}</p>
        {result.percentileRankError95 !== null ? (
          <p className="catalog-price-note">
            95% bound on percentile-rank sampling error: ±
            {formatRiskPercent(result.percentileRankError95)}. This does not
            measure uncertainty in the supplied model or prices.
          </p>
        ) : null}
      </details>
    </div>
  );
}

export function RiskDistribution({
  result,
}: {
  result: import('@poe-worksmith/domain').RiskSimulationResult;
}) {
  if (!result.histogram.length && result.costQuantiles) {
    const quantiles = Object.entries(result.costQuantiles);
    const maximum = Math.max(
      ...quantiles.map(([, amount]) => Number(amount)),
      1,
    );
    return (
      <figure className="craft-risk__distribution">
        <svg
          viewBox="0 0 640 190"
          role="img"
          aria-label="Analytical crafting budget by confidence level"
        >
          <title>Analytical crafting budget by confidence level</title>
          <desc>
            Exact cost quantiles; these bars are budgets, not simulated trial
            counts.
          </desc>
          {quantiles.map(([key, amount], index) => (
            <g key={key}>
              <text x="10" y={28 + index * 32}>
                {key.toUpperCase()}
              </text>
              <rect
                x="55"
                y={14 + index * 32}
                width={(Number(amount) / maximum) * 390}
                height="20"
              />
              <text x="455" y={28 + index * 32}>
                {formatRiskMoney(amount, result.currency)}
              </text>
            </g>
          ))}
        </svg>
        <figcaption>
          Exact analytical cost quantiles for the selected objective. A P90
          budget covers 90% of outcomes under the declared geometric
          assumptions.
        </figcaption>
      </figure>
    );
  }
  const bins = result.histogram;
  if (bins.length === 1 && bins[0]!.lower === bins[0]!.upper) {
    return (
      <p className="catalog-price-note">
        Every modelled trial costs{' '}
        {formatRiskMoney(bins[0]!.lower, result.currency)} for this objective.
        Cost is constant in these trials; resale and profit can still vary.
      </p>
    );
  }
  const maximum = Math.max(...bins.map((bin) => bin.count), 1);
  const plotWidth = 560;
  const width = plotWidth / Math.max(bins.length, 1);
  return (
    <figure className="craft-risk__distribution">
      <svg
        viewBox="0 0 640 180"
        role="img"
        aria-label="Modelled crafting cost distribution"
      >
        <title>Modelled crafting cost distribution</title>
        <desc>
          Each bar counts simulated trials in a cost band. Exact quantiles are
          listed below.
        </desc>
        <text x="14" y="17">
          Trials
        </text>
        {bins.map((bin, index) => {
          const height = (bin.count / maximum) * 105;
          return (
            <g key={`${bin.lower}-${index}`}>
              <rect
                x={55 + index * width}
                y={130 - height}
                width={Math.max(width - 2, 1)}
                height={height}
              >
                <title>
                  {formatRiskMoney(bin.lower, result.currency)} to{' '}
                  {formatRiskMoney(bin.upper, result.currency)}: {bin.count}{' '}
                  trials
                </title>
              </rect>
            </g>
          );
        })}
        <text x="48" y="36" textAnchor="end">
          {maximum}
        </text>
        <text x="48" y="132" textAnchor="end">
          0
        </text>
        <text x="55" y="153">
          {formatRiskMoney(bins[0]?.lower, result.currency)}
        </text>
        <text x="615" y="153" textAnchor="end">
          {formatRiskMoney(bins.at(-1)?.upper, result.currency)}
        </text>
        <text x="335" y="174" textAnchor="middle">
          Cost for the selected objective
        </text>
      </svg>
      <figcaption>
        Cost distribution from the saved model and price evidence. Higher
        budgets reduce the chance of running out of currency; they do not
        guarantee a profitable sale.
      </figcaption>
    </figure>
  );
}

export function OutcomePriceEvidence({
  prices,
  valuations,
}: Pick<
  import('@poe-worksmith/domain').OutcomeAnalysisInput,
  'prices' | 'valuations'
>) {
  const rows = [
    ...Object.entries(prices).map(([id, quote]) => ({
      id: `Input: ${id}`,
      value: formatRiskMoney(quote.amount, quote.currency),
      quote,
    })),
    ...Object.entries(valuations).map(([id, quote]) => ({
      id: `Outcome: ${id}`,
      value: formatRiskRange(quote, quote.currency),
      quote,
    })),
  ];
  return (
    <div className="craft-risk__table-wrap">
      <table>
        <caption>Model purchase and resale evidence</caption>
        <thead>
          <tr>
            <th>Input or outcome</th>
            <th>Value</th>
            <th>Basis</th>
            <th>Source and time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, value, quote }) => (
            <tr key={id}>
              <th>{id}</th>
              <td>{value}</td>
              <td>
                {quote.provenance.kind === 'market-observation'
                  ? 'Market observation — not a sale'
                  : quote.provenance.kind.replaceAll('-', ' ')}
              </td>
              <td>
                {quote.provenance.reference}
                <small>
                  {new Date(
                    quote.market?.observedAt ?? quote.provenance.recordedAt,
                  ).toLocaleString('en-US')}
                </small>
                {quote.market ? (
                  <small>
                    {quote.market.league} · {quote.market.coverage} coverage ·{' '}
                    {quote.market.independentSellers} sellers · expires{' '}
                    {new Date(quote.market.expiresAt).toLocaleString('en-US')}
                  </small>
                ) : null}
                <small>{quote.provenance.notes}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
