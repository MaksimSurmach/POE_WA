import { useId, useState } from 'react';

const rate = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const axisLabel = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 });

export type TurnoverPoint = {
  id: string;
  name: string;
  price: number;
  activity: number | null;
};

export function TurnoverMap({
  items,
  selected,
  onSelect,
  currency = 'divine',
  activityLabel = 'Sustained disappearances / 24h',
  activityDescription = 'sustained exits per day',
}: {
  items: TurnoverPoint[];
  selected: string | null;
  currency?: string;
  activityLabel?: string;
  activityDescription?: string;
  onSelect(id: string): void;
}) {
  items = items.filter(
    ({ price, activity }) =>
      Number.isFinite(price) &&
      price > 0 &&
      (activity === null || (Number.isFinite(activity) && activity >= 0)),
  );
  const min = items.length ? Math.min(...items.map(({ price }) => price)) : 1;
  const max = items.length ? Math.max(...items.map(({ price }) => price)) : 1;
  const ticks = Array.from(
    {
      length:
        Math.ceil(Math.log10(max * 1.35)) -
        Math.floor(Math.log10(min / 1.35)) +
        1,
    },
    (_, index) => 10 ** (Math.floor(Math.log10(min / 1.35)) + index),
  ).flatMap((value) => [value, value * 2, value * 5]);
  const floor =
    ticks.filter((value) => value > 0 && value <= min / 1.25).at(-1) ?? min;
  const ceiling = ticks.find((value) => value >= max * 1.25) ?? max * 1.25;
  const logSpan = Math.log(ceiling) - Math.log(floor);
  const x = (value: number) =>
    ((Math.log(value) - Math.log(floor)) / logSpan) * 100;
  const priceTicks = ticks.filter(
    (value) => value >= floor && value <= ceiling,
  );
  const stride = Math.max(1, Math.ceil(priceTicks.length / 5));
  const peak = Math.max(0, ...items.map((item) => item.activity ?? 0));
  const { step, max: yMax } = activityScale(peak);
  const mapId = useId();
  const [choices, setChoices] = useState<TurnoverPoint[]>([]);
  const groups = new Map<string, TurnoverPoint[]>();
  for (const item of items) {
    const key = `${item.price}:${item.activity}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const describe = (item: TurnoverPoint) =>
    `${axisLabel.format(item.price)} ${currency}, ${item.activity === null ? 'activity not measurable' : `${rate.format(item.activity)} ${activityDescription}`}`;
  if (!items.length)
    return (
      <p>
        No fresh priced observations to plot. Check the price table or
        collection status.
      </p>
    );
  return (
    <div
      className={`trade-map${peak === 0 ? ' trade-map--zero' : ''}${items.length > 12 ? ' trade-map--dense' : ''}${items.some((item) => item.activity === null) ? ' trade-map--unknown' : ''}`}
    >
      <p className="trade-map__axis">{activityLabel}</p>
      {peak === 0 ? (
        <p className="trade-map__axis">
          No positive listing activity recorded. Prices below remain observable;
          demand is unconfirmed.
        </p>
      ) : null}
      <div
        className="trade-map__graph"
        role="group"
        aria-label="All recipes price and activity plot"
      >
        {(peak === 0 ? [0] : [0, 1, 2, 3, 4]).map((tick) => (
          <span
            className="trade-map__guide trade-map__guide--y"
            aria-hidden="true"
            key={tick}
            style={{ bottom: `${tick * 25}%` }}
          >
            <span>{axisLabel.format(tick * step)}</span>
          </span>
        ))}
        {priceTicks.map((value, index) =>
          index % stride === 0 ? (
            <span
              className="trade-map__guide trade-map__guide--x"
              aria-hidden="true"
              key={value}
              style={{ left: `${x(value)}%` }}
            >
              <span>{axisLabel.format(value)}</span>
            </span>
          ) : null,
        )}
        {items.some((item) => item.activity === null) ? (
          <span className="trade-map__unknown-label">
            Activity not measurable · price only
          </span>
        ) : null}
        {[...groups.values()].map((group) => {
          const item = group[0]!;
          const left = x(item.price);
          const bottom =
            item.activity === null ? -30 : (item.activity / yMax) * 100;
          return (
            <span key={item.id}>
              <button
                aria-label={`${group.length > 1 ? `${group.length} recipes` : item.name}, ${describe(item)}`}
                aria-pressed={group.some((item) => item.id === selected)}
                className={`trade-map__point${left > 50 ? ' trade-map__point--label-left' : ''}`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x =
                    event.detail === 0
                      ? rect.x + rect.width / 2
                      : event.clientX;
                  const y =
                    event.detail === 0
                      ? rect.y + rect.height / 2
                      : event.clientY;
                  const marks = event.currentTarget
                    .closest('.trade-map__graph')!
                    .querySelectorAll('.trade-map__point');
                  const grouped = [...groups.values()];
                  const hits = [...marks].flatMap((mark, index) => {
                    const box = mark.getBoundingClientRect();
                    return x >= box.left &&
                      x <= box.right &&
                      y >= box.top &&
                      y <= box.bottom
                      ? grouped[index]!
                      : [];
                  });
                  if (hits.length <= 1) {
                    event.preventDefault();
                    onSelect(hits[0]?.id ?? item.id);
                  } else setChoices(hits);
                }}
                popoverTarget={mapId}
                style={{ left: `${left}%`, bottom: `${bottom}%` }}
                title={group.map((item) => item.name).join(' · ')}
                type="button"
              >
                {group.length > 1 ? (
                  <span className="trade-map__count">{group.length}</span>
                ) : null}
                <span className="trade-map__label" aria-hidden="true">
                  {group.length > 1 ? `${group.length} recipes` : item.name}
                </span>
              </button>
            </span>
          );
        })}
      </div>
      <div
        className="trade-map__choices"
        id={mapId}
        popover="auto"
        role="group"
        aria-label="Recipes at this point"
      >
        <p>Select a recipe · exact observations</p>
        {choices.map((recipe) => (
          <button
            type="button"
            key={recipe.id}
            popoverTarget={mapId}
            popoverTargetAction="hide"
            onClick={() => onSelect(recipe.id)}
          >
            {recipe.name}
            <small>{describe(recipe)}</small>
          </button>
        ))}
      </div>
      <p className="trade-map__axis trade-map__axis--price">
        Observed asking price · {currency} (log scale)
      </p>
      <p className="trade-map__axis trade-map__overlap">
        Numbers group coincident recipes. Overlapping marks open a chooser with
        exact prices and activity.
      </p>
    </div>
  );
}

/** Nice tick steps also work for rates below one exit per day. */
export function activityScale(peak: number) {
  if (peak <= 0) return { step: 0, max: 1 };
  const target = (peak * 1.1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const factor = [1, 2, 5, 10].find((value) => value * magnitude >= target)!;
  const step = factor * magnitude;
  return { step, max: step * 4 };
}
