import { useEffect, useState } from 'react';
import {
  marketEconomyCollectResponseSchema,
  marketEconomyDetailResponseSchema,
  marketEconomyLeaguesResponseSchema,
  marketEconomyOverviewResponseSchema,
  type MarketEconomyCategory,
  type MarketEconomyDetail,
  type MarketEconomyOverviewResponse,
} from '@poe-worksmith/contracts';
import { displayDate } from './marketWorkbench.js';

async function economyRequest(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : null;
    throw new Error(
      error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
        ? error.message
        : `Не удалось получить данные (${response.status}).`,
    );
  }
  return payload;
}

export function EconomyPanel({ demo }: { demo: boolean }) {
  const [overview, setOverview] = useState<
    MarketEconomyOverviewResponse['data'] | null
  >(null);
  const [leagues, setLeagues] = useState<{ id: string; name: string }[]>([]);
  const [league, setLeague] = useState('');
  const [category, setCategory] = useState<MarketEconomyCategory>('BaseType');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketEconomyDetail | null>(null);
  async function load() {
    const response = marketEconomyOverviewResponseSchema.parse(
      await economyRequest('/api/market/economy'),
    );
    setOverview(response.data);
  }
  useEffect(() => {
    if (!demo)
      void load().catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : 'Коллектор недоступен.',
        ),
      );
  }, [demo]);

  async function perform(action: string) {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      if (action === 'leagues') {
        const result = marketEconomyLeaguesResponseSchema.parse(
          await economyRequest('/api/market/economy/leagues'),
        ).data;
        setLeagues(result.leagues);
        setLeague(result.leagues[0]?.id ?? '');
        setMessage(`Список лиг проверен: ${displayDate(result.checkedAt)}.`);
      } else if (action === 'collect') {
        const result = marketEconomyCollectResponseSchema.parse(
          await economyRequest('/api/market/economy/collect', {
            league,
            category,
          }),
        ).data;
        setDetail(result.snapshot);
        await load();
        setMessage(
          `${result.cacheStatus === 'fetched' ? 'Снимок сохранён.' : 'Использован сохранённый снимок: новые цены не получены.'} Следующая проверка не ранее ${displayDate(result.nextRefreshAt)}.`,
        );
      } else {
        setDetail(
          marketEconomyDetailResponseSchema.parse(
            await economyRequest(
              `/api/market/economy/${encodeURIComponent(action)}`,
            ),
          ).data,
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Не удалось получить данные.',
      );
    } finally {
      setPending(false);
    }
  }
  if (demo)
    return (
      <section className="market-economy-panel">
        <h3>Сбор публичной экономики</h3>
        <p>
          В демонстрации внешние источники не вызываются. В рабочем режиме здесь
          можно выбрать лигу и сохранить цены баз, валют или расходников.
        </p>
      </section>
    );
  const ready =
    overview?.configured === true && overview.storage === 'postgres';
  return (
    <section className="market-economy-panel" aria-labelledby="economy-heading">
      <h3 id="economy-heading">Сбор публичной экономики</h3>
      <p>
        Снимки poe.ninja хранятся отдельно от объявлений редких предметов.
        Оценка BaseType — стоимость базы, а не готового крафта.
      </p>
      {overview && !overview.configured && (
        <p className="market-notice">
          Коннектор ещё не настроен на сервере. Настройка описана в README
          проекта.
        </p>
      )}
      {overview?.storage === 'unavailable' && (
        <p className="market-notice">
          Сбор приостановлен до подключения хранилища.
        </p>
      )}
      <div className="market-economy-controls">
        <button
          type="button"
          className="market-button"
          disabled={!ready || pending}
          onClick={() => void perform('leagues')}
        >
          Получить список лиг
        </button>
        <label>
          Лига
          <select
            value={league}
            disabled={!leagues.length || pending}
            onChange={(event) => setLeague(event.target.value)}
          >
            <option value="">Выберите лигу</option>
            {leagues.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Категория
          <select
            value={category}
            disabled={pending}
            onChange={(event) =>
              setCategory(event.target.value as MarketEconomyCategory)
            }
          >
            <option value="BaseType">Базы предметов</option>
            <option value="Currency">Валюты</option>
            <option value="Essence">Эссенции</option>
            <option value="Fossil">Фоссилии</option>
            <option value="Resonator">Резонаторы</option>
          </select>
        </label>
        <button
          type="button"
          className="market-button market-button--primary"
          disabled={!ready || !league || pending}
          onClick={() => void perform('collect')}
        >
          {pending ? 'Обрабатываем…' : 'Собрать снимок'}
        </button>
      </div>
      {error && (
        <p className="market-notice market-notice--warning" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="market-notice" role="status">
          {message}
        </p>
      )}
      {overview && overview.snapshots.length > 0 && (
        <div className="market-economy-history">
          <h4>Последние сохранённые снимки</h4>
          {overview.snapshots.map((snapshot) => (
            <button
              type="button"
              key={snapshot.id}
              disabled={pending}
              onClick={() => void perform(snapshot.id)}
            >
              <span>
                {snapshot.league} · {snapshot.category}
              </span>
              <span>
                {snapshot.lineCount} строк · {displayDate(snapshot.capturedAt)}
              </span>
            </button>
          ))}
          <p className="market-footnote">
            Показано до {overview.limit} последних снимков. Повторное чтение
            кеша не создаёт новую точку истории.
          </p>
        </div>
      )}
      {detail && (
        <div className="market-economy-detail">
          <h4>
            {detail.league} · {detail.category}
          </h4>
          <p className="market-footnote">
            {detail.priceBasis === 'stash-estimate'
              ? 'Оценки по публичным предложениям.'
              : 'Данные валютного обмена.'}{' '}
            Получено {displayDate(detail.capturedAt)}. Время обновления у
            источника не предоставлено.
          </p>
          <div className="market-table-scroll">
            <table className="market-snapshot-table">
              <thead>
                <tr>
                  <th>Предмет</th>
                  <th>Оценка</th>
                  <th>Наблюдения / лоты</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.name ?? line.id}</td>
                    <td>
                      {line.price.amount === null
                        ? '—'
                        : new Intl.NumberFormat('ru-RU', {
                            maximumFractionDigits: 3,
                          }).format(line.price.amount)}{' '}
                      {line.price.currency}
                    </td>
                    <td>
                      {line.observationCount ?? '—'} /{' '}
                      {line.listingCount ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.truncated && (
            <p className="market-footnote">
              Первые 200 строк из {detail.lineCount}. Полный ответ сохранён в
              хранилище.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
