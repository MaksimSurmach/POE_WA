import type { CatalogEntry } from '@poe-worksmith/contracts';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
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
          ? `${estimated} целей с оценкой разницы между затратами и asking price`
          : priced
            ? 'Цены доступны. Оценка прибыли пока не подтверждена.'
            : 'Актуальных цен объявлений пока нет.'}
      </h2>
      <details>
        <summary>Данные о ценах и активности</summary>
        <p className="catalog-decision__facts">
          <span>
            {priced} из {entries.length} целей с наблюдаемыми ценами
          </span>
          <span>{active} целей с наблюдаемыми исчезновениями объявлений</span>
          <Link to="/recipes">Открыть рецепты</Link>
        </p>
      </details>
    </section>
  );
}
