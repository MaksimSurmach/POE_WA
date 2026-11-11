import { HashRouter } from 'react-router-dom';
import { App } from '../App.js';
import { PreviewMode } from '../previewMode.js';

export function PreviewApp() {
  return (
    <PreviewMode value={true}>
      <div className="preview-notice" role="note">
        <strong>Design preview</strong>
        <span>Sample data · No live connection · Writes disabled</span>
      </div>
      <HashRouter>
        <App />
      </HashRouter>
    </PreviewMode>
  );
}
