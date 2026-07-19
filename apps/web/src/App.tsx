import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useParams,
} from 'react-router-dom';

import { catalogFixtures } from './mocks/catalog.js';
import {
  FreshnessIndicator,
  ListingAge,
  Money,
  ProfitBadge,
  StatusPanel,
  Tag,
} from './components.js';

function AppShell() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="brand" to="/" aria-label="POE Worksmith home">
            <span>POE</span> Worksmith
          </Link>
          <nav aria-label="Primary navigation">
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
              to="/"
              end
            >
              Catalog
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </>
  );
}

function CatalogRoute() {
  const profitable = catalogFixtures[0];

  if (!profitable) {
    return <StatusPanel tone="danger" title="Catalog data is unavailable" />;
  }

  const { recipe, evaluation, snapshot } = profitable;

  return (
    <>
      <section className="page-intro" aria-labelledby="catalog-heading">
        <div>
          <h1 id="catalog-heading">Craft catalog</h1>
          <p>Compare expected cost, sale price, and market freshness.</p>
        </div>
        <StatusPanel tone="info" title="Market refresh in progress">
          3 of 6 recipes updated
        </StatusPanel>
      </section>

      <section
        className="recipe-preview"
        aria-label="Recipe presentation example"
      >
        <div className="recipe-preview__identity">
          <h2>{recipe.title}</h2>
          <div className="tag-list" aria-label="Recipe tags">
            {recipe.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        </div>
        <Metric label="Cost">
          <Money price={evaluation.expectedCraftCost} />
        </Metric>
        <Metric label="Sale">
          <Money price={evaluation.estimatedSalePrice} />
        </Metric>
        <Metric label="Profit">
          {evaluation.profit ? (
            <ProfitBadge
              amount={evaluation.profit.amount}
              currency={evaluation.profit.currency}
            />
          ) : (
            '—'
          )}
        </Metric>
        <Metric label="Freshness">
          <FreshnessIndicator ageSeconds={120} />
        </Metric>
        <Metric label="Status">
          <span className="ready-status">Ready</span>
        </Metric>
        <Link className="recipe-link" to={`/recipes/${recipe.id}`}>
          View recipe
        </Link>
        <div className="listing-example">
          Listing age:{' '}
          <ListingAge seconds={snapshot?.listings[0]?.ageSeconds ?? 0} />
        </div>
      </section>

      <StatusPanel tone="warning" title="Provider data is stale">
        Some prices may be outdated. Consider refreshing soon.
      </StatusPanel>
    </>
  );
}

function Metric({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value">{children}</span>
    </div>
  );
}

function RecipeRoute() {
  const { recipeId } = useParams();
  const entry = catalogFixtures.find(({ recipe }) => recipe.id === recipeId);

  if (!entry) {
    return (
      <>
        <Link className="back-link" to="/">
          Back to catalog
        </Link>
        <StatusPanel tone="danger" title="Recipe not found" />
      </>
    );
  }

  return (
    <section className="recipe-route" aria-labelledby="recipe-heading">
      <Link className="back-link" to="/">
        Back to catalog
      </Link>
      <h1 id="recipe-heading">{entry.recipe.title}</h1>
      <p>{entry.recipe.summary}</p>
      <StatusPanel tone="success" title="Recipe route is ready">
        Market and crafting details will appear here.
      </StatusPanel>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CatalogRoute />} />
        <Route path="recipes/:recipeId" element={<RecipeRoute />} />
      </Route>
    </Routes>
  );
}
