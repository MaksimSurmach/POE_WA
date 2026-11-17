import { useContext, useState } from 'react';
import { calculateCostScenario } from '@poe-worksmith/domain/economics';
import type { RecipeDetailView } from '@poe-worksmith/contracts';
import { Button, Input, TableSurface } from './ui.js';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
import { CraftRiskSection } from './CraftRiskSection.js';
import { useSearchParams } from 'react-router-dom';
import { PreviewMode } from './previewMode.js';
import {
  initialPlan,
  planLine,
  planMaterials,
  planScope,
  readPlan,
  type PlanDraft,
} from './materialPlanModel.js';

export function MaterialPlan({
  detail,
  budget = false,
  sourceUnavailable = false,
}: {
  detail: RecipeDetailView;
  budget?: boolean;
  sourceUnavailable?: boolean;
}) {
  const preview = useContext(PreviewMode);
  const [params] = useSearchParams();
  const materials = planMaterials(detail);
  const league =
    detail.method.priceSources[0]?.league ??
    params.get('league') ??
    'Лига неизвестна';
  const key = `${preview ? 'preview:' : ''}worksmith:plan:${planScope(detail, league)}`;
  const [draft, setDraft] = useState(() => {
    try {
      return readPlan(sessionStorage.getItem(key), initialPlan(materials));
    } catch {
      return initialPlan(materials);
    }
  });
  const [notice, setNotice] = useState('');
  function update(next: PlanDraft) {
    setDraft(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
      setNotice('');
    } catch {
      setNotice(
        'Хранилище браузера недоступно. Перед переходом скопируйте план.',
      );
    }
  }
  const lines = materials.map((row) => ({
    ...row,
    ...draft.rows[row.id]!,
    result: planLine(draft.rows[row.id]!, draft.count),
  }));
  const currencies = [...new Set(materials.map((row) => row.currency))];
  const totals = currencies.map((currency) => {
    const rows = lines.filter((row) => row.currency === currency);
    // The shared decimal calculator also rejects incomplete and invalid inputs.
    const amounts = rows.map((row) => row.result?.cost ?? '');
    return { currency, amounts };
  });
  const singleTotal =
    totals.length === 1
      ? calculateCostScenario({
          bases: '0',
          other: '0',
          sale: '',
          materials: totals[0]!.amounts.map((unitPrice) => ({
            quantity: '1',
            unitPrice,
          })),
        })
      : null;
  const batchParams = new URLSearchParams({
    recipe: detail.recipe.id,
    planCount: draft.count,
  });
  if (singleTotal) {
    batchParams.set('plannedBudget', singleTotal.cost);
    batchParams.set('plannedCurrency', totals[0]!.currency);
  }
  async function copy() {
    const text = [
      `${detail.recipe.title} · ${league} · ${draft.count} предметов`,
      'Материал\tНужно\tЕсть\tДокупить\tЦена\tВалюта',
      ...lines.map(
        (row) =>
          `${row.name}\t${row.result?.needed ?? '?'}\t${row.owned}\t${row.result?.buy ?? '?'}\t${row.price || '?'}\t${row.currency}`,
      ),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('План скопирован.');
    } catch {
      setNotice('Не удалось скопировать. Разрешите доступ к буферу обмена.');
    }
  }
  return (
    <section className="material-plan">
      <header className="catalog-heading">
        <div>
          <h2>{budget ? 'Бюджет крафта' : 'План материалов'}</h2>
          <p>
            {league} · {detail.gameVersion} · {detail.method.name}
          </p>
        </div>
      </header>
      <p className="catalog-price-note">
        План сохраняется только в этой вкладке браузера. Ручные правки не
        обновляются вместе с рынком. Это оценка расхода; покупки и списания
        регистрируются отдельно в мастерской. Пустое поле означает неизвестное
        значение.
      </p>
      {sourceUnavailable ? (
        <p role="status" className="recipe-warning">
          Источники не удалось обновить. План использует последние загруженные
          данные и ручные правки.
        </p>
      ) : null}
      {detail.evaluation.status === 'stale' ? (
        <p className="recipe-warning">
          Цены устарели. Проверьте источники перед покупкой.
        </p>
      ) : null}
      <label className="plan-count">
        Количество предметов
        <Input
          aria-label="Количество предметов"
          type="number"
          min="1"
          max="1000"
          step="1"
          value={draft.count}
          onChange={(event) => update({ ...draft, count: event.target.value })}
        />
      </label>
      <div
        className="data-scroll"
        role="region"
        aria-label="План материалов"
        tabIndex={0}
      >
        <TableSurface>
          <table className="table__content plan-table">
            <thead>
              <tr>
                {[
                  'Материал',
                  'На предмет',
                  'Нужно',
                  'Есть',
                  'Докупить',
                  'Цена за единицу',
                  'Сумма покупки',
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    {row.name}
                    <small>{row.currency}</small>
                  </th>
                  <td>{input(row.id, 'needed', 'На предмет')}</td>
                  <td>
                    {row.result?.needed.toLocaleString('ru-RU', {
                      maximumFractionDigits: 8,
                    }) ?? '—'}
                  </td>
                  <td>{input(row.id, 'owned', 'Есть')}</td>
                  <td>
                    {row.result?.buy.toLocaleString('ru-RU', {
                      maximumFractionDigits: 8,
                    }) ?? '—'}
                  </td>
                  <td>{input(row.id, 'price', `Цена (${row.currency})`)}</td>
                  <td>
                    {row.result?.cost == null
                      ? '—'
                      : `${row.result.cost} ${row.currency === 'divine' ? 'div' : 'c'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableSurface>
      </div>
      <div className="plan-totals">
        {totals.map(({ currency, amounts }) => (
          <PlanTotal key={currency} currency={currency} amounts={amounts} />
        ))}
      </div>
      {lines.some((row) => !row.result || row.result.cost === null) ? (
        <p role="status" className="recipe-warning">
          План неполный: укажите количество и цену недостающих материалов. Цены
          — неотрицательные числа до 8 знаков после точки; количество предметов
          — от 1 до 1000.
        </p>
      ) : null}
      <div className="workspace-actions">
        <Button type="button" onClick={() => void copy()}>
          Скопировать план
        </Button>
        <Link
          to={
            budget
              ? `/recipes/${encodeURIComponent(detail.recipe.id)}?view=materials`
              : `/?recipe=${encodeURIComponent(detail.recipe.id)}&view=budget`
          }
        >
          {budget ? 'К материалам' : 'Изменить бюджет'}
        </Link>
        <Link to={`/factory?${batchParams}`}>Создать партию</Link>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      <p className="catalog-price-note">
        Средние расходы не гарантируют результат отдельного крафта. P90 бюджета
        не означает вероятность продажи или прибыль. Суммы в разных валютах
        показаны отдельно.
      </p>
      {budget ? (
        <>
          <p className="catalog-price-note">
            Ручные цены меняют только план покупки. Расчёт риска ниже использует
            сохранённую серверную модель и её собственные цены.
          </p>
          <CraftRiskSection recipeId={detail.recipe.id} />
        </>
      ) : null}
    </section>
  );
  function input(
    id: string,
    field: 'needed' | 'owned' | 'price',
    label: string,
  ) {
    const row = draft.rows[id]!;
    return (
      <Input
        aria-label={`${label}: ${materials.find((material) => material.id === id)!.name}`}
        type="number"
        min="0"
        max="1000000000000"
        step="any"
        value={row[field]}
        placeholder="Неизвестно"
        onChange={(event) =>
          update({
            ...draft,
            rows: {
              ...draft.rows,
              [id]: { ...row, [field]: event.target.value },
            },
          })
        }
      />
    );
  }
}

function PlanTotal({
  currency,
  amounts,
}: {
  currency: string;
  amounts: string[];
}) {
  const result = calculateCostScenario({
    bases: '0',
    other: '0',
    sale: '',
    materials: amounts.map((unitPrice) => ({ quantity: '1', unitPrice })),
  });
  return (
    <p>
      Докупить ({currency}):{' '}
      <strong>
        {result
          ? `${result.cost} ${currency === 'divine' ? 'div' : 'c'}`
          : 'Не рассчитано'}
      </strong>
    </p>
  );
}
