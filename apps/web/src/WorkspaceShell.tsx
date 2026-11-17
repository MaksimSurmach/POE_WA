import { useCallback, useEffect, useState } from 'react';
import type { CatalogEntry, CatalogResponse } from '@poe-worksmith/contracts';
import { createApiClient } from './apiClient.js';
import { CubeIcon } from '@heroicons/react/24/outline';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { workspaceHref } from './workspaceNavigation.js';
import { useFavorites } from './Watchlist.js';
import { favoriteTargetIds } from './recipeLibraryModel.js';
import './workspaceShell.css';

function readDensity() {
  try {
    return localStorage.getItem('worksmith:density') === 'compact'
      ? 'compact'
      : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function WorkspaceShell() {
  const { pathname, search } = useLocation();
  const href = (path: string) => workspaceHref(path, pathname, search);
  const [params, setParams] = useSearchParams();
  const libraryRoute =
    pathname === '/recipes' &&
    (params.has('target') ||
      !['recipe', 'steps', 'methods', 'materials'].includes(
        params.get('view') ?? '',
      ));
  const overviewRoute =
    pathname === '/' && !['item', 'budget'].includes(params.get('view') ?? '');
  const catalogRoute = libraryRoute || overviewRoute;
  const [league, setLeague] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [catalogLeague, setCatalogLeague] = useState<
    { id: string; name: string } | null | undefined
  >(undefined);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const favorites = useFavorites();
  const acceptCatalog = useCallback(
    (data: NonNullable<CatalogResponse['data']>) => {
      setEntries(data.entries);
      setCatalogLeague(data.league);
    },
    [],
  );
  const [density, setDensity] = useState(readDensity);
  useEffect(() => {
    const update = () => setDensity(readDensity());
    window.addEventListener('storage', update);
    window.addEventListener('worksmith-density-change', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('worksmith-density-change', update);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const api = createApiClient();
    void api
      .getCurrentLeague(controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setLeague(r.data);
      })
      .catch(() => {});
    if (!catalogRoute)
      void api
        .getCatalog(controller.signal)
        .then((r) => {
          if (!controller.signal.aborted) {
            if (r.data) acceptCatalog(r.data);
          }
        })
        .catch(() => {});
    return () => controller.abort();
  }, [pathname, catalogRoute, acceptCatalog]);
  const favoritesOnly = params.get('favorites') === '1';
  const savedCount = favoriteTargetIds(favorites.ids, entries).length;
  function favoriteView() {
    const next = new URLSearchParams(params);
    if (favoritesOnly) next.delete('favorites');
    else next.set('favorites', '1');
    setParams(next, { replace: true });
  }
  return (
    <div className={`workspace-shell product-shell density-${density}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="workspace-header">
        <Link
          className="workspace-brand"
          to={href('/')}
          aria-label="Worksmith — Home"
        >
          <CubeIcon aria-hidden="true" />
          <span>Worksmith</span>
        </Link>
        <nav aria-label="Main navigation" className="workspace-nav">
          <NavLink
            to={href('/')}
            end
            className={({ isActive }) =>
              `workspace-link${isActive ? ' is-active' : ''}`
            }
          >
            Home
          </NavLink>
          <NavLink
            to={href('/recipes')}
            className={({ isActive }) =>
              `workspace-link${isActive ? ' is-active' : ''}`
            }
          >
            Recipes
          </NavLink>
        </nav>
        <span className="workspace-context">
          {(catalogLeague === undefined || catalogLeague?.id === league?.id
            ? league?.name
            : catalogLeague?.name) ?? 'League unavailable'}{' '}
          · PC ·{' '}
          {(params.get('currency') ?? params.get('profitCurrency')) === 'divine'
            ? 'divine'
            : 'chaos'}
        </span>
        <div className="product-utilities">
          {catalogRoute ? (
            <button aria-pressed={favoritesOnly} onClick={favoriteView}>
              Favorites{' '}
              <span aria-label={`${savedCount} saved targets`}>
                {savedCount}
              </span>
            </button>
          ) : (
            <Link to={href('/recipes?favorites=1')}>
              Favorites <span>{savedCount}</span>
            </Link>
          )}
          <Link to={href('/settings')}>Settings</Link>
        </div>
      </header>
      <main className="app-main" id="main-content" tabIndex={-1}>
        <Outlet context={acceptCatalog} />
      </main>
    </div>
  );
}
