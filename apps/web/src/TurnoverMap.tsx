import { useId } from 'react';

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
  const min = Math.min(...items.map(({ price }) => price));
  const max = Math.max(...items.map(({ price }) => price));
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
  const peak = Math.max(1, ...items.map((item) => item.activity ?? 0));
  const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
  const step = Math.max(1, Math.ceil((peak * 1.1) / 4 / magnitude) * magnitude);
  const yMax = step * 4;
  const mapId = useId();
  const groups = new Map<string, TurnoverPoint[]>();
  for (const item of items) {
    const key = `${item.price}:${item.activity}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const describe = (item: TurnoverPoint) =>
    `${axisLabel.format(item.price)} ${currency}, ${item.activity === null ? 'activity not measurable' : `${rate.format(item.activity)} ${activityDescription}`}`;
  return (
    <div
      className={`trade-map${items.length > 12 ? ' trade-map--dense' : ''}${items.some((item) => item.activity === null) ? ' trade-map--unknown' : ''}`}
    >
      <p className="trade-map__axis">{activityLabel}</p>
      <div
        className="trade-map__graph"
        role="group"
        aria-label="All recipes price and activity plot"
      >
        {[0, 1, 2, 3, 4].map((tick) => (
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
        {[...groups.values()].map((group, index) => {
          const item = group[0]!;
          const left = x(item.price);
          const bottom =
            item.activity === null ? -30 : (item.activity / yMax) * 100;
          const popoverId = `${mapId}-${index}`;
          return (
            <span key={item.id}>
              <button
                aria-label={`${group.length > 1 ? `${group.length} recipes` : item.name}, ${describe(item)}`}
                aria-pressed={group.some((item) => item.id === selected)}
                className={`trade-map__point${left > 50 ? ' trade-map__point--label-left' : ''}`}
                onClick={
                  group.length === 1 ? () => onSelect(item.id) : undefined
                }
                popoverTarget={group.length > 1 ? popoverId : undefined}
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
              {group.length > 1 ? (
                <div
                  className="trade-map__choices"
                  id={popoverId}
                  popover="auto"
                  role="group"
                  aria-label="Recipes at this point"
                >
                  <p>{describe(item)}</p>
                  {group.map((recipe) => (
                    <button
                      type="button"
                      key={recipe.id}
                      popoverTarget={popoverId}
                      popoverTargetAction="hide"
                      onClick={() => onSelect(recipe.id)}
                    >
                      {recipe.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          );
        })}
      </div>
      <p className="trade-map__axis trade-map__axis--price">
        Observed asking price · {currency} (log scale)
      </p>
      <p className="trade-map__axis trade-map__overlap">
        Numbers group recipes at the same price and activity. Select one to
        choose a recipe.
      </p>
    </div>
  );
}
