import { useContext, useEffect, useState } from 'react';
import type { CatalogEntry } from '@poe-worksmith/contracts';
import { StarIcon } from '@heroicons/react/24/outline';
import { Button, TableSurface } from './ui.js';
import { createApiClient } from './apiClient.js';
import { Money, StatusPanel } from './components.js';
import { observedAsk } from './catalog.js';
import { WorkspaceLink as Link } from './workspaceNavigation.js';
import { PreviewMode } from './previewMode.js';
import { formatTimestamp } from './dateTime.js';

export function readFavorites(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (id): id is string =>
                typeof id === 'string' && id.length > 0 && id.length < 300,
            ),
          ),
        ].slice(0, 500)
      : [];
  } catch {
    return [];
  }
}
function useFavorites() {
  const preview = useContext(PreviewMode);
  const key = `${preview ? 'preview:' : ''}worksmith:favorites`;
  const read = () => {
    try {
      return readFavorites(localStorage.getItem(key));
    } catch {
      return [];
    }
  };
  const [ids, setIds] = useState(read);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setIds(read());
    window.addEventListener('storage', update);
    window.addEventListener('worksmith:favorites', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('worksmith:favorites', update);
    };
  }, [key]);
  function toggle(id: string) {
    const current = read();
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id];
    if (next.length > 500) {
      setError('В избранном может быть не более 500 целей.');
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setIds(next);
      setError('');
      window.dispatchEvent(new Event('worksmith:favorites'));
    } catch {
      setError(
        'Не удалось сохранить избранное: хранилище браузера недоступно.',
      );
    }
  }
  return { ids, error, toggle };
}
export function FavoriteButton({ recipeId }: { recipeId: string }) {
  const { ids, error, toggle } = useFavorites();
  const selected = ids.includes(recipeId);
  return (
    <span className="favorite-control">
      <Button
        type="button"
        aria-pressed={selected}
        onClick={() => toggle(recipeId)}
      >
        <StarIcon aria-hidden="true" />
        {selected ? 'Убрать из избранного' : 'В избранное'}
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
const api = createApiClient();
export function Watchlist() {
  const { ids, error, toggle } = useFavorites();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void api
      .getCatalog()
      .then((response) => {
        if (active) {
          if (response.data) setEntries(response.data.entries);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <section>
      <h1>Избранное</h1>
      <p className="catalog-price-note">
        Сохранено только в этом браузере. Показатели относятся к текущему
        каталогу и его лиге. Цена объявления не подтверждает продажу.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {failed ? (
        <StatusPanel tone="danger" title="Избранное не удалось обновить">
          <Button onClick={() => setRevision((value) => value + 1)}>
            Повторить
          </Button>
        </StatusPanel>
      ) : entries === null ? (
        <StatusPanel tone="info" title="Загрузка избранного" />
      ) : !ids.length ? (
        <StatusPanel tone="info" title="Пока нет избранных целей">
          Откройте предмет и нажмите «В избранное».{' '}
          <Link to="/">К скринеру</Link>
        </StatusPanel>
      ) : (
        <div
          className="data-scroll"
          role="region"
          aria-label="Избранные цели"
          tabIndex={0}
        >
          <TableSurface>
            <table className="table__content">
              <thead>
                <tr>
                  {[
                    'Цель',
                    'Затраты',
                    'Цена объявления',
                    'Состояние данных',
                    'Действия',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ids.map((id) => {
                  const entry = entries.find(({ recipe }) => recipe.id === id);
                  return (
                    <tr key={id}>
                      <th scope="row">
                        <Link
                          to={`/recipes/${encodeURIComponent(id)}?view=item`}
                        >
                          {entry?.recipe.title ?? id}
                        </Link>
                        {entry ? (
                          <small>{entry.recipe.craftMethod}</small>
                        ) : null}
                      </th>
                      <td>
                        <Money
                          price={entry?.evaluation.expectedCraftCost ?? null}
                        />
                      </td>
                      <td>
                        <Money price={entry ? observedAsk(entry) : null} />
                      </td>
                      <td>
                        {entry
                          ? `${entry.evaluation.status} · ${entry.evaluation.evaluatedAt ? formatTimestamp(entry.evaluation.evaluatedAt) : 'Нет даты'}`
                          : 'Цель отсутствует в текущем каталоге'}
                      </td>
                      <td>
                        <Button onClick={() => toggle(id)}>Удалить</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableSurface>
        </div>
      )}
    </section>
  );
}
