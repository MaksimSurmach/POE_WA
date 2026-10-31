import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  marketSnapshotImportSchema,
  marketTargetInputSchema,
  type BeltOpportunity,
  type MarketTarget,
  type MarketWorkbenchResponse,
  type MarketResearchSnapshotSummary,
} from '@poe-worksmith/contracts';

import { marketClient } from './marketClient.js';
import { marketDemo } from './marketDemo.js';
import { EconomyPanel } from './EconomyPanel.js';
import {
  displayDate,
  displayPrice,
  filterTargets,
  latestSnapshot,
  marketStatus,
  snapshotsForTarget,
} from './marketWorkbench.js';
import './market.css';

type Tab = 'targets' | 'snapshots' | 'sources' | 'collection';
type Workbench = MarketWorkbenchResponse['data'];

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить действие.';
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MarketPage() {
  const [data, setData] = useState<Workbench | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [tab, setTab] = useState<Tab>('targets');
  const [search, setSearch] = useState('');
  const [league, setLeague] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [opportunities, setOpportunities] = useState<BeltOpportunity[]>([]);
  const [opportunityKind, setOpportunityKind] = useState<'observed' | 'demo'>(
    'observed',
  );
  const [opportunityError, setOpportunityError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'target' | 'snapshot' | null>(null);
  const [priceTarget, setPriceTarget] = useState<MarketTarget | null>(null);
  const [rawSnapshot, setRawSnapshot] = useState<unknown | null>(null);
  const [beltAnalysis, setBeltAnalysis] = useState<
    import('@poe-worksmith/contracts').BeltAnalysis | null
  >(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setData(await marketClient.load());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!data || data.storage !== 'postgres') return;
    let active = true;
    setOpportunityError(null);
    void marketClient
      .opportunities(opportunityKind)
      .then((value) => {
        if (active) setOpportunities(value);
      })
      .catch((cause: unknown) => {
        if (active) setOpportunityError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [data, opportunityKind]);

  const workbench = demo ? marketDemo : data;
  const kind = demo ? 'demo' : 'observed';
  const targets = workbench?.targets ?? [];
  const snapshots = workbench?.snapshots ?? [];
  const visibleTargets = filterTargets(targets, search, league);
  const selected =
    visibleTargets.find((target) => target.id === selectedId) ??
    visibleTargets[0] ??
    null;
  const leagues = [...new Set(targets.map((target) => target.league))].sort();
  const observed = snapshots.filter((snapshot) => snapshot.dataKind === kind);
  const historySnapshots = demo ? observed : snapshots;
  const lastObservation = observed
    .map((snapshot) => snapshot.capturedAt)
    .sort()
    .at(-1);
  const withoutData = targets.filter(
    (target) => latestSnapshot(target, snapshots, kind) === null,
  ).length;
  const canWrite = !demo && data?.storage === 'postgres';
  const sourceRows = workbench?.sources ?? marketDemo.sources;

  async function showSnapshot(snapshot: MarketResearchSnapshotSummary) {
    setBeltAnalysis(null);
    if (demo) {
      setRawSnapshot(snapshot);
      return;
    }
    try {
      const [raw, analysis] = await Promise.all([
        marketClient.getSnapshot(snapshot.id),
        marketClient.analyzeBelt(
          snapshot.id,
          targets.find((entry) => entry.id === snapshot.targetId)?.beltRules
            ?.version ?? 1,
        ),
      ]);
      setRawSnapshot(raw);
      setBeltAnalysis(analysis);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="market-workbench">
      <section className="market-heading">
        <div>
          <p className="market-eyebrow">POE 1 · PC · РЫНОЧНАЯ РАЗВЕДКА</p>
          <h1>Что стоит крафтить?</h1>
          <p className="market-intro">
            От потребности билда — к проверяемой цене предмета. Цели, источники
            и история наблюдений в одном месте.
          </p>
        </div>
        <div className="market-heading__actions">
          <button
            type="button"
            className="market-button market-button--primary"
            disabled={!canWrite}
            onClick={() => setDialog('target')}
          >
            + Добавить цель
          </button>
          <button
            type="button"
            className="market-button"
            onClick={() => {
              setDemo(!demo);
              setLeague('all');
              setSelectedId('');
            }}
          >
            {demo ? 'Вернуться к своим данным' : 'Посмотреть пример'}
          </button>
        </div>
      </section>

      {demo ? (
        <div className="market-notice market-notice--demo" role="status">
          <strong>Демонстрация интерфейса.</strong> Все цены и билды здесь
          учебные. Пример не сохраняется и не является рекомендацией крафтить.
        </div>
      ) : error ? (
        <div className="market-notice market-notice--warning" role="alert">
          <strong>Нет связи с данными.</strong> {error}{' '}
          <button type="button" onClick={() => void reload()}>
            Повторить
          </button>
        </div>
      ) : data?.storage === 'unavailable' ? (
        <div className="market-notice market-notice--warning" role="status">
          <strong>Хранилище ещё не подключено.</strong> Для сохранения целей и
          снимков нужен backend с PostgreSQL. Пока можно изучить пример
          интерфейса.
        </div>
      ) : null}

      {!demo && data?.storage === 'postgres' && (
        <section aria-label="Пояса для крафта" className="market-notice">
          <h2>Пояса для крафта</h2>
          <p>
            Цена предложения не означает продажу. Числовой разрыв не гарантирует
            прибыль. Расчёт использует один и тот же базовый предмет при
            повторах.
          </p>
          <label>
            Данные:{' '}
            <select
              value={opportunityKind}
              onChange={(event) =>
                setOpportunityKind(
                  event.target.value === 'demo' ? 'demo' : 'observed',
                )
              }
            >
              <option value="observed">Реальные наблюдения</option>
              <option value="demo">DEMO · синтетические данные</option>
            </select>
          </label>
          {opportunityError && (
            <p role="alert">Не удалось загрузить анализ: {opportunityError}</p>
          )}
          {opportunities.length === 0 && !opportunityError && (
            <p>
              Нет сохранённых целей для поясов. Запустите импорт библиотеки.
            </p>
          )}
          {opportunities.map((opportunity) => (
            <article key={opportunity.targetId}>
              <h3>
                {opportunity.name} · {opportunity.status}{' '}
                {opportunity.economicConclusion === 'POSITIVE'
                  ? '· Положительная разница'
                  : opportunity.economicConclusion === 'NON_POSITIVE'
                    ? '· Нулевая или отрицательная разница'
                    : ''}{' '}
                {opportunityKind === 'demo' ? '· DEMO' : ''}
              </h3>
              <p>
                {opportunity.league} · {opportunity.patch} ·{' '}
                {opportunity.builds.join(', ')} ·{' '}
                {opportunity.capturedAt
                  ? displayDate(opportunity.capturedAt)
                  : 'нет наблюдений'}
              </p>
              <p>
                Затраты:{' '}
                {opportunity.calculation
                  ? `${opportunity.calculation.expectedCraftCost} ${opportunity.calculation.currency}`
                  : '—'}{' '}
                · Цена предложения:{' '}
                {opportunity.calculation
                  ? `${opportunity.calculation.askingPrice} ${opportunity.calculation.currency}`
                  : '—'}{' '}
                · Разрыв:{' '}
                {opportunity.calculation
                  ? `${opportunity.calculation.spread} ${opportunity.calculation.currency}`
                  : '—'}
              </p>
              <p>
                {opportunity.reasons.join(' ') ||
                  'Риск: ручная выборка и заявленные допущения метода.'}
              </p>
              {opportunity.method && (
                <button
                  type="button"
                  className="market-button"
                  onClick={() => {
                    const selectedTarget = targets.find(
                      (entry) => entry.id === opportunity.targetId,
                    );
                    if (selectedTarget) setPriceTarget(selectedTarget);
                  }}
                >
                  Обновить цены
                </button>
              )}
              <details>
                <summary>Источники, правила и расчёт</summary>
                <ul>
                  {opportunity.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>{' '}
                      {source.notes}
                    </li>
                  ))}
                </ul>
                {opportunity.sourceUrl && (
                  <a
                    href={opportunity.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Источник снимка
                  </a>
                )}
                {opportunity.rules && (
                  <div>
                    <p>
                      Правила v{opportunity.rules.version}: база{' '}
                      {targets
                        .find((item) => item.id === opportunity.targetId)
                        ?.baseTypes.join(', ')}
                      , уровень{' '}
                      {opportunity.rules.minItemLevel == null
                        ? 'любой'
                        : `${opportunity.rules.minItemLevel}+`}
                      ,{' '}
                      {opportunity.rules.corrupted == null
                        ? 'осквернение любое'
                        : opportunity.rules.corrupted
                          ? 'осквернён'
                          : 'не осквернён'}
                      ; влияния:{' '}
                      {opportunity.rules.influences == null
                        ? 'любые'
                        : opportunity.rules.influences.join(', ') || 'нет'}
                      .
                    </p>
                    <ul>
                      {opportunity.rules.mods.map((mod) => (
                        <li key={mod.id}>
                          {mod.id}: минимум {mod.minValue}
                          {mod.maxTier ? `, tier ${mod.maxTier} или лучше` : ''}
                        </li>
                      ))}
                    </ul>
                    {opportunity.rules.version !== 1 &&
                      opportunity.rules.totalElementalResistanceMin != null && (
                        <p>
                          Сумма сопротивлений стихиям: минимум{' '}
                          {opportunity.rules.totalElementalResistanceMin}%.
                        </p>
                      )}
                  </div>
                )}
                {opportunity.method && (
                  <div>
                    <p>
                      Метод:{' '}
                      <a
                        href={opportunity.method.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {opportunity.method.name}
                      </a>{' '}
                      · {opportunity.method.assumptions}
                    </p>
                    <ol>
                      {opportunity.method.steps.map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ol>
                    <p>
                      {opportunity.method.success.mode === 'probability'
                        ? `Вероятность: ${opportunity.method.success.probability}`
                        : `Ожидаемые попытки: ${opportunity.method.success.expectedAttempts}`}
                    </p>
                  </div>
                )}
                {opportunity.snapshotId && (
                  <button
                    type="button"
                    className="market-link-button"
                    onClick={() => {
                      const snapshot = snapshots.find(
                        (entry) => entry.id === opportunity.snapshotId,
                      );
                      if (snapshot) void showSnapshot(snapshot);
                    }}
                  >
                    Объявления и причины
                  </button>
                )}
                <pre className="market-json">
                  {JSON.stringify(
                    {
                      rules: opportunity.rules,
                      method: opportunity.method,
                      priceEvidence: opportunity.priceEvidence,
                      calculation: opportunity.calculation,
                      comparison: opportunity.comparison,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </article>
          ))}
        </section>
      )}

      <section className="market-metrics" aria-label="Состояние исследования">
        <Metric
          value={String(targets.length)}
          label="Целей на проверке"
          detail="Профили нужных предметов"
        />
        <Metric
          value={String(observed.length)}
          label="Снимков рынка"
          detail={demo ? 'Учебные данные' : 'Сохранённые наблюдения'}
        />
        <Metric
          value={String(withoutData)}
          label="Без рыночных данных"
          detail="Сначала проверить предложения"
        />
        <Metric
          value={lastObservation ? displayDate(lastObservation) : '—'}
          label="Последнее наблюдение"
          detail="Время данных, а не открытия страницы"
          small
        />
      </section>

      <div className="market-navigation">
        <div role="tablist" aria-label="Разделы исследования">
          {(
            [
              ['targets', 'Возможности'],
              ['snapshots', 'Снимки'],
              ['collection', 'Сбор'],
              ['sources', 'Источники'],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`market-panel-${id}`}
              id={`market-tab-${id}`}
              key={id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="market-refresh"
          type="button"
          disabled={loading || demo}
          onClick={() => void reload()}
        >
          {loading ? 'Загрузка…' : '↻ Обновить экран'}
        </button>
      </div>

      {tab === 'targets' ? (
        <section
          role="tabpanel"
          id="market-panel-targets"
          aria-labelledby="market-tab-targets"
        >
          <div className="market-filters">
            <label className="market-search">
              <span className="market-sr-only">Найти цель</span>
              <input
                type="search"
                placeholder="Поиск по базе, модам или билду…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span className="market-sr-only">Лига</span>
              <select
                value={league}
                onChange={(event) => setLeague(event.target.value)}
              >
                <option value="all">Все лиги · раздельные данные</option>
                {leagues.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loading && !data && !demo ? (
            <Empty title="Загружаем рабочее пространство…" />
          ) : visibleTargets.length === 0 ? (
            <Empty
              title={
                targets.length
                  ? 'Ничего не найдено'
                  : 'Начните с предмета, который нужен билду'
              }
            >
              <p>
                {targets.length
                  ? 'Измените поиск или выберите другую лигу.'
                  : 'Укажите базу, обязательные свойства и источник билда. Снимки покажут, как меняются цены сопоставимых предложений.'}
              </p>
              <button
                type="button"
                className="market-button market-button--primary"
                onClick={() => (canWrite ? setDialog('target') : setDemo(true))}
              >
                {canWrite ? 'Создать первую цель' : 'Открыть учебный пример'}
              </button>
            </Empty>
          ) : (
            <div className="market-workspace-grid">
              <div
                className="market-target-list"
                aria-label="Цели для исследования"
              >
                <div className="market-list-heading">
                  <span>Предмет / потребность</span>
                  <span>Цена предложения</span>
                </div>
                {visibleTargets.map((target) => {
                  const snapshot = latestSnapshot(target, snapshots, kind);
                  const status = marketStatus(snapshot);
                  return (
                    <button
                      type="button"
                      className={`market-target-row ${selected?.id === target.id ? 'is-selected' : ''}`}
                      key={target.id}
                      aria-pressed={selected?.id === target.id}
                      onClick={() => setSelectedId(target.id)}
                    >
                      <span className="market-item-mark" aria-hidden="true">
                        {target.slot === 'Belt'
                          ? '◈'
                          : target.slot === 'Ring'
                            ? '◎'
                            : '◇'}
                      </span>
                      <span className="market-target-identity">
                        <strong>{target.name}</strong>
                        <span>
                          {target.baseTypes.join(' / ')} · {target.league}
                        </span>
                        <span className="market-build-label">
                          {target.builds[0] ?? 'Билд пока не указан'}
                        </span>
                        <span
                          className={`market-badge market-badge--${status.tone}`}
                        >
                          {status.label}
                        </span>
                      </span>
                      <span className="market-target-price">
                        <strong>
                          {snapshot
                            ? displayPrice(snapshot.median, snapshot.currency)
                            : '—'}
                        </strong>
                        <span>
                          {snapshot
                            ? `${snapshot.count} предложений`
                            : 'Нужен снимок'}
                        </span>
                        {snapshot && (
                          <span>{displayDate(snapshot.capturedAt)}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <p className="market-list-note">
                  Цены объявлений. Выборка определяется импортом; это не все
                  предложения рынка и не подтверждённые продажи.
                </p>
              </div>
              {selected && (
                <TargetPanel
                  key={`${selected.id}-${latestSnapshot(selected, snapshots, kind)?.id ?? 'empty'}`}
                  target={selected}
                  snapshots={snapshots}
                  kind={kind}
                  canWrite={canWrite}
                  onImport={() => setDialog('snapshot')}
                  onSnapshot={(snapshot) => void showSnapshot(snapshot)}
                />
              )}
            </div>
          )}
        </section>
      ) : tab === 'snapshots' ? (
        <section
          role="tabpanel"
          id="market-panel-snapshots"
          aria-labelledby="market-tab-snapshots"
        >
          <div className="market-section-heading">
            <div>
              <h2>История наблюдений</h2>
              <p>
                Каждый снимок сохраняет лигу, профиль цели, время и источник.
              </p>
            </div>
            <button
              type="button"
              className="market-button"
              disabled={!canWrite || !selected}
              onClick={() => setDialog('snapshot')}
            >
              Импорт снимка
            </button>
          </div>
          {historySnapshots.length === 0 ? (
            <Empty title="Снимков пока нет">
              <p>Выберите цель и импортируйте первое наблюдение рынка.</p>
            </Empty>
          ) : (
            <div className="market-table-scroll">
              <table className="market-snapshot-table">
                <thead>
                  <tr>
                    <th>Время данных</th>
                    <th>Цель / лига</th>
                    <th>Предложений</th>
                    <th>Медиана</th>
                    <th>Источник</th>
                    <th>
                      <span className="market-sr-only">Действие</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...historySnapshots]
                    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
                    .map((snapshot) => (
                      <tr key={snapshot.id}>
                        <td>{displayDate(snapshot.capturedAt)}</td>
                        <td>
                          {targets.find(
                            (target) => target.id === snapshot.targetId,
                          )?.name ?? 'Цель'}
                          <small>
                            {snapshot.league} · {snapshot.patch} ·{' '}
                            {snapshot.dataKind === 'demo' ? 'DEMO' : 'observed'}
                          </small>
                        </td>
                        <td>{snapshot.count}</td>
                        <td>
                          {displayPrice(snapshot.median, snapshot.currency)}
                        </td>
                        <td>
                          {demo ? (
                            'Учебный пример'
                          ) : (
                            <a
                              href={snapshot.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {new URL(snapshot.sourceUrl).hostname}
                            </a>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="market-link-button"
                            onClick={() => void showSnapshot(snapshot)}
                          >
                            Открыть
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {!demo &&
            snapshots.some((snapshot) => snapshot.dataKind === 'demo') && (
              <p className="market-footnote">
                Импортированные тестовые снимки показаны в истории с пометкой
                DEMO и исключены из рыночных показателей.
              </p>
            )}
        </section>
      ) : tab === 'collection' ? (
        <section
          role="tabpanel"
          id="market-panel-collection"
          aria-labelledby="market-tab-collection"
        >
          {selected ? (
            <MarketCollectionPanel
              onObservation={reload}
              key={selected.id}
              target={selected}
              canWrite={canWrite}
              onManualImport={() => setDialog('snapshot')}
            />
          ) : (
            <Empty title="Сначала выберите профиль предмета" />
          )}
        </section>
      ) : (
        <section
          role="tabpanel"
          id="market-panel-sources"
          aria-labelledby="market-tab-sources"
        >
          <div className="market-section-heading">
            <div>
              <h2>Откуда берутся данные</h2>
              <p>
                Билды объясняют потребность. Наблюдения рынка проверяют цену.
                Справочники описывают предмет.
              </p>
            </div>
          </div>
          <div className="market-source-grid">
            {sourceRows.map((source) => (
              <article className="market-source-card" key={source.id}>
                <span
                  className={`market-badge market-badge--${source.status === 'available' ? 'success' : 'muted'}`}
                >
                  {
                    {
                      available: 'Поддерживается',
                      planned: 'В разработке',
                      requires_approval: 'Нужен одобренный доступ',
                      manual_only: 'Ручной ввод',
                      unsupported: 'Недоступен для интеграции',
                    }[source.status]
                  }
                </span>
                <h3>{source.name}</h3>
                <p>{source.description}</p>
                <a
                  href={source.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть источник ↗
                </a>
              </article>
            ))}
          </div>
          <EconomyPanel demo={demo} />
          <div className="market-source-library">
            <h3>Библиотека источников билдов</h3>
            {targets.every((target) => target.sources.length === 0) ? (
              <p>
                Добавьте ссылки на гайды, YouTube, Reddit или PoB в профиль
                цели.
              </p>
            ) : (
              targets.flatMap((target) =>
                target.sources.map((source, index) => (
                  <div key={`${target.id}-${index}`}>
                    <span className="market-source-kind">{source.kind}</span>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.title} ↗
                    </a>
                    <span className="market-source-target">{target.name}</span>
                    {source.notes && (
                      <small className="market-source-notes">
                        {source.notes}
                      </small>
                    )}
                  </div>
                )),
              )
            )}
          </div>
        </section>
      )}

      <footer className="market-method-note">
        <strong>Как читать оценку.</strong> Медиана и диапазон p25–p75 описывают
        импортированную выборку. Пометки «малая выборка» (&lt; 5) и «старше 24
        часов» помогают проверять данные. Они не оценивают вероятность продажи;
        доходность появится после модели стоимости крафта.
      </footer>

      {dialog === 'target' && (
        <Dialog title="Новая цель исследования" onClose={() => setDialog(null)}>
          <TargetForm
            onSaved={async (target) => {
              setDialog(null);
              setSelectedId(target.id);
              setSearch('');
              setLeague('all');
              await reload();
            }}
          />
        </Dialog>
      )}
      {priceTarget && (
        <Dialog
          title={`Цены: ${priceTarget.name}`}
          onClose={() => setPriceTarget(null)}
        >
          <BeltPriceForm
            target={priceTarget}
            onSaved={async () => {
              setPriceTarget(null);
              await reload();
            }}
          />
        </Dialog>
      )}
      {dialog === 'snapshot' && selected && (
        <Dialog
          title={`Импорт: ${selected.name}`}
          onClose={() => setDialog(null)}
        >
          <SnapshotForm
            target={selected}
            onSaved={async () => {
              setDialog(null);
              await reload();
            }}
          />
        </Dialog>
      )}
      {rawSnapshot !== null && (
        <Dialog title="Сохранённый снимок" onClose={() => setRawSnapshot(null)}>
          <p className="market-footnote">
            {demo
              ? 'Синтетический пример. Это не ответ рыночного API.'
              : 'Исходные строки, происхождение и версия профиля для проверки расчёта.'}
          </p>
          {beltAnalysis && (
            <section>
              <h3>Сопоставимость объявлений</h3>
              <p>
                Версия: {beltAnalysis.algorithm}; независимых продавцов:{' '}
                {beltAnalysis.independentSellers}; подтверждено:{' '}
                {beltAnalysis.confirmedListings}.
              </p>
              <p>
                Нижний квартиль цены предложения:{' '}
                {displayPrice(
                  beltAnalysis.conservativeAskingPrice,
                  beltAnalysis.currency,
                )}
                . {beltAnalysis.selectionBias}
              </p>
              <p>
                Сравнение показывает только объявления; расчёт метода находится
                в панели поясов.
              </p>
              <ul>
                {beltAnalysis.rows.map((row) => (
                  <li key={row.index}>
                    #{row.index + 1}: {row.status} · {row.price}{' '}
                    {beltAnalysis.currency} ·{' '}
                    {row.reasons.join('; ') || 'совпадает'}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <button
            type="button"
            className="market-button"
            onClick={() => downloadJson('market-snapshot.json', rawSnapshot)}
          >
            Скачать JSON
          </button>
          <pre className="market-json">
            {JSON.stringify(rawSnapshot, null, 2)}
          </pre>
        </Dialog>
      )}
    </div>
  );
}

function Metric({
  value,
  label,
  detail,
  small = false,
}: {
  value: string;
  label: string;
  detail: string;
  small?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={small ? 'market-metric-small' : ''}>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function MarketCollectionPanel({
  target,
  canWrite,
  onManualImport,
  onObservation,
}: {
  target: MarketTarget;
  canWrite: boolean;
  onManualImport: () => void;
  onObservation: () => Promise<void>;
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof marketClient.collection>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const intervalDirty = useRef(false);
  const lastSnapshot = useRef<string | null>(null);

  useEffect(() => {
    const latest = data?.runs.find(
      (run) => !run.cached && run.snapshotId,
    )?.snapshotId;
    if (latest && latest !== lastSnapshot.current) {
      lastSnapshot.current = latest;
      void onObservation();
    }
  }, [data, onObservation]);

  useEffect(() => {
    let active = true;
    let loading = false;
    intervalDirty.current = false;
    async function reload() {
      if (loading) return;
      loading = true;
      try {
        const result = await marketClient.collection(target.id);
        if (!active) return;
        setData(result);
        setEnabled(result.settings?.enabled ?? false);
        setPaused(result.settings?.paused ?? false);
        if (!intervalDirty.current)
          setIntervalMinutes(result.settings?.intervalMinutes ?? 60);
        setError(null);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        loading = false;
      }
    }
    void reload();
    const timer = window.setInterval(() => void reload(), 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [target.id]);

  async function update(patch: {
    enabled?: boolean;
    paused?: boolean;
    intervalMinutes?: number;
  }) {
    setPending(true);
    setError(null);
    try {
      const settings = await marketClient.updateCollection(target.id, patch);
      setEnabled(settings.enabled);
      setPaused(settings.paused);
      if (patch.intervalMinutes !== undefined) {
        intervalDirty.current = false;
        setIntervalMinutes(settings.intervalMinutes);
      }
      setData(await marketClient.collection(target.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function runNow() {
    setPending(true);
    setError(null);
    try {
      await marketClient.runCollection(target.id);
      setData(await marketClient.collection(target.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function cancel(runId: string) {
    setPending(true);
    setError(null);
    try {
      await marketClient.cancelCollection(runId);
      setData(await marketClient.collection(target.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const activeRun = data?.runs.find((run) => run.status === 'running');
  const automaticUnavailable = !data || data.source.access === 'blocked';
  const statusLabel: Record<string, string> = {
    running: 'Выполняется',
    succeeded: 'Завершён',
    empty: 'Выдача пуста',
    partial: 'Частичный охват',
    blocked: 'Доступ заблокирован',
    rate_limited: 'Ожидание лимита',
    failed: 'Ошибка',
    cancelled: 'Отменён',
  };

  return (
    <>
      <div className="market-section-heading">
        <div>
          <h2>Сбор по профилю: {target.name}</h2>
          <p>
            {target.league} · {target.patch} · {target.baseTypes.join(', ')}
          </p>
        </div>
      </div>
      {data?.source.access === 'blocked' && (
        <div className="market-notice market-notice--warning" role="status">
          <strong>Автоматический источник не подключён.</strong>{' '}
          {data.source.reason} Пароль и cookies не используются. Импортируйте
          реальные выбранные объявления вручную: снимок попадёт и в историю
          collection, и в тот же анализатор рейтинга.{' '}
          <button
            type="button"
            className="market-button"
            disabled={!canWrite}
            onClick={onManualImport}
          >
            Импортировать наблюдение
          </button>
        </div>
      )}
      {data?.source.implementation && (
        <p>
          Режим:{' '}
          {data.source.implementation === 'manual'
            ? 'ручной импорт'
            : data.source.implementation === 'replay'
              ? 'тестовый replay'
              : 'источник не подключён'}
          . Разрешение:{' '}
          {data.source.authorization === 'user_supplied'
            ? 'ответственность импортирующего пользователя'
            : data.source.authorization === 'test_only'
              ? 'только тестовые данные'
              : 'автоматический доступ не подтверждён'}
          .
        </p>
      )}
      {!canWrite && (
        <div className="market-notice" role="status">
          Для управления сбором требуется подключённый PostgreSQL.
        </div>
      )}
      {error && (
        <div className="market-notice market-notice--warning" role="alert">
          {error}
        </div>
      )}
      <div className="market-notice">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canWrite || pending || automaticUnavailable}
            onChange={(event) => void update({ enabled: event.target.checked })}
          />{' '}
          Сбор включён
        </label>
        <label>
          Интервал, минут{' '}
          <input
            type="number"
            min={5}
            max={1440}
            step={5}
            value={intervalMinutes}
            disabled={!canWrite || pending || automaticUnavailable}
            onChange={(event) => {
              intervalDirty.current = true;
              setIntervalMinutes(Number(event.target.value));
            }}
          />
        </label>
        <button
          type="button"
          className="market-button"
          disabled={!canWrite || pending || automaticUnavailable}
          onClick={() => void update({ enabled, paused, intervalMinutes })}
        >
          Сохранить настройки
        </button>
        <button
          type="button"
          className="market-button market-button--primary"
          disabled={
            !canWrite || pending || automaticUnavailable || Boolean(activeRun)
          }
          onClick={() => void runNow()}
        >
          Запустить сейчас
        </button>
        {enabled && (
          <button
            type="button"
            className="market-button"
            disabled={!canWrite || pending}
            onClick={() => void update({ paused: !paused })}
          >
            {paused ? 'Продолжить расписание' : 'Пауза'}
          </button>
        )}
        {activeRun && (
          <button
            type="button"
            className="market-button"
            disabled={!canWrite || pending}
            onClick={() => void cancel(activeRun.id)}
          >
            Отменить текущий запуск
          </button>
        )}
        <p>
          В одном снимке сохраняется до 1 000 объявлений. Фактический охват
          определяет источник; частичный ответ не считается всем рынком.
        </p>
      </div>
      {data?.series.map((series) => (
        <section
          key={`${series.dataKind}:${series.currency}:${series.queryDigest}`}
        >
          <h3>
            Новые и изменившиеся объявления · {series.currency} ·{' '}
            {series.dataKind}
          </h3>
          <div className="market-table-scroll">
            <table className="market-snapshot-table">
              <thead>
                <tr>
                  <th>Наблюдение</th>
                  <th>Новые</th>
                  <th>Изменены</th>
                  <th>Нет в охвате</th>
                  <th>Вернулись</th>
                  <th>Медиана выборки</th>
                </tr>
              </thead>
              <tbody>
                {series.points.map((point) => (
                  <tr key={point.snapshotId}>
                    <td>
                      {point.cached ? 'Кешированный · ' : ''}
                      {displayDate(point.capturedAt)}
                    </td>
                    <td>{point.newCount}</td>
                    <td>{point.changedCount}</td>
                    <td>{point.missingCount}</td>
                    <td>{point.restoredCount}</td>
                    <td>{displayPrice(point.median, series.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="market-footnote">
            «Нет в охвате» означает отсутствие при полном повторном наблюдении;
            это не подтверждённая продажа.
          </p>
        </section>
      ))}
      <section>
        <h3>Запуски и охват</h3>
        {!data?.runs.length ? (
          <p>Истории управляемого сбора пока нет.</p>
        ) : (
          <div className="market-table-scroll">
            <table className="market-snapshot-table">
              <thead>
                <tr>
                  <th>Начат</th>
                  <th>Статус</th>
                  <th>Охват</th>
                  <th>Подробности</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{displayDate(run.startedAt)}</td>
                    <td>
                      {statusLabel[run.status] ?? run.status}
                      {run.cached ? ' · кеш' : ''}
                    </td>
                    <td>{run.coverage ?? 'не получен'}</td>
                    <td>
                      {run.listingCount}
                      {run.reportedTotal === null
                        ? ''
                        : ` из ${run.reportedTotal}`}
                      {run.cached ? ' · кеш' : ''}
                    </td>
                    <td>{run.errorCode ?? run.sourceId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="market-empty">
      <span aria-hidden="true">◇</span>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function TargetPanel({
  target,
  snapshots,
  kind,
  canWrite,
  onImport,
  onSnapshot,
}: {
  target: MarketTarget;
  snapshots: MarketResearchSnapshotSummary[];
  kind: 'observed' | 'demo';
  canWrite: boolean;
  onImport: () => void;
  onSnapshot: (snapshot: MarketResearchSnapshotSummary) => void;
}) {
  const all = snapshotsForTarget(target, snapshots, kind);
  const initialCurrency = all.at(-1)?.currency ?? 'divine';
  const [currency, setCurrency] = useState<'chaos' | 'divine'>(initialCurrency);
  const history = snapshotsForTarget(target, snapshots, kind, currency);
  const latest = history.at(-1);
  return (
    <aside className="market-target-panel" aria-label="Выбранная цель">
      <div className="market-panel-heading">
        <span className="market-eyebrow">ПРОФИЛЬ ЦЕЛИ</span>
        <span className="market-badge market-badge--muted">{target.slot}</span>
      </div>
      <h2>{target.name}</h2>
      <p className="market-target-context">
        {target.league} · патч {target.patch}
      </p>
      <dl className="market-target-properties">
        <div>
          <dt>База</dt>
          <dd>{target.baseTypes.join(' / ')}</dd>
        </div>
        <div>
          <dt>Уровень предмета</dt>
          <dd>
            {target.minItemLevel ? `${target.minItemLevel}+` : 'Не задан'}
          </dd>
        </div>
        {target.qualityMin != null && (
          <div>
            <dt>Качество</dt>
            <dd>{target.qualityMin}%+</dd>
          </div>
        )}
        {target.corrupted != null && (
          <div>
            <dt>Осквернение</dt>
            <dd>{target.corrupted ? 'Да' : 'Нет'}</dd>
          </div>
        )}
        {Boolean(target.influences?.length) && (
          <div>
            <dt>Влияние</dt>
            <dd>{target.influences?.join(', ')}</dd>
          </div>
        )}
      </dl>
      <h3>Обязательные свойства</h3>
      {target.requiredMods.length || target.beltRules ? (
        <ul className="market-mods">
          {target.requiredMods.map((mod, index) => (
            <li key={index}>{mod}</li>
          ))}
          {target.beltRules?.mods.map((mod) => (
            <li key={mod.id}>
              {mod.id}: минимум {mod.minValue}
            </li>
          ))}
          {target.beltRules &&
            target.beltRules.version !== 1 &&
            target.beltRules.totalElementalResistanceMin != null && (
              <li>
                Сумма сопротивлений стихиям: минимум{' '}
                {target.beltRules.totalElementalResistanceMin}%
              </li>
            )}
        </ul>
      ) : (
        <p className="market-footnote">Требования пока не указаны.</p>
      )}
      <div className="market-builds">
        <h3>Кому нужен предмет</h3>
        {target.builds.length ? (
          target.builds.map((build) => (
            <span className="market-build-chip" key={build}>
              {build}
            </span>
          ))
        ) : (
          <p className="market-footnote">Добавьте гипотезу о билде.</p>
        )}
        {target.sources.map((source, index) => (
          <a key={index} href={source.url} target="_blank" rel="noreferrer">
            {source.title} ↗
          </a>
        ))}
      </div>
      <section className="market-price-history">
        <div className="market-history-title">
          <h3>История медианы</h3>
          <label>
            <span className="market-sr-only">Валюта истории</span>
            <select
              value={currency}
              onChange={(event) =>
                setCurrency(event.target.value as 'chaos' | 'divine')
              }
            >
              <option value="divine">Divine</option>
              <option value="chaos">Chaos</option>
            </select>
          </label>
        </div>
        {latest ? (
          <>
            <strong className="market-current-price">
              {displayPrice(latest.median, currency)}
            </strong>
            <span className="market-price-range">
              p25–p75: {displayPrice(latest.p25, currency)} —{' '}
              {displayPrice(latest.p75, currency)}
            </span>
            <PriceChart snapshots={history} currency={currency} />
            <p className="market-footnote">
              {history.length} снимков · последнее:{' '}
              {displayDate(latest.capturedAt)}. Валюты и лиги не смешиваются.
            </p>
            <button
              type="button"
              className="market-link-button"
              onClick={() => onSnapshot(latest)}
            >
              Проверить исходный снимок ↗
            </button>
          </>
        ) : (
          <p className="market-no-history">
            Нет наблюдений в этой валюте. Добавьте снимок, чтобы начать историю.
          </p>
        )}
      </section>
      <button
        type="button"
        className="market-button market-button--primary market-wide"
        disabled={!canWrite}
        onClick={onImport}
      >
        + Импортировать наблюдение
      </button>
      <p className="market-footnote market-unknown">
        Стоимость крафта и ожидаемая прибыль ещё не рассчитаны.
      </p>
    </aside>
  );
}

function PriceChart({
  snapshots,
  currency,
}: {
  snapshots: MarketResearchSnapshotSummary[];
  currency: 'chaos' | 'divine';
}) {
  const valid = snapshots.filter((snapshot) => snapshot.median !== null);
  if (!valid.length)
    return (
      <p className="market-no-history">
        В сохранённых наблюдениях нет предложений.
      </p>
    );
  const values = valid.map((snapshot) => snapshot.median ?? 0);
  const min = Math.min(...values) * 0.9;
  const max = Math.max(...values) * 1.1;
  const start = Date.parse(snapshots[0]?.capturedAt ?? '');
  const end = Date.parse(snapshots.at(-1)?.capturedAt ?? '');
  const point = (snapshot: MarketResearchSnapshotSummary) => ({
    x:
      end === start
        ? 170
        : 10 +
          ((Date.parse(snapshot.capturedAt) - start) / (end - start)) * 320,
    y: 86 - (((snapshot.median ?? min) - min) / (max - min || 1)) * 70,
  });
  let connected = false;
  const path = snapshots
    .map((snapshot) => {
      if (snapshot.median === null) {
        connected = false;
        return '';
      }
      const { x, y } = point(snapshot);
      const command = `${connected ? 'L' : 'M'} ${x} ${y}`;
      connected = true;
      return command;
    })
    .join(' ');
  return (
    <div className="market-chart">
      <svg
        viewBox="0 0 340 104"
        role="img"
        aria-label={`Медиана цены в ${currency}, ${snapshots.length} снимков. Точные значения доступны в таблице снимков.`}
      >
        <path
          d="M 10 20 H 330 M 10 54 H 330 M 10 86 H 330"
          className="market-chart-grid"
        />
        <path d={path} className="market-chart-line" />
        {valid.map((snapshot) => (
          <circle
            key={snapshot.id}
            cx={point(snapshot).x}
            cy={point(snapshot).y}
            r="3.5"
          >
            <title>
              {displayDate(snapshot.capturedAt)}:{' '}
              {displayPrice(snapshot.median, currency)}
            </title>
          </circle>
        ))}
      </svg>
      <div>
        <span>
          {displayPrice(min, currency)} — {displayPrice(max, currency)}
        </span>
        <span>
          {snapshots.length > 1 ? 'Изменение наблюдений' : 'Одна точка'}
        </span>
      </div>
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="market-dialog"
      ref={ref}
      aria-labelledby="market-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="market-dialog-title">{title}</h2>
        <button type="button" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

function TargetForm({
  onSaved,
}: {
  onSaved: (target: MarketTarget) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [materialCount, setMaterialCount] = useState(1);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const lines = (key: string) =>
      value(key)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const sourceUrls = lines('sources');
    setPending(true);
    setError(null);
    try {
      const manualPrice = (amount: string, time: string, url: string) => ({
        source: 'manual',
        amount: Number(amount),
        currency: value('methodCurrency'),
        league: value('league'),
        patch: value('patch'),
        capturedAt: new Date(time).toISOString(),
        dataKind: value('priceKind'),
        url,
        notes: value('priceNotes'),
      });
      const wantsRules = form.has('useBeltRules');
      if (
        wantsRules &&
        [0, 1, 2].some((i) => value(`ruleId${i}`) && !value(`ruleMin${i}`))
      )
        throw new Error('Укажите числовой порог для каждого модификатора.');
      const ruleMods = [0, 1, 2]
        .filter((i) => value(`ruleId${i}`))
        .map((i) => ({
          id: value(`ruleId${i}`),
          minValue: Number(value(`ruleMin${i}`)),
          ...(value(`ruleTier${i}`)
            ? { maxTier: Number(value(`ruleTier${i}`)) }
            : {}),
        }));
      if (wantsRules && ruleMods.length === 0)
        throw new Error('Для правил укажите хотя бы один модификатор.');
      if (value('influences') && form.has('noInfluences'))
        throw new Error('Укажите влияния или выберите их отсутствие.');
      const ruleBase = {
        minItemLevel: value('ilevel') ? Number(value('ilevel')) : null,
        influences:
          value('influences') || form.has('noInfluences')
            ? value('influences')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean)
            : null,
        corrupted:
          value('corrupted') === 'any' ? null : value('corrupted') === 'yes',
        mods: ruleMods,
      };
      const rules = wantsRules
        ? {
            version: 3,
            ...ruleBase,
            totalElementalResistanceMin: value('totalRes')
              ? Number(value('totalRes'))
              : null,
          }
        : undefined;
      const wantsMethod = form.has('useMethod');
      if (wantsMethod && !form.has('sameBaseConfirmed'))
        throw new Error(
          'Подтвердите применимость метода с одной базой и без дополнительных расходов.',
        );
      const materialInputs = !wantsMethod
        ? []
        : Array.from({ length: materialCount }, (_, i) => ({
            id: value(`materialId${i}`),
            label: value(`materialLabel${i}`),
            quantityPerAttempt: Number(value(`materialQuantity${i}`)),
            price: manualPrice(
              value(`materialPrice${i}`),
              value(`materialTime${i}`),
              value(`materialURL${i}`),
            ),
          }));
      const method = wantsMethod
        ? {
            version: 1,
            name: value('methodName'),
            sourceUrl: value('methodURL'),
            assumptions: value('methodAssumptions'),
            steps: lines('methodSteps'),
            rulesComplete: form.has('rulesComplete'),
            repeatOnSameBase: true,
            success:
              value('successMode') === 'probability'
                ? {
                    mode: 'probability',
                    probability: Number(value('successValue')),
                  }
                : {
                    mode: 'expected_attempts',
                    expectedAttempts: Number(value('successValue')),
                  },
            basePrice: manualPrice(
              value('basePrice'),
              value('priceTime'),
              value('priceURL'),
            ),
            materials: materialInputs,
          }
        : undefined;
      const input = marketTargetInputSchema.parse({
        name: value('name'),
        game: 'poe1',
        realm: 'pc',
        league: value('league'),
        patch: value('patch'),
        slot: value('slot'),
        baseTypes: value('bases')
          .split(',')
          .map((base) => base.trim())
          .filter(Boolean),
        builds: value('builds')
          .split(',')
          .map((build) => build.trim())
          .filter(Boolean),
        requiredMods: lines('mods'),
        minItemLevel: value('ilevel') ? Number(value('ilevel')) : null,
        qualityMin: value('quality') ? Number(value('quality')) : null,
        corrupted:
          value('corrupted') === 'any' ? null : value('corrupted') === 'yes',
        influences: value('influences')
          .split(',')
          .map((influence) => influence.trim())
          .filter(Boolean),
        ...(method ? { beltCraftMethod: method } : {}),
        ...(rules ? { beltRules: rules } : {}),
        sources: sourceUrls.map((url) => {
          const parsed = new URL(url);
          const kind = /(^|\.)(youtube\.com|youtu\.be)$/.test(parsed.hostname)
            ? 'video'
            : /(^|\.)reddit\.com$/.test(parsed.hostname)
              ? 'reddit'
              : /(^|\.)pobb\.in$/.test(parsed.hostname)
                ? 'pob'
                : 'guide';
          return { title: parsed.hostname + parsed.pathname, url, kind };
        }),
      });
      await onSaved(await marketClient.createTarget(input));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="market-form" onSubmit={(event) => void submit(event)}>
      <p>
        Опишите предмет, для которого хотите проверить рынок. Ссылки сохраняются
        как источники; их содержание автоматически не загружается.
      </p>
      <label>
        Название цели
        <input
          required
          name="name"
          maxLength={200}
          placeholder="Сапоги для конкретного билда"
        />
      </label>
      <div className="market-form-grid">
        <label>
          Лига
          <input
            required
            name="league"
            maxLength={100}
            placeholder="Точное название лиги"
          />
        </label>
        <label>
          Патч
          <input
            required
            name="patch"
            maxLength={50}
            placeholder="Версия игры"
          />
        </label>
      </div>
      <div className="market-form-grid">
        <label>
          Слот
          <select name="slot">
            <option>Boots</option>
            <option>Belt</option>
            <option>Ring</option>
            <option>Amulet</option>
            <option>Helmet</option>
            <option>Gloves</option>
            <option>Body Armour</option>
            <option>Weapon</option>
            <option>Shield</option>
            <option>Jewel</option>
          </select>
        </label>
        <label>
          Минимальный item level
          <input
            type="number"
            name="ilevel"
            min={1}
            max={100}
            placeholder="84"
          />
        </label>
      </div>
      <label>
        Подходящие базы, через запятую
        <input
          required
          name="bases"
          placeholder="Two-Toned Boots, Dragonscale Boots"
        />
      </label>
      <label>
        Билды, через запятую
        <input name="builds" placeholder="Название билда / вариант бюджета" />
      </label>
      <label>
        Обязательные свойства, каждое с новой строки
        <textarea
          name="mods"
          rows={4}
          placeholder="30% increased Movement Speed&#10;+80 to maximum Life&#10;Свободный суффикс"
        />
      </label>
      <div className="market-form-grid">
        <label>
          Минимальное качество, %
          <input type="number" name="quality" min={0} max={100} />
        </label>
        <label>
          Осквернение
          <select name="corrupted" defaultValue="any">
            <option value="any">Любое / не задано</option>
            <option value="no">Нет</option>
            <option value="yes">Да</option>
          </select>
        </label>
      </div>
      <label>
        Влияния, через запятую
        <input name="influences" placeholder="Если важны для цели" />
      </label>
      <label>
        <input type="checkbox" name="noInfluences" /> Для правил пояса
        подтверждаю отсутствие влияний
      </label>
      <fieldset>
        <legend>Правила пояса</legend>
        <label>
          <input type="checkbox" name="useBeltRules" /> Включить проверку правил
          (незаполненные ограничения не применяются)
        </label>
        {[0, 1, 2].map((i) => (
          <div className="market-form-grid" key={i}>
            <label>
              Идентификатор мода {i + 1}
              <input
                name={`ruleId${i}`}
                placeholder="life или elemental_attack_damage"
              />
            </label>
            <label>
              Минимум
              <input type="number" name={`ruleMin${i}`} />
            </label>
            <label>
              Максимальный номер tier (если известен)
              <input type="number" name={`ruleTier${i}`} min="1" />
            </label>
          </div>
        ))}
        <label>
          Минимум суммы fire + cold + lightning resistance
          <input type="number" name="totalRes" min="0" />
        </label>
      </fieldset>
      <fieldset>
        <legend>Метод и исходные цены</legend>
        <label>
          <input type="checkbox" name="useMethod" /> Рассчитывать метод
        </label>
        <p>
          Поддерживается повтор на одной неизменной базе, без завершающих затрат
          или восстановления. Иные методы оставьте нерассчитанными.
        </p>
        <label>
          <input type="checkbox" name="sameBaseConfirmed" /> Подтверждаю: каждая
          попытка сохраняет ту же базу; восстановление, замена и завершающие
          операции не нужны.
        </label>
        <label>
          Название метода
          <input name="methodName" />
        </label>
        <label>
          Источник метода
          <input name="methodURL" type="url" />
        </label>
        <label>
          Шаги, по одному на строку
          <textarea name="methodSteps" />
        </label>
        <label>
          Допущения, вероятность и источник оценки
          <textarea name="methodAssumptions" />
        </label>
        <label>
          <input type="checkbox" name="rulesComplete" /> Правила покрывают все
          обязательные требования и метод применим
        </label>
        <label>
          Вид оценки
          <select name="successMode">
            <option value="probability">
              Вероятность за попытку от 0 до 1
            </option>
            <option value="expected_attempts">Ожидаемое число попыток</option>
          </select>
        </label>
        <label>
          Значение оценки
          <input type="number" step="any" name="successValue" />
        </label>
        <label>
          Валюта
          <select name="methodCurrency">
            <option value="chaos">chaos</option>
            <option value="divine">divine</option>
          </select>
        </label>
        <label>
          Вид данных
          <select name="priceKind">
            <option value="observed">Реальные</option>
            <option value="demo">DEMO</option>
          </select>
        </label>
        <label>
          Время цен
          <input type="datetime-local" name="priceTime" />
        </label>
        <label>
          Источник цен
          <input type="url" name="priceURL" />
        </label>
        <label>
          Примечание к ценам
          <input name="priceNotes" />
        </label>
        <label>
          Цена базы
          <input type="number" step="any" min="0" name="basePrice" />
        </label>
        {Array.from({ length: materialCount }, (_, i) => (
          <div className="market-form-grid" key={i}>
            <label>
              ID материала
              <input name={`materialId${i}`} placeholder="essence-of-greed" />
            </label>
            <label>
              Название
              <input name={`materialLabel${i}`} />
            </label>
            <label>
              На попытку
              <input type="number" step="any" name={`materialQuantity${i}`} />
            </label>
            <label>
              Цена за единицу
              <input type="number" step="any" name={`materialPrice${i}`} />
            </label>
            <label>
              Время цены материала
              <input type="datetime-local" name={`materialTime${i}`} />
            </label>
            <label>
              Источник материала
              <input type="url" name={`materialURL${i}`} />
            </label>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setMaterialCount((count) => Math.min(20, count + 1))}
        >
          Добавить материал
        </button>
      </fieldset>
      <label>
        Ссылки на источники, каждая с новой строки
        <textarea name="sources" rows={3} placeholder="https://…" />
      </label>
      {error && (
        <div className="market-notice market-notice--warning" role="alert">
          {error}
        </div>
      )}
      <button
        type="submit"
        className="market-button market-button--primary"
        disabled={pending}
      >
        {pending ? 'Сохраняем…' : 'Сохранить цель'}
      </button>
    </form>
  );
}

function SnapshotForm({
  target,
  onSaved,
}: {
  target: MarketTarget;
  onSaved: () => Promise<void>;
}) {
  const template = () => ({
    targetId: target.id,
    capturedAt: new Date().toISOString(),
    sourceUrl: 'https://www.pathofexile.com/trade',
    currency: 'divine',
    dataKind: 'demo',
    notes:
      'Учебный шаблон. Замените наблюдениями и укажите observed только для реальных данных.',
    listings: [
      {
        externalId: 'example-1',
        price: 2,
        item: { baseType: target.baseTypes[0], explicitMods: [] },
      },
      {
        externalId: 'example-2',
        price: 3,
        item: { baseType: target.baseTypes[0], explicitMods: [] },
      },
    ],
  });
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (new Blob([json]).size > 2 * 1024 * 1024)
        throw new Error('Максимальный размер снимка — 2 МБ.');
      const input = marketSnapshotImportSchema.parse(JSON.parse(json));
      if (input.targetId !== target.id)
        throw new Error('targetId должен соответствовать выбранной цели.');
      await marketClient.importSnapshot(input);
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <ManualSnapshotForm target={target} onSaved={onSaved} />
      <details>
        <summary>Дополнительно: импорт JSON</summary>
        <form className="market-form" onSubmit={(event) => void submit(event)}>
          <p>
            Импортируйте выбранные сопоставимые объявления. В одном снимке —
            одна валюта и до 1000 предложений. Цена объявления не означает
            состоявшуюся продажу.
          </p>
          <div className="market-import-context">
            <strong>{target.league}</strong>
            <span>
              Патч {target.patch} · профиль v{target.version}
            </span>
          </div>
          <div className="market-import-actions">
            <button
              type="button"
              className="market-button"
              onClick={() => setJson(JSON.stringify(template(), null, 2))}
            >
              Вставить учебный шаблон
            </button>
            <label className="market-file-label">
              Загрузить JSON
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    setError('Максимальный размер файла — 2 МБ.');
                    return;
                  }
                  void file
                    .text()
                    .then(setJson)
                    .catch((cause) => setError(errorMessage(cause)));
                }}
              />
            </label>
          </div>
          <label>
            Снимок в формате JSON
            <textarea
              className="market-json-input"
              required
              value={json}
              rows={14}
              onChange={(event) => setJson(event.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="market-footnote">
            capturedAt — время наблюдения. Для настоящих данных укажите
            dataKind: observed; учебные demo не участвуют в аналитике. Для
            успешно проверенного поиска без предложений передайте listings: [] и
            emptyResult: true.
          </p>
          {error && (
            <div className="market-notice market-notice--warning" role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="market-button market-button--primary"
            disabled={pending}
          >
            {pending ? 'Сохраняем…' : 'Сохранить снимок'}
          </button>
        </form>
      </details>
    </>
  );
}

function BeltPriceForm({
  target,
  onSaved,
}: {
  target: MarketTarget;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<
    import('@poe-worksmith/contracts').BeltPriceUpdate[]
  >([]);
  useEffect(() => {
    void marketClient
      .priceHistory(target.id)
      .then(setHistory)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [target.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const value = (name: string) => String(form.get(name) ?? '').trim();
      const dataKind =
        value('kind') === 'demo' ? ('demo' as const) : ('observed' as const);
      const currency =
        value('currency') === 'divine'
          ? ('divine' as const)
          : ('chaos' as const);
      const makePrice = (amount: string, time: string, url: string) => ({
        source: 'manual' as const,
        amount: Number(amount),
        currency,
        league: target.league,
        patch: target.patch,
        capturedAt: new Date(time).toISOString(),
        dataKind,
        url,
        notes: value('notes'),
      });
      const method = target.beltCraftMethod;
      if (!method) throw new Error('Сначала укажите метод крафта.');
      await marketClient.savePrices({
        targetId: target.id,
        dataKind,
        basePrice: makePrice(value('base'), value('time'), value('url')),
        materialPrices: Object.fromEntries(
          method.materials.map((m) => [
            m.id,
            makePrice(
              value(`material-${m.id}`),
              value(`material-time-${m.id}`),
              value(`material-url-${m.id}`),
            ),
          ]),
        ),
      });
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <form className="market-form" onSubmit={(event) => void submit(event)}>
      <p>
        Новое наблюдение сохраняется отдельно; исходная цель и история не
        изменяются. Укажите реальные или DEMO-данные.
      </p>
      <label>
        Вид данных
        <select name="kind">
          <option value="observed">Реальные</option>
          <option value="demo">DEMO</option>
        </select>
      </label>
      <label>
        Валюта
        <select name="currency">
          <option value="chaos">chaos</option>
          <option value="divine">divine</option>
        </select>
      </label>
      <label>
        Время цен
        <input required type="datetime-local" name="time" />
      </label>
      <label>
        Источник цен
        <input required type="url" name="url" />
      </label>
      <label>
        Основание оценки
        <input required name="notes" />
      </label>
      <label>
        Цена подходящей базы
        <input required type="number" step="any" min="0.00000001" name="base" />
      </label>
      {target.beltCraftMethod?.materials.map((material) => (
        <fieldset key={material.id}>
          <legend>{material.label}</legend>
          <label>
            Цена
            <input
              required
              type="number"
              step="any"
              min="0.00000001"
              name={`material-${material.id}`}
            />
          </label>
          <label>
            Время наблюдения
            <input
              required
              type="datetime-local"
              name={`material-time-${material.id}`}
            />
          </label>
          <label>
            Источник
            <input required type="url" name={`material-url-${material.id}`} />
          </label>
        </fieldset>
      ))}
      {error && <p role="alert">{error}</p>}
      <button type="submit">Сохранить цены</button>
      <details>
        <summary>История цен ({history.length})</summary>
        <ul>
          {history.map((item) => (
            <li key={item.id}>
              {displayDate(item.createdAt)} · {item.dataKind} ·{' '}
              {item.basePrice.source === 'manual'
                ? `${item.basePrice.amount} ${item.basePrice.currency}`
                : 'economy'}
              {item.basePrice.source === 'manual' && (
                <>
                  {' '}
                  · данные на {displayDate(item.basePrice.capturedAt)} ·{' '}
                  <a href={item.basePrice.url} target="_blank" rel="noreferrer">
                    источник
                  </a>{' '}
                  · {item.basePrice.notes}
                </>
              )}
              <ul>
                {Object.entries(item.materialPrices).map(([id, price]) => (
                  <li key={id}>
                    {id}:{' '}
                    {price.source === 'manual'
                      ? `${price.amount} ${price.currency}`
                      : `economy ${price.snapshotId} / ${price.lineId}`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </form>
  );
}

function ManualSnapshotForm({
  target,
  onSaved,
}: {
  target: MarketTarget;
  onSaved: () => Promise<void>;
}) {
  const [count, setCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const v = (name: string) => String(form.get(name) ?? '').trim();
      const currency =
        v('currency') === 'divine' ? ('divine' as const) : ('chaos' as const);
      const dataKind =
        v('kind') === 'demo' ? ('demo' as const) : ('observed' as const);
      const listings = Array.from({ length: count }, (_, i) => {
        const get = (field: string) => v(`${field}-${i}`);
        const mods = (target.beltRules?.mods ?? []).flatMap((mod) =>
          get(`mod-${mod.id}`)
            ? [
                {
                  id: mod.id,
                  value: Number(get(`mod-${mod.id}`)),
                  ...(get(`tier-${mod.id}`)
                    ? { tier: Number(get(`tier-${mod.id}`)) }
                    : {}),
                },
              ]
            : [],
        );
        const res = ['fire', 'cold', 'lightning'].map(get);
        const item = {
          league: target.league,
          patch: target.patch,
          currency,
          ...(get('base') ? { baseType: get('base') } : {}),
          ...(get('seller') ? { seller: get('seller') } : {}),
          status: get('status') || 'unknown',
          ...(get('rarity') ? { rarity: get('rarity') } : {}),
          ...(get('ilevel') ? { itemLevel: Number(get('ilevel')) } : {}),
          ...(get('quality') ? { quality: Number(get('quality')) } : {}),
          ...(get('corrupted')
            ? { corrupted: get('corrupted') === 'yes' }
            : {}),
          ...(get('influences') !== '' && get('influences') !== 'unknown'
            ? {
                influences:
                  get('influences') === 'none'
                    ? []
                    : get('influences')
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean),
              }
            : {}),
          mods,
          ...(res.every((value) => value !== '')
            ? {
                elementalResistances: {
                  fire: Number(res[0]),
                  cold: Number(res[1]),
                  lightning: Number(res[2]),
                },
              }
            : {}),
          ...(get('raw') ? { rawText: get('raw') } : {}),
          ...(get('listingURL') ? { listingUrl: get('listingURL') } : {}),
        };
        const rawListing = get('rawListing');
        const fee = get('fee');
        const listedAt = get('listedAt');
        let rawEnvelope: Record<string, unknown> | undefined;
        if (rawListing) {
          const parsed = JSON.parse(rawListing);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error(
              'Исходные данные объявления должны быть JSON-объектом',
            );
          rawEnvelope = parsed as Record<string, unknown>;
        }
        return {
          ...(get('id') ? { externalId: get('id') } : {}),
          price: get('price') ? Number(get('price')) : null,
          ...(get('listingCurrency')
            ? { currency: get('listingCurrency') }
            : {}),
          ...(fee ? { fee: Number(fee) } : {}),
          ...(listedAt ? { listedAt: new Date(listedAt).toISOString() } : {}),
          ...(rawEnvelope ? { rawListing: rawEnvelope } : {}),
          item,
        };
      });
      const input = marketSnapshotImportSchema.parse({
        targetId: target.id,
        capturedAt: new Date(v('time')).toISOString(),
        sourceUrl: v('url'),
        currency,
        dataKind,
        listings,
      });
      await marketClient.importSnapshot(input);
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <form className="market-form" onSubmit={(event) => void submit(event)}>
      <p>
        Введите объявления вручную из разрешённого источника. Пустые свойства
        останутся неизвестными; сумма сопротивлений считается только при наличии
        всех трёх значений. Исходный JSON сохраняется отдельно; заполните
        структурированные свойства ниже для сопоставления. Неизвестные моды не
        распознаются автоматически.
      </p>
      <label>
        Источник
        <input required type="url" name="url" />
      </label>
      <label>
        Время наблюдения
        <input required type="datetime-local" name="time" />
      </label>
      <label>
        Валюта
        <select name="currency">
          <option value="chaos">chaos</option>
          <option value="divine">divine</option>
        </select>
      </label>
      <label>
        Тип данных
        <select name="kind">
          <option value="observed">Реальные</option>
          <option value="demo">DEMO</option>
        </select>
      </label>
      <label>
        <input required type="checkbox" /> Подтверждаю, что объявления относятся
        к {target.league} и патчу {target.patch}
      </label>
      {Array.from({ length: count }, (_, i) => (
        <fieldset key={i}>
          <legend>Объявление {i + 1}</legend>
          <label>
            Идентификатор
            <input name={`id-${i}`} />
          </label>
          <label>
            Продавец
            <input name={`seller-${i}`} />
          </label>
          <label>
            Ссылка на объявление
            <input type="url" name={`listingURL-${i}`} />
          </label>
          <label>
            Цена предложения
            <input
              type="number"
              min="0.00000001"
              step="any"
              name={`price-${i}`}
            />
          </label>
          <label>
            Валюта предложения
            <input name={`listingCurrency-${i}`} />
          </label>
          <label>
            Комиссия объявления
            <input type="number" step="any" name={`fee-${i}`} />
          </label>
          <label>
            Время объявления
            <input type="datetime-local" name={`listedAt-${i}`} />
          </label>
          <label>
            Исходные данные объявления JSON
            <textarea name={`rawListing-${i}`} rows={3} />
          </label>
          <label>
            База
            <input name={`base-${i}`} />
          </label>
          <label>
            Редкость
            <select name={`rarity-${i}`} defaultValue="">
              <option value="">Неизвестно</option>
              <option value="rare">Rare</option>
              <option value="unique">Unique</option>
            </select>
          </label>
          <label>
            Item level
            <input type="number" min="1" max="100" name={`ilevel-${i}`} />
          </label>
          <label>
            Качество, %
            <input type="number" min="0" max="100" name={`quality-${i}`} />
          </label>
          <label>
            Осквернение
            <select name={`corrupted-${i}`} defaultValue="">
              <option value="">Неизвестно</option>
              <option value="no">Нет</option>
              <option value="yes">Да</option>
            </select>
          </label>
          <label>
            Влияния (введите none для отсутствия)
            <input name={`influences-${i}`} defaultValue="unknown" />
          </label>
          <label>
            Статус
            <select name={`status-${i}`}>
              <option value="unknown">Неизвестно</option>
              <option value="listed">В продаже</option>
              <option value="delisted">Снято</option>
            </select>
          </label>
          {target.beltRules?.mods.map((mod) => (
            <div className="market-form-grid" key={mod.id}>
              <label>
                {mod.id}
                <input type="number" step="any" name={`mod-${mod.id}-${i}`} />
              </label>
              <label>
                Tier {mod.id}
                <input type="number" min="1" name={`tier-${mod.id}-${i}`} />
              </label>
            </div>
          ))}
          {target.beltRules &&
            target.beltRules.version !== 1 &&
            target.beltRules.totalElementalResistanceMin != null && (
              <div className="market-form-grid">
                {['fire', 'cold', 'lightning'].map((element) => (
                  <label key={element}>
                    {element} сопротивление
                    <input type="number" step="any" name={`${element}-${i}`} />
                  </label>
                ))}
              </div>
            )}
          <label>
            Исходный текст предмета (необязательно)
            <textarea name={`raw-${i}`} />
          </label>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() => setCount((value) => Math.min(100, value + 1))}
      >
        Добавить объявление
      </button>
      {error && <p role="alert">{error}</p>}
      <button type="submit">Сохранить объявления</button>
    </form>
  );
}
