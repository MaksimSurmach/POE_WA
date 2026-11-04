import type { CraftingPrices } from '@poe-worksmith/contracts';
import { calculateCostScenario } from '@poe-worksmith/domain/economics';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { createApiClient } from './apiClient.js';
import { Money, StatusPanel, economicClass } from './components.js';
import { materialName, pohxGuides, type PohxGuide } from './pohxGuides.js';
import './craftGuides.css';

const api = createApiClient();

export function PohxRecipePage() {
  const { guideId } = useParams();
  const guide = pohxGuides.find((g) => g.id === guideId);
  if (!guide)
    return (
      <>
        <Link to="/recipes">‹ Recipes</Link>
        <StatusPanel tone="danger" title="Recipe not found" />
      </>
    );
  return <PohxCraft key={guide.id} guide={guide} />;
}

function PohxCraft({ guide }: { guide: PohxGuide }) {
  return (
    <article className="guide-page">
      <Link className="back-link" to="/recipes?source=pohx">
        ‹ Recipes
      </Link>
      <header className="catalog-heading">
        <div>
          <h1>{guide.title}</h1>
          <p>{guide.summary}</p>
          <a href={guide.sourceUrl} target="_blank" rel="noreferrer">
            Full guide by Pohx / Convay ↗
          </a>
        </div>
      </header>
      <p className="catalog-price-note">
        Source reviewed {guide.reviewedAt} in {guide.sourceLeague}.
        League-specific crafting steps need rechecking for a new league. These
        are independent summaries; the source does not guarantee profitability.
      </p>
      {guide.workInProgress ? (
        <StatusPanel tone="info" title="Source guide is unfinished">
          Pohx has not published this procedure yet. Costs and ROI are
          unavailable; no steps or probabilities have been invented.
        </StatusPanel>
      ) : (
        <>
          <div className="guide-layout">
            <section aria-labelledby="guide-procedure">
              <h2 id="guide-procedure">Crafting procedure</h2>
              <p>
                <strong>Starting items:</strong> {guide.base}
              </p>
              <ol className="guide-steps">
                {guide.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <p className="catalog-price-note">
                This summary is not a complete recovery tree. Use the full guide
                for slot restrictions, preview instructions and alternative
                finishes.
              </p>
              {guide.relatedRecipeIds.length ? (
                <section aria-label="Calculated variants">
                  <h3>Calculated variants</h3>
                  <p>
                    These exact variants have a checked attempt model and
                    comparable market queries. They do not price every branch of
                    the source guide.
                  </p>
                  {guide.relatedRecipeIds.map((id) => (
                    <p key={id}>
                      <Link to={`/recipes/${id}`}>
                        {id === 'rf-fire-trap-level-20'
                          ? 'Level 20 supports + AoE finish'
                          : 'Any support tier + AoE finish'}{' '}
                        ›
                      </Link>
                    </p>
                  ))}
                </section>
              ) : (
                <p className="recipe-warning">
                  Automatic expected cost and market ROI are not verified for
                  this multi-stage guide.
                </p>
              )}
            </section>
            <CraftScenarioCalculator guide={guide} />
          </div>
        </>
      )}
    </article>
  );
}

export function CraftScenarioCalculator({ guide }: { guide: PohxGuide }) {
  const [params, setParams] = useSearchParams();
  const [prices, setPrices] = useState<CraftingPrices | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getCraftingPrices()
      .then(
        (r) => {
          if (active) {
            setPrices(r.data);
            setFailed(false);
            setNow(Date.now());
          }
        },
        () => {
          if (active) {
            setPrices(null);
            setFailed(true);
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  }
  const materials = guide.materials.map((id) => {
    const quote = prices?.quotes.find(
      (q) => q.itemId === id && Date.parse(q.expiresAt) > now,
    );
    const manual = params.has(`price-${id}`);
    return {
      id,
      name: quote?.name ?? materialName(id),
      quantity: params.get(`qty-${id}`) ?? '',
      unitPrice: manual
        ? params.get(`price-${id}`)!
        : quote
          ? String(quote.chaos)
          : '',
      manual,
      quote,
    };
  });
  const result = calculateCostScenario({
    bases: params.get('bases') ?? '',
    other: params.get('other') ?? '',
    sale: params.get('sale') ?? '',
    materials,
  });
  const money = (value: string | null | undefined) => (
    <Money
      price={
        value === null || value === undefined
          ? null
          : { amount: Number(value), currency: 'chaos' }
      }
    />
  );
  return (
    <section aria-labelledby="scenario-heading" className="craft-scenario">
      <h2 id="scenario-heading">Your spending scenario</h2>
      <p>
        Enter total consumption, including failed attempts. Use 0 for unused
        alternatives. Quantities are your assumptions, not expected attempts.
      </p>
      <div className="guide-budget-inputs">
        <label>
          All bases, donors and replacements (c)
          <input
            type="number"
            min="0"
            step="any"
            value={params.get('bases') ?? ''}
            onChange={(e) => update('bases', e.target.value)}
            placeholder="Required"
          />
        </label>
        <label>
          Other costs not listed below (c)
          <input
            type="number"
            min="0"
            step="any"
            value={params.get('other') ?? ''}
            onChange={(e) => update('other', e.target.value)}
            placeholder="Required; enter 0 if none"
          />
        </label>
      </div>
      <p className="catalog-price-note">
        Include bench fees, recombination, recovery, oils and catalysts here
        only when they are not already counted in bases or materials below.
      </p>
      <div className="guide-price-status">
        <button
          type="button"
          disabled={loading}
          onClick={() => setRevision((x) => x + 1)}
        >
          {loading ? 'Loading quotes…' : 'Reload saved quotes'}
        </button>
        <span>
          {prices?.league
            ? `${prices.league} · poe.ninja material estimates`
            : 'Market quotes unavailable'}
        </span>
      </div>
      {failed ? (
        <p role="alert">
          Saved prices could not be loaded. You can still enter prices manually.
        </p>
      ) : null}
      {prices?.league && prices.league !== guide.sourceLeague ? (
        <p className="recipe-warning">
          Current prices are for {prices.league}; this guide was reviewed in{' '}
          {guide.sourceLeague}. Recheck the crafting mechanics.
        </p>
      ) : null}
      <div
        className="guide-material-scroll"
        role="region"
        aria-label="Material budget, scroll for columns"
        tabIndex={0}
      >
        <table className="guide-materials">
          <caption>Total material consumption for this scenario</caption>
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Used</th>
              <th scope="col">Each (c)</th>
              <th scope="col">Total (c)</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const line = calculateCostScenario({
                bases: '0',
                other: '0',
                sale: '',
                materials: [m],
              });
              return (
                <tr key={m.id}>
                  <th scope="row">
                    {m.name}
                    <small>
                      {m.manual ? (
                        'Your quote'
                      ) : m.quote ? (
                        <>
                          Verified{' '}
                          <time dateTime={m.quote.verifiedAt}>
                            {new Date(m.quote.verifiedAt).toLocaleString()}
                          </time>
                        </>
                      ) : (
                        'No fresh quote — enter a price'
                      )}
                    </small>
                  </th>
                  <td>
                    <input
                      aria-label={`${m.name} total used`}
                      type="number"
                      min="0"
                      step="any"
                      value={m.quantity}
                      onChange={(e) => update(`qty-${m.id}`, e.target.value)}
                      placeholder="?"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${m.name} price in chaos`}
                      type="number"
                      min="0"
                      step="any"
                      value={m.unitPrice}
                      onChange={(e) => update(`price-${m.id}`, e.target.value)}
                      placeholder="?"
                    />
                    {m.manual ? (
                      <button
                        className="guide-use-quote"
                        type="button"
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.delete(`price-${m.id}`);
                          setParams(next, { replace: true });
                        }}
                      >
                        Use market
                      </button>
                    ) : null}
                  </td>
                  <td>{money(line?.cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="guide-sale">
        Your assumed sale price (c, optional)
        <input
          type="number"
          min="0"
          step="any"
          value={params.get('sale') ?? ''}
          onChange={(e) => update('sale', e.target.value)}
          placeholder="Not a verified market valuation"
        />
      </label>
      <div className="recipe-economics" aria-live="polite">
        <span>
          Scenario cost <strong>{money(result?.cost)}</strong>
        </span>
        <span>
          Scenario profit{' '}
          <strong
            className={economicClass(
              result?.profit ? Number(result.profit) : null,
            )}
          >
            {money(result?.profit)}
          </strong>
        </span>
        <span>
          Scenario ROI{' '}
          <strong>
            {result?.roi === null || result?.roi === undefined
              ? '—'
              : `${Number(result.roi).toFixed(1)}%`}
          </strong>
        </span>
      </div>
      {!result ? (
        <p role="status">
          Complete the base/additional costs, every quantity and the prices of
          consumed materials. Blank or invalid inputs are not zero.
        </p>
      ) : null}
      <p className="catalog-price-note">
        Cost = bases + Σ(total used × unit price) + other costs. ROI = (your
        sale price − cost) ÷ cost × 100%. This scenario is not published in the
        profitability ranking. Include trade gold/time in your own
        additional-cost assumption if relevant.
      </p>
      <button type="button" onClick={() => setParams({}, { replace: true })}>
        Reset scenario
      </button>
    </section>
  );
}
