import { useEffect, useState } from 'react';
import { createApiClient } from './apiClient.js';
import { CubeIcon } from '@heroicons/react/24/outline';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  selectedRecipe,
  WorkspaceLink,
  workspaceHref,
  workspaceSections,
} from './workspaceNavigation.js';

export function WorkspaceShell() {
  const { pathname, search } = useLocation();
  const [league, setLeague] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void createApiClient()
      .getCurrentLeague()
      .then((response) => {
        if (active) setLeague(response.data.name);
      })
      .catch(() => {
        if (active) setLeague(null);
      });
    return () => {
      active = false;
    };
  }, []);
  const params = new URLSearchParams(search);
  const section =
    workspaceSections.find(
      (entry) => entry.path !== '/' && pathname.startsWith(entry.path),
    ) ?? workspaceSections[0];
  const recipe = selectedRecipe(pathname, search);
  const rawView = params.get('view');
  const defaultView = pathname.startsWith('/recipes/pohx/')
    ? 'guides'
    : pathname.startsWith('/recipes/')
      ? 'recipe'
      : pathname === '/factory' && params.has('batch')
        ? 'batch'
        : section.tabs[0][0];
  const view = section.tabs.some(([id]) => id === rawView)
    ? rawView
    : defaultView;
  useEffect(() => {
    document
      .querySelector('.workspace-tabs [aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname, view]);
  function tabHref(id: string) {
    let path: string = section.path;
    if (
      section.path === '/recipes' &&
      !['catalog', 'guides'].includes(id) &&
      recipe
    )
      path += `/${encodeURIComponent(recipe)}`;
    const target = new URLSearchParams(
      section.path === '/' && id === 'screener' ? search : '',
    );
    target.set('view', id);
    return workspaceHref(`${path}?${target}`, pathname, search);
  }
  return (
    <div className="workspace-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main-content');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        К содержимому
      </a>
      <header className="workspace-header">
        <WorkspaceLink
          className="workspace-brand"
          to="/"
          aria-label="Worksmith — главная"
        >
          <CubeIcon aria-hidden="true" />
          <span>Worksmith</span>
        </WorkspaceLink>
        <nav aria-label="Основные разделы" className="workspace-nav">
          {workspaceSections.map(({ path, title }) => (
            <NavLink
              key={path}
              to={workspaceHref(path, pathname, search)}
              end={path === '/'}
              className={({ isActive }) =>
                `workspace-link${isActive ? ' is-active' : ''}`
              }
            >
              {title}
            </NavLink>
          ))}
        </nav>
        <span className="workspace-context">
          {league ?? 'Лига неизвестна'}
          {params.get('league') && params.get('league') !== league
            ? ` · Выбрана: ${params.get('league')}`
            : ''}{' '}
          <span>
            {(params.get('profitCurrency') ?? params.get('currency')) ===
            'divine'
              ? 'divine'
              : 'chaos'}{' '}
            · порог прибыли
          </span>
        </span>
      </header>
      <nav
        className="workspace-tabs"
        aria-label={`${section.title}: представления`}
      >
        {section.tabs.map(([id, label]) => (
          <WorkspaceLink
            key={id}
            to={tabHref(id)}
            aria-current={view === id ? 'page' : undefined}
          >
            {label}
          </WorkspaceLink>
        ))}
      </nav>
      <main className="app-main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
