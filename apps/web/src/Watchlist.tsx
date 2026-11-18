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
import { favoriteTargetIds } from './recipeLibraryModel.js';

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
export function useFavorites() {
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
  function toggle(id: string, aliases: string[] = []) {
    const current = read();
    const selected = current.some(
      (value) => value === id || aliases.includes(value),
    );
    const remaining = current.filter(
      (value) => value !== id && !aliases.includes(value),
    );
    const next = selected ? remaining : [...remaining, id];
    if (next.length > 500) {
      setError('You can save up to 500 targets.');
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setIds(next);
      setError('');
      window.dispatchEvent(new Event('worksmith:favorites'));
    } catch {
      setError('Favorites could not be saved: browser storage is unavailable.');
    }
  }
  return { ids, error, toggle };
}
export function FavoriteButton({
  recipeId,
  targetId = recipeId,
  aliases = [],
}: {
  recipeId: string;
  targetId?: string;
  aliases?: string[];
}) {
  const { ids, error, toggle } = useFavorites();
  const legacyIds = [...aliases, recipeId];
  const selected = ids.some((id) => id === targetId || legacyIds.includes(id));
  return (
    <span className="favorite-control">
      <Button
        type="button"
        aria-pressed={selected}
        onClick={() => toggle(targetId, legacyIds)}
      >
        <StarIcon aria-hidden="true" />
        {selected ? 'Remove favorite' : 'Add favorite'}
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
      <h1>Favorites</h1>
      <p className="catalog-price-note">
        Saved in this browser. Evidence belongs to the current catalogue and its
        league. Asking prices are not confirmed sales.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {failed ? (
        <StatusPanel tone="danger" title="Favorites could not be refreshed">
          <Button onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        </StatusPanel>
      ) : entries === null ? (
        <StatusPanel tone="info" title="Loading favorites" />
      ) : !ids.length ? (
        <StatusPanel tone="info" title="No saved targets">
          Open an item and choose Add favorite. <Link to="/">Browse items</Link>
        </StatusPanel>
      ) : (
        <div
          className="data-scroll"
          role="region"
          aria-label="Favorite targets"
          tabIndex={0}
        >
          <TableSurface>
            <table className="table__content">
              <thead>
                <tr>
                  {[
                    'Target',
                    'Cost',
                    'Observed ask',
                    'Data status',
                    'Actions',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {favoriteTargetIds(ids, entries).map((id) => {
                  const entry = entries.find(
                    ({ recipe }) =>
                      recipe.targetSignature === id || recipe.id === id,
                  );
                  return (
                    <tr key={id}>
                      <th scope="row">
                        <Link
                          to={`/?recipe=${encodeURIComponent(entry?.recipe.id ?? id)}&view=item`}
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
                          ? `${entry.evaluation.status} · ${entry.evaluation.evaluatedAt ? formatTimestamp(entry.evaluation.evaluatedAt) : 'No timestamp'}`
                          : 'Target absent from the current catalogue'}
                      </td>
                      <td>
                        <Button
                          onClick={() =>
                            toggle(
                              id,
                              entries
                                .filter((e) => e.recipe.targetSignature === id)
                                .map((e) => e.recipe.id),
                            )
                          }
                        >
                          Remove
                        </Button>
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
