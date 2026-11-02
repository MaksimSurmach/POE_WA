import {
  craftCostBreakdownSchema,
  type BeltOpportunity,
} from '@poe-worksmith/contracts';
import { displayPrice } from './marketWorkbench.js';

export function MarketCraftCosts({
  opportunity,
}: {
  opportunity: BeltOpportunity;
}) {
  const calculation = opportunity.calculation;
  if (!calculation) return null;
  const parsed = craftCostBreakdownSchema.safeParse(calculation.breakdown);
  if (!parsed.success) return <p>Подробный состав затрат недоступен.</p>;
  const cost = parsed.data;
  return (
    <>
      <dl className="market-target-properties">
        <div>
          <dt>База · {cost.base.label}</dt>
          <dd>
            {displayPrice(
              Number(cost.base.total.amount),
              cost.base.total.currency,
            )}
          </dd>
        </div>
        <div>
          <dt>Ожидаемые попытки</dt>
          <dd>{cost.expectedAttempts}</dd>
        </div>
        {cost.materials.map((line) => (
          <div key={line.id}>
            <dt>
              {line.label} · {line.quantity} за попытку
            </dt>
            <dd>
              {displayPrice(Number(line.total.amount), line.total.currency)} /
              попытка
            </dd>
          </div>
        ))}
        <div>
          <dt>Материалы · все попытки</dt>
          <dd>
            {displayPrice(
              Number(cost.expectedMaterials.amount),
              cost.expectedMaterials.currency,
            )}
          </dd>
        </div>
        {cost.baseReplacement && (
          <div>
            <dt>
              Замены базы · {cost.baseReplacement.expectedReplacements}, с
              учётом возврата
            </dt>
            <dd>
              {displayPrice(
                Number(cost.baseReplacement.netCost.amount),
                cost.baseReplacement.netCost.currency,
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Завершение крафта</dt>
          <dd>
            {displayPrice(
              Number(cost.finishingTotal.amount),
              cost.finishingTotal.currency,
            )}
          </dd>
        </div>
        <div>
          <dt>Всего · ожидаемые затраты</dt>
          <dd>
            {displayPrice(
              Number(calculation.expectedCraftCost),
              cost.base.total.currency,
            )}
          </dd>
        </div>
      </dl>
      <ul>
        {opportunity.priceEvidence.map((source, index) => {
          if (
            !source ||
            typeof source !== 'object' ||
            Array.isArray(source) ||
            typeof source.url !== 'string' ||
            !source.url.startsWith('https://')
          )
            return null;
          return (
            <li key={index}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {typeof source.name === 'string' ? source.name : 'Цена базы'} ↗
              </a>
              {typeof source.capturedAt === 'string'
                ? ` · ${source.capturedAt}`
                : ''}
            </li>
          );
        })}
      </ul>
    </>
  );
}
