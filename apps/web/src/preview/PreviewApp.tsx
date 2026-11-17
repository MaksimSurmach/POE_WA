import { HashRouter } from 'react-router-dom';
import { App } from '../App.js';
import { PreviewMode } from '../previewMode.js';

export function PreviewApp() {
  return (
    <PreviewMode value={true}>
      <div className="preview-notice" role="note">
        <strong>Тестовый просмотр</strong>
        <span>Тестовые данные · Без подключения к базе · Запись отключена</span>
      </div>
      <HashRouter>
        <App />
      </HashRouter>
    </PreviewMode>
  );
}
