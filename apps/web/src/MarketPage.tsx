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

type Tab = 'targets' | 'snapshots' | 'sources';
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
  const [dialog, setDialog] = useState<'target' | 'snapshot' | null>(null);
  const [rawSnapshot, setRawSnapshot] = useState<unknown | null>(null);

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
    if (demo) {
      setRawSnapshot(snapshot);
      return;
    }
    try {
      setRawSnapshot(await marketClient.getSnapshot(snapshot.id));
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
          {observed.length === 0 ? (
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
                  {[...observed]
                    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
                    .map((snapshot) => (
                      <tr key={snapshot.id}>
                        <td>{displayDate(snapshot.capturedAt)}</td>
                        <td>
                          {targets.find(
                            (target) => target.id === snapshot.targetId,
                          )?.name ?? 'Цель'}
                          <small>
                            {snapshot.league} · {snapshot.patch}
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
                Импортированные тестовые снимки исключены из рыночных
                показателей.
              </p>
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
      {target.requiredMods.length ? (
        <ul className="market-mods">
          {target.requiredMods.map((mod, index) => (
            <li key={index}>{mod}</li>
          ))}
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
    <form className="market-form" onSubmit={(event) => void submit(event)}>
      <p>
        Импортируйте выбранные сопоставимые объявления. В одном снимке — одна
        валюта и до 1000 предложений. Цена объявления не означает состоявшуюся
        продажу.
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
        capturedAt — время наблюдения. Для настоящих данных укажите dataKind:
        observed; учебные demo не участвуют в аналитике. Для успешно
        проверенного поиска без предложений передайте listings: [] и
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
  );
}
