import {
  ArchiveBoxIcon,
  Bars3Icon,
  BookOpenIcon,
  ChartBarIcon,
  CubeIcon,
  Cog6ToothIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { Disclosure } from '@heroui/react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';

const destinations = [
  { to: '/', title: 'Craft Opportunities', icon: Squares2X2Icon },
  { to: '/recipes', title: 'Recipes', icon: BookOpenIcon },
  { to: '/market', title: 'Market trends', icon: ChartBarIcon },
  { to: '/factory', title: 'My Factory', icon: ArchiveBoxIcon },
  { to: '/settings', title: 'Settings', icon: Cog6ToothIcon },
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="workspace-nav">
      {destinations.map(({ to, title, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `workspace-link${isActive ? ' is-active' : ''}`
          }
          {...(onNavigate ? { onClick: onNavigate } : {})}
        >
          <Icon aria-hidden="true" />
          <span>{title}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function WorkspaceShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="workspace-sidebar">
        <Link
          className="workspace-brand"
          to="/"
          aria-label="Worksmith Handbook home"
        >
          <CubeIcon aria-hidden="true" />
          <span>
            Worksmith<small>Crafting workspace</small>
          </span>
        </Link>
        <Navigation />
        <div className="workspace-context">
          Path of Exile 1<small>PC · Private workspace</small>
        </div>
      </aside>
      <div className="workspace-content">
        <Disclosure
          className="workspace-mobile-nav"
          isExpanded={menuOpen}
          onExpandedChange={setMenuOpen}
        >
          <Disclosure.Heading>
            <Disclosure.Trigger>
              <Bars3Icon aria-hidden="true" />
              Worksmith menu
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body>
              <Navigation onNavigate={() => setMenuOpen(false)} />
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
        <main className="app-main" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
