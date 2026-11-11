import type { CatalogEntry } from '@poe-worksmith/contracts';
import { Link } from 'react-router-dom';
import { observedAsk } from './catalog.js';

export function CatalogOverview({ entries }: { entries: CatalogEntry[] }) {
  const estimated = entries.filter(
    (entry) => entry.evaluation.profit !== null,
  ).length;
  const priced = entries.filter((entry) => observedAsk(entry) !== null).length;
  const active = entries.filter(
    ({ readiness: r }) =>
      r?.fresh && r.activityMeasurable && (r.last24h.inferredExits ?? 0) > 0,
  ).length;
  return (
    <section
      className="catalog-decision"
      aria-label="Market collection summary"
    >
      <h2>
        {estimated
          ? `${estimated} recipes have an ask-based profit estimate`
          : priced
            ? 'Prices are available. Profit is not verified yet.'
            : 'No current asking prices are available.'}
      </h2>
      <p className="catalog-decision__facts">
        <span>
          {priced} of {entries.length} recipes with observed asks
        </span>
        <span>{active} with observed listing exits</span>
        <Link to="/recipes">Browse crafting steps</Link>
      </p>
    </section>
  );
}
