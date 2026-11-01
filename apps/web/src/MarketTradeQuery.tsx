import { useEffect, useState } from 'react';
import type { MarketTarget } from '@poe-worksmith/contracts';
import { marketClient } from './marketClient.js';

export function MarketTradeQuery({ target }: { target: MarketTarget }) {
  const [scope, setScope] = useState<'strict' | 'broad'>(
    target.tradeSearch?.scope ?? 'strict',
  );
  const [query, setQuery] = useState<Awaited<
    ReturnType<typeof marketClient.tradeQuery>
  > | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setQuery(null);
    setError('');
    if (target.tradeSearch)
      void marketClient
        .tradeQuery(target.id, scope)
        .then((result) => {
          if (active) setQuery(result);
        })
        .catch((cause) => {
          if (active)
            setError(cause instanceof Error ? cause.message : 'Ошибка запроса');
        });
    return () => {
      active = false;
    };
  }, [target.id, target.tradeSearch, scope]);
  if (!target.tradeSearch)
    return (
      <p>
        Структурированные Trade-модификаторы не заданы; текстовые требования не
        превращаются в stat ID автоматически.
      </p>
    );
  return (
    <section>
      <h3>Точный Trade-запрос</h3>
      <label>
        Сравнение{' '}
        <select
          value={scope}
          onChange={(event) =>
            setScope(event.target.value === 'broad' ? 'broad' : 'strict')
          }
        >
          <option value="strict">Строгое</option>
          <option value="broad">Шире: пороги ±20%</option>
        </select>
      </label>
      <p>
        Сбор использует сохранённый scope: {target.tradeSearch.scope}. При
        широком поиске matcher проверяет исходные строгие требования.
      </p>
      {error && <p role="alert">{error}</p>}
      {query && (
        <>
          <a href={query.url} target="_blank" rel="noreferrer">
            Открыть этот запрос в Trade ↗
          </a>
          <details>
            <summary>
              JSON · {query.version} · {query.hash.slice(0, 12)}
            </summary>
            <pre className="market-json">
              {JSON.stringify(query.request, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
