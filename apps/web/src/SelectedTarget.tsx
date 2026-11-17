import { useSearchParams } from 'react-router-dom';
import { RecipePage } from './RecipePage.js';
import { RecipeLibraryPage } from './RecipeLibraryPage.js';
import { StatusPanel } from './components.js';

export function SelectedTarget() {
  const [params] = useSearchParams();
  const recipe = params.get('recipe');
  if (recipe) return <RecipePage key={recipe} selectedRecipeId={recipe} />;
  return (
    <>
      <StatusPanel tone="info" title="Выберите целевой предмет">
        Откройте реальный рецепт из каталога. Выбранная цель сохранится при
        переходах между разделами.
      </StatusPanel>
      <RecipeLibraryPage />
    </>
  );
}
