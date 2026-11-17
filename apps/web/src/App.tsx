import { SelectedTarget } from './SelectedTarget.js';
import { WorkspaceShell as AppShell } from './WorkspaceShell.js';
import { Route, Routes, useSearchParams } from 'react-router-dom';

import { StatusPanel } from './components.js';
import { CollectorControls } from './CollectorControls.js';
import { HomeSettings } from './HomeSettings.js';
import { MarketHome } from './MarketHome.js';
import { RecipePage } from './RecipePage.js';
import { MarketTrendsPage } from './MarketTrendsPage.js';
import { RecipeLibraryPage } from './RecipeLibraryPage.js';
import { PohxRecipePage } from './PohxRecipePage.js';
import { FactoryPage } from './FactoryPage.js';
import { CollectorReadinessReport } from './MarketReadiness.js';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CraftRoute />} />
        <Route path="recipes" element={<RecipeCollectionRoute />} />
        <Route path="recipes/pohx/:guideId" element={<PohxRecipePage />} />
        <Route path="recipes/:recipeId" element={<RecipePage />} />
        <Route path="factory" element={<FactoryPage />} />
        <Route path="market" element={<MarketTrendsPage />} />
        <Route path="settings" element={<CollectionSettingsPage />} />
        <Route
          path="*"
          element={<StatusPanel tone="warning" title="Страница не найдена" />}
        />
      </Route>
    </Routes>
  );
}

function CollectionSettingsPage() {
  const [params] = useSearchParams();
  const data = params.get('view') === 'data';
  return (
    <>
      <header className="catalog-heading">
        <div>
          <h1>{data ? 'Данные и источники' : 'Настройки'}</h1>
          <p>Состояние коллектора и срок актуальности сохранённых цен.</p>
        </div>
      </header>
      <CollectorControls />
      {data ? <CollectorReadinessReport /> : <HomeSettings initiallyOpen />}
    </>
  );
}

function CraftRoute() {
  const [params] = useSearchParams();
  return ['item', 'budget'].includes(params.get('view') ?? '') ? (
    <SelectedTarget />
  ) : (
    <MarketHome />
  );
}
function RecipeCollectionRoute() {
  const [params] = useSearchParams();
  return !params.has('target') &&
    ['recipe', 'steps', 'methods', 'materials'].includes(
      params.get('view') ?? '',
    ) ? (
    <SelectedTarget />
  ) : (
    <RecipeLibraryPage />
  );
}
