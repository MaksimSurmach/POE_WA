import { Link, useLocation } from 'react-router-dom';

import { workspaceHref } from './workspaceNavigation.js';

const sections = [
  { label: 'Collection', to: '/settings', data: false },
  { label: 'Data and sources', to: '/settings?view=data', data: true },
  { label: 'Scraped items', to: '/settings/scraped-items', data: false },
] as const;

/** Moves between Settings pages; the current page is announced, not just colored. */
export function SettingsNav() {
  const { pathname, search } = useLocation();
  const dataView = new URLSearchParams(search).get('view') === 'data';
  return (
    <nav aria-label="Settings sections" className="settings-nav">
      {sections.map(({ label, to, data }) => {
        const current =
          to === '/settings/scraped-items'
            ? pathname === to
            : pathname === '/settings' && dataView === data;
        return (
          <Link
            key={to}
            to={workspaceHref(to, pathname, search)}
            aria-current={current ? 'page' : undefined}
            className={`settings-nav__link${current ? ' is-active' : ''}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
