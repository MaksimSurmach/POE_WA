import { Card } from '@heroui/react';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { observedAsk } from './catalog.js';

export function CatalogOverview({ entries }: { entries: CatalogEntry[] }) {
  const values = [
    ['Recipes', entries.length],
    ['Observed asks', entries.filter((entry) => observedAsk(entry)).length],
    [
      'Cost estimates',
      entries.filter(
        (entry) =>
          entry.readiness?.costVerified ??
          Boolean(entry.evaluation.expectedCraftCost),
      ).length,
    ],
    [
      'Measurable activity',
      entries.filter((entry) => entry.readiness?.activityMeasurable).length,
    ],
  ];
  return (
    <section
      className="catalog-overview"
      aria-label="Market collection summary"
    >
      {values.map(([label, value]) => (
        <Card key={label} className="catalog-overview__metric">
          <Card.Description>{label}</Card.Description>
          <strong>{value}</strong>
        </Card>
      ))}
    </section>
  );
}
