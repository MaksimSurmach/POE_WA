import { useContext, useState } from 'react';
import { PreviewMode } from './previewMode.js';

export function StepCheck({
  recipeId,
  stepId,
  stepName,
}: {
  recipeId: string;
  stepId: string;
  stepName: string;
}) {
  const preview = useContext(PreviewMode);
  const key = `${preview ? 'preview:' : ''}worksmith:step:${recipeId}:${stepId}`;
  const [checked, setChecked] = useState(() => {
    try {
      return sessionStorage.getItem(key) === 'done';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState(false);
  return (
    <label className="step-check">
      <input
        type="checkbox"
        aria-label={`Выполнен шаг: ${stepName}`}
        checked={checked}
        onChange={(event) => {
          setChecked(event.target.checked);
          try {
            sessionStorage.setItem(key, event.target.checked ? 'done' : '');
            setError(false);
          } catch {
            setError(true);
          }
        }}
      />
      Выполнено
      {error ? ' · Сохранение недоступно' : ' · Только в этой вкладке браузера'}
    </label>
  );
}
