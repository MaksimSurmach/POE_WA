import type {
  PresentedItem,
  Price,
  RecipeDetailView,
  RecipeTrend,
  TrendRange,
} from '@poe-worksmith/contracts';
import { compareExpectedCostWithAsk } from '@poe-worksmith/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createApiClient } from './apiClient.js';
import { Button, NativeSelect } from './ui.js';
import { FavoriteButton } from './Watchlist.js';
import { PriceTrendChart } from './PriceTrendChart.js';
import { formatTimestamp } from './dateTime.js';
import type { RecipeLibraryOutput } from './recipeLibraryModel.js';

const api = createApiClient();
export function LibraryMoney({ price }: { price: Price | null }) {
  return price ? (
    <>
      {new Intl.NumberFormat('en-US', {
        maximumFractionDigits: Math.abs(price.amount) < 1 ? 8 : 1,
      }).format(price.amount)}{' '}
      {price.currency === 'chaos' ? 'c' : 'div'}
    </>
  ) : (
    <span>
      —<span className="sr-only">Not estimated</span>
    </span>
  );
}
export function TargetArt({
  item,
  category,
}: {
  item?: PresentedItem | undefined;
  category: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="target-art">
      {item?.iconUrl && failed !== item.iconUrl ? (
        <img
          src={item.iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(item.iconUrl)}
        />
      ) : (
        <span role="img" aria-label={`${category}: image unavailable`}>
          {category.slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}
const modifierGroups = [
  ['prefix', 'Prefixes'],
  ['suffix', 'Suffixes'],
  ['implicit', 'Implicits'],
  ['enchant', 'Enchantments'],
  ['other', 'Other requirements'],
] as const;
export function TargetDetailDialog({
  output,
  recipeId,
  tab,
  onSelect,
  onClose,
  leagueId,
}: {
  output: RecipeLibraryOutput;
  recipeId: string;
  tab: 'market' | 'recipe';
  onSelect: (recipeId: string, tab: 'market' | 'recipe') => void;
  onClose: () => void;
  leagueId?: string | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [marketOpened, setMarketOpened] = useState(tab === 'market');
  useEffect(() => {
    if (tab === 'market') setMarketOpened(true);
  }, [tab]);
  const [range, setRange] = useState<TrendRange>('7d');
  const [chartMode, setChartMode] = useState<'line' | 'candles'>('candles');
  const [detail, setDetail] = useState<RecipeDetailView | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const entry = output.methods.find((e) => e.recipe.id === recipeId);
  const validRecipeId = entry?.recipe.id;
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setFailed(false);
    if (!validRecipeId) return;
    void api
      .getRecipe(
        validRecipeId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      )
      .then((response) => {
        if (!controller.signal.aborted) {
          const value = response.data;
          if (
            value?.recipe.id === validRecipeId &&
            value.targetSignature === output.id
          )
            setDetail(value);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [validRecipeId, output.id, revision, leagueId]);
  const currentDetail =
    detail &&
    detail.recipe.id === validRecipeId &&
    detail.targetSignature === output.id
      ? detail
      : null;
  const item = currentDetail?.presentation.target ?? output.entry.itemPreview;
  const cost = entry?.evaluation.expectedCraftCost ?? null;
  const comparison = compareExpectedCostWithAsk({
    expectedCost: cost
      ? { amount: String(cost.amount), currency: cost.currency }
      : null,
    ask: output.ask
      ? { amount: String(output.ask.amount), currency: output.ask.currency }
      : null,
  });
  const tradeUrl = currentDetail?.targetTradeUrl;
  const safeTrade =
    tradeUrl && /^https:\/\/www\.pathofexile\.com\/trade\//.test(tradeUrl)
      ? tradeUrl
      : null;
  return (
    <dialog
      ref={dialog}
      className="target-dialog"
      aria-labelledby="target-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, summary, [tabindex]',
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.hasAttribute('disabled') &&
            element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="target-dialog-heading">
        <h2 id="target-detail-title">{output.name}</h2>
        <Button aria-label="Close item detail" onClick={onClose}>
          Close ×
        </Button>
      </header>
      <div className="target-dialog-body">
        <aside
          className="target-requirements"
          aria-label="Exact item requirements"
        >
          <TargetArt item={item} category={output.category} />
          <h3>{item?.name ?? output.name}</h3>
          <p>
            Target requirements ·{' '}
            {output.entry.recipe.patch ?? 'Patch unspecified'}
          </p>
          {item ? (
            <>
              <dl>
                {item.properties.map((p) => (
                  <div key={p.id}>
                    <dt>{p.label}</dt>
                    <dd>{p.value ?? 'Unknown'}</dd>
                  </div>
                ))}
              </dl>
              {modifierGroups.map(([kind, label]) => {
                const mods = item.modifiers.filter(
                  (m) => m.generationType === kind,
                );
                return mods.length ? (
                  <section key={kind}>
                    <h4>{label}</h4>
                    <ul>
                      {mods.map((m, i) => (
                        <li key={`${m.canonicalId}-${i}`}>{m.label}</li>
                      ))}
                    </ul>
                  </section>
                ) : null;
              })}
              {!item.modifiers.length ? (
                <p>Modifier requirements unavailable.</p>
              ) : null}
            </>
          ) : (
            <p>Structured requirements unavailable.</p>
          )}
        </aside>
        <section className="target-detail-column">
          <div
            className="target-detail-tabs"
            role="tablist"
            aria-label="Item detail"
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 'market'
                  : event.key === 'End'
                    ? 'recipe'
                    : tab === 'market'
                      ? 'recipe'
                      : 'market';
              onSelect(recipeId, next);
              document.getElementById(`${next}-tab`)?.focus();
            }}
          >
            <button
              role="tab"
              aria-selected={tab === 'market'}
              tabIndex={tab === 'market' ? 0 : -1}
              aria-controls="market-panel"
              id="market-tab"
              onClick={() => onSelect(recipeId, 'market')}
            >
              Market
            </button>
            <button
              role="tab"
              aria-selected={tab === 'recipe'}
              tabIndex={tab === 'recipe' ? 0 : -1}
              aria-controls="recipe-panel"
              id="recipe-tab"
              onClick={() => onSelect(recipeId, 'recipe')}
            >
              Recipe
            </button>
          </div>
          <label className="target-method">
            Craft method
            <NativeSelect
              aria-label="Craft method"
              value={validRecipeId ?? ''}
              onChange={(e) => onSelect(e.target.value, tab)}
            >
              {!entry ? (
                <option value="">
                  Requested method unavailable in this scope
                </option>
              ) : null}
              {output.methods.map((e) => (
                <option value={e.recipe.id} key={e.recipe.id}>
                  {e.recipe.methodName ?? e.recipe.craftMethod}
                </option>
              ))}
            </NativeSelect>
          </label>
          <p className="target-coverage">
            {output.coverage.estimated}/{output.coverage.total} matching routes
            estimated in {output.currency} · {output.coverage.unknown} unknown ·{' '}
            {output.recipeIds.length} saved recipes for this output. Lowest
            known cost; unknown alternatives are unranked.
          </p>
          <div
            role="tabpanel"
            id="market-panel"
            aria-labelledby="market-tab"
            hidden={tab !== 'market'}
          >
            <section
              aria-label="Current asking evidence"
              className="target-quote-evidence"
            >
              <h3>
                Observed ask <LibraryMoney price={output.ask} />
              </h3>
              <dl>
                <div>
                  <dt>
                    {output.quoteEvidence?.comparableOnly
                      ? 'Comparable sample'
                      : 'Captured sample'}
                  </dt>
                  <dd>{output.quoteEvidence?.captured ?? '—'}</dd>
                </div>
                <div>
                  <dt>Reported listings</dt>
                  <dd>{output.quoteEvidence?.reported ?? '—'}</dd>
                </div>
                <div>
                  <dt>Sample sellers</dt>
                  <dd>{output.quoteEvidence?.sellers ?? '—'}</dd>
                </div>
                <div>
                  <dt>Inferred exits (reported 24h window)</dt>
                  <dd>{output.quoteEvidence?.exits ?? 'Not measured'}</dd>
                </div>
              </dl>
              <p>
                Capture coverage: {output.quoteEvidence?.coverage ?? 'unknown'}.{' '}
                {output.quoteAt ? (
                  <>
                    Captured {formatTimestamp(output.quoteAt)}
                    {output.quoteStale
                      ? ' · stale'
                      : output.quoteStale === null
                        ? ' · freshness unknown'
                        : ''}
                    .
                  </>
                ) : (
                  'Capture time unavailable.'
                )}{' '}
                Activity follows the source's reported 24h window; its exact end
                time is unavailable. Exits are inferred disappearances, not
                confirmed sales.
              </p>
            </section>
            {marketOpened ? (
              <TargetMarketHistory
                expectedLeagueId={leagueId}
                recipeIds={output.recipeIds}
                range={range}
                onRangeChange={setRange}
                mode={chartMode}
                onModeChange={setChartMode}
              />
            ) : null}
            <p>
              Asking quotes are not confirmed sales. Traded volume is unknown.
            </p>
          </div>
          <div
            role="tabpanel"
            id="recipe-panel"
            aria-labelledby="recipe-tab"
            hidden={tab !== 'recipe'}
          >
            <div className="target-economics">
              <div>
                <small>Expected craft cost</small>
                <strong>
                  <LibraryMoney price={cost} />
                </strong>
              </div>
              <div>
                <small>Observed ask</small>
                <strong>
                  <LibraryMoney price={output.ask} />
                </strong>
              </div>
              <div>
                <small>Provisional spread</small>
                <strong>
                  {comparison.profit !== null && cost ? (
                    <>
                      {Number(comparison.profit) > 0 ? '+' : ''}
                      <LibraryMoney
                        price={{
                          amount: Number(comparison.profit),
                          currency: cost.currency,
                        }}
                      />
                    </>
                  ) : (
                    '—'
                  )}
                </strong>
              </div>
            </div>
            <p className="target-disclaimer">
              {output.quoteAt ? (
                <span>
                  {output.quoteStale === null
                    ? 'Quote captured (freshness unknown)'
                    : output.quoteStale
                      ? 'Stale quote'
                      : 'Quote captured'}
                  : {formatTimestamp(output.quoteAt)}.{' '}
                </span>
              ) : null}
              Ask − modeled craft cost. Comparability and realized profit are
              unverified.
            </p>
            {!entry ? (
              <p role="alert">
                This exact recipe does not belong to the active scope.
              </p>
            ) : failed ? (
              <div role="alert">
                Exact recipe details could not be loaded.{' '}
                <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
              </div>
            ) : !currentDetail ? (
              <p role="status">Loading exact recipe…</p>
            ) : (
              <>
                <h3>Base preparation</h3>
                <p>{currentDetail.base.name}</p>
                <ul>
                  {currentDetail.base.requirements.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
                <h3>Crafting sequence</h3>
                {currentDetail.method.steps.length ? (
                  <ol className="target-steps">
                    {currentDetail.method.steps.map((step) => (
                      <li key={step.id}>
                        <h4>{step.title}</h4>
                        <p>{step.action}</p>
                        <p>
                          <strong>Continue when:</strong> {step.continueWhen}
                        </p>
                        <p>
                          <strong>On failure:</strong> {step.failureAction}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No steps are available for this exact recipe.</p>
                )}
                <h3>Materials</h3>
                <ul>
                  {currentDetail.method.steps.flatMap((step) =>
                    step.materials.map((m) => (
                      <li key={`${step.id}-${m.itemId}`}>
                        {m.name} · {m.quantityPerAttempt ?? 'Unknown quantity'}{' '}
                        per attempt · <LibraryMoney price={m.unitPrice} />
                      </li>
                    )),
                  )}
                </ul>
                <details>
                  <summary>Calculation and source evidence</summary>
                  <p>
                    Procedure verification: {currentDetail.verification}. Model
                    status: {currentDetail.evaluation.status}. Cost
                    verification:{' '}
                    {(currentDetail.readiness?.costVerified ??
                    entry?.readiness?.costVerified)
                      ? 'verified'
                      : 'unverified'}
                    . Confidence: {currentDetail.confidence ?? 'Unknown'}.
                  </p>
                  <p>
                    Estimate scope:{' '}
                    {currentDetail.costBreakdown
                      ? 'Modeled base and declared consumables; base already included in the total.'
                      : 'Full scope unavailable. Do not assume this estimate includes every expense.'}{' '}
                    Player time and unmodeled selling expenses are excluded.
                  </p>
                  <p>
                    Base evidence:{' '}
                    <LibraryMoney price={currentDetail.method.baseCost} />. This
                    is explanatory and is not added to the total again.
                  </p>
                  {currentDetail.evaluation.evaluatedAt ? (
                    <p>
                      Evaluated:{' '}
                      {formatTimestamp(currentDetail.evaluation.evaluatedAt)}
                    </p>
                  ) : null}
                  {currentDetail.method.evidence ? (
                    <p>{currentDetail.method.evidence.assumptions}</p>
                  ) : null}
                  <ul>
                    {currentDetail.uncertainties.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                  {currentDetail.method.priceSources.map((source, i) => (
                    <p key={i}>
                      {source.source} · {source.league} · {source.currency} ·{' '}
                      {formatTimestamp(source.capturedAt)}
                    </p>
                  ))}
                </details>
              </>
            )}
          </div>
        </section>
      </div>
      <footer className="target-dialog-footer">
        <FavoriteButton
          recipeId={recipeId}
          targetId={output.id}
          aliases={output.recipeIds}
        />
        {safeTrade ? (
          <a href={safeTrade} target="_blank" rel="noreferrer">
            Open Trade ↗
          </a>
        ) : (
          <span>Trade link unavailable</span>
        )}
        <Button onClick={onClose}>Done</Button>
      </footer>
    </dialog>
  );
}

function TargetMarketHistory({
  expectedLeagueId,
  recipeIds,
  range,
  onRangeChange,
  mode,
  onModeChange,
}: {
  expectedLeagueId?: string | undefined;
  recipeIds: string[];
  range: TrendRange;
  onRangeChange: (range: TrendRange) => void;
  mode: 'line' | 'candles';
  onModeChange: (mode: 'line' | 'candles') => void;
}) {
  const [trend, setTrend] = useState<RecipeTrend | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [partial, setPartial] = useState(false);
  const idsKey = recipeIds.join('|');
  useEffect(() => {
    const controller = new AbortController();
    setTrend(null);
    setFailed(false);
    setPartial(false);
    const ids = idsKey.split('|');
    // shortcut: legacy history is recipe-keyed; use one real sibling series, upgrade to versioned target history in MAX-1318.
    void Promise.allSettled(
      ids.map((id) =>
        api.getRecipeTrend(
          id,
          range,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const series = results.flatMap((result, index) =>
        result.status === 'fulfilled' &&
        result.value.data.recipeId === ids[index] &&
        result.value.data.range === range &&
        (!expectedLeagueId || result.value.data.league?.id === expectedLeagueId)
          ? [result.value.data]
          : [],
      );
      series.sort(
        (a, b) =>
          (b.summary?.windowObservations ?? 0) -
            (a.summary?.windowObservations ?? 0) ||
          (b.summary?.latestObservedAt ?? '').localeCompare(
            a.summary?.latestObservedAt ?? '',
          ),
      );
      setTrend(series[0] ?? null);
      setFailed(!series.length);
      setPartial(series.length < results.length);
    });
    return () => controller.abort();
  }, [idsKey, range, revision, expectedLeagueId]);
  const current =
    trend &&
    recipeIds.includes(trend.recipeId) &&
    trend.range === range &&
    (!expectedLeagueId || trend.league?.id === expectedLeagueId)
      ? trend
      : null;
  return (
    <>
      <div className="target-history-controls">
        <label>
          History range
          <NativeSelect
            aria-label="History range"
            value={range}
            onChange={(e) => {
              const value = e.target.value;
              if (
                value === '24h' ||
                value === '7d' ||
                value === '30d' ||
                value === '1y'
              )
                onRangeChange(value);
            }}
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="1y">1 year</option>
          </NativeSelect>
        </label>
        <div role="group" aria-label="Chart style">
          <Button
            aria-pressed={mode === 'candles'}
            onClick={() => onModeChange('candles')}
          >
            Candles
          </Button>
          <Button
            aria-pressed={mode === 'line'}
            onClick={() => onModeChange('line')}
          >
            Line
          </Button>
        </div>
      </div>
      {failed ? (
        <p role="alert">
          Price history unavailable.{' '}
          <Button onClick={() => setRevision((n) => n + 1)}>
            Retry history
          </Button>
        </p>
      ) : current ? (
        <>
          <PriceTrendChart trend={current} mode={mode} />
          {partial ? (
            <p role="status">
              Some recipe history sources are unavailable; target coverage is
              incomplete.{' '}
              <Button onClick={() => setRevision((n) => n + 1)}>
                Retry history
              </Button>
            </p>
          ) : null}
          <p>
            {current.summary?.windowObservations ?? 0} independent observations
            in this window. {current.league?.name ?? 'League unavailable'} ·
            asking prices.
          </p>
          <small>
            History source: {current.recipeId}. Single recipe-keyed series for
            these exact requirements; overlapping captures are not combined.
          </small>
        </>
      ) : (
        <p role="status">Loading history…</p>
      )}
    </>
  );
}
