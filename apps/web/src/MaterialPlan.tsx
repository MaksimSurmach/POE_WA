import { useContext, useState } from 'react';
import { calculateCostScenario } from '@poe-worksmith/domain/economics';
import type { RecipeDetailView } from '@poe-worksmith/contracts';
import { Button, Input, NativeSelect, TableSurface } from './ui.js';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
import { CraftRiskSection } from './CraftRiskSection.js';
import { useSearchParams } from 'react-router-dom';
import { formatTimestamp } from './dateTime.js';
import { Money } from './components.js';
import { PreviewMode } from './previewMode.js';
import {
  initialPlan,
  planLine,
  planMaterials,
  planScope,
  readPlan,
  refreshPlanPrices,
  planTsv,
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
  const currencies = [
    ...new Set(
      lines.map((row) => row.currency).filter((currency) => currency !== null),
    ),
  ];
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
  const complete = lines.every(
    (row) => row.currency && row.result?.cost !== null && row.result,
  );
  const capturedDates = [
    ...new Set(lines.map((row) => row.capturedAt).filter(Boolean)),
  ];
  batchParams.set(
    'planNote',
    `Среднее ожидаемой закупки, ${draft.count} предметов, патч ${detail.gameVersion}, лига ${league}. Даты цен: ${capturedDates.join(', ') || 'неизвестны'}. Ручные цены: ${lines.some((row) => row.origin === 'manual') ? 'да' : 'нет'}. Не фактические расходы.`,
  );
  if (singleTotal && complete) {
    batchParams.set('plannedBudget', singleTotal.cost);
    batchParams.set('plannedCurrency', totals[0]!.currency);
  }
  function planText() {
    return planTsv([
      [
        detail.recipe.title,
        league,
        detail.gameVersion,
        `${draft.count} предметов`,
      ],
      [
        'Оценка средних расходов; не гарантированный бюджет и не фактические расходы',
      ],
      [
        'Материал',
        'Нужно (ожидаемое)',
        'Есть',
        'Докупить (ожидаемое)',
        'Цена',
        'Валюта',
        'Источник цены',
        'Дата цены',
      ],
      ...lines.map((row) => [
        row.name,
        String(row.result?.needed ?? ''),
        row.owned,
        String(row.result?.buy ?? ''),
        row.price,
        row.currency ?? '',
        row.origin === 'manual' ? 'Ручной ввод' : 'Рыночный источник',
        row.capturedAt ?? '',
      ]),
    ]);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(planText());
      setNotice('План скопирован.');
    } catch {
      setNotice(
        'Буфер обмена недоступен. Скачайте план в TSV; копирование требует HTTPS и разрешения браузера.',
      );
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob(['\uFEFF', planText()], {
        type: 'text/tab-separated-values;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `worksmith-${detail.recipe.id}-materials.tsv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        План сохраняется только в этой вкладке браузера. Все цены плана
        зафиксированы: обновление рынка их не меняет. Кнопка «Обновить цены»
        заменяет рыночные цены и валюты последними загруженными котировками,
        сохраняя ручные цены, количество и остатки. Неизвестная цена требует
        ручного ввода с выбором валюты. Это оценка средних расходов; покупки и
        списания регистрируются отдельно в мастерской. Пустое поле означает
        неизвестное значение.
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
        Количество готовых предметов
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
                  'Докупить (ожидаемое)',
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
                    <small>
                      {row.currency ?? 'Валюта неизвестна'} ·{' '}
                      {row.origin === 'manual'
                        ? 'Ручная цена'
                        : 'Рыночная цена'}
                    </small>
                    <small>
                      {row.capturedAt
                        ? formatTimestamp(row.capturedAt)
                        : 'Дата цены неизвестна'}
                    </small>
                    {row.origin === 'market' &&
                    materials.find((material) => material.id === row.id)
                      ?.capturedAt !== row.capturedAt ? (
                      <small>В источнике есть новые цены</small>
                    ) : null}
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
                  <td>
                    {input(
                      row.id,
                      'price',
                      `Цена (${row.currency ?? 'выберите валюту'})`,
                    )}
                    <NativeSelect
                      aria-label={`Валюта: ${row.name}`}
                      value={row.currency ?? ''}
                      onChange={(event) =>
                        update({
                          ...draft,
                          rows: {
                            ...draft.rows,
                            [row.id]: {
                              ...draft.rows[row.id]!,
                              currency: event.target.value
                                ? (event.target.value as 'chaos' | 'divine')
                                : null,
                              origin: 'manual',
                              capturedAt: null,
                            },
                          },
                        })
                      }
                    >
                      <option value="">Выберите валюту</option>
                      <option value="chaos">chaos</option>
                      <option value="divine">divine</option>
                    </NativeSelect>
                  </td>
                  <td>
                    {row.result?.cost == null || row.currency === null
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
      {!complete ? (
        <p role="status" className="recipe-warning">
          План неполный: укажите количество, цену и валюту недостающих
          материалов. Цены — неотрицательные числа до 8 знаков после точки;
          количество предметов — от 1 до 1000.
        </p>
      ) : null}
      <div className="workspace-actions">
        <Button
          type="button"
          disabled={sourceUnavailable}
          onClick={() => {
            update(refreshPlanPrices(draft, materials));
            setNotice(
              'Рыночные цены и валюты обновлены. Ручные цены, количество и остатки сохранены.',
            );
          }}
        >
          Обновить цены
        </Button>
        <Button type="button" onClick={download}>
          Скачать TSV
        </Button>
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
          <p>
            Серверный бюджет для одного готового предмета: P50{' '}
            <Money price={detail.evaluation.budget?.p50 ?? null} /> · P90{' '}
            <Money price={detail.evaluation.budget?.p90 ?? null} />. Эти
            квантили не включают правки плана и не умножаются на количество
            предметов.
          </p>
          <p className="catalog-price-note">
            Ручные цены меняют только план покупки. Расчёт риска ниже использует
            сохранённую серверную модель и её собственные цены. Цель и число
            повторений симуляции задаются отдельно; число в плане — количество
            готовых предметов, а не попыток.
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
              [id]: {
                ...row,
                [field]: event.target.value,
                ...(field === 'price'
                  ? { origin: 'manual', capturedAt: null }
                  : {}),
              },
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
