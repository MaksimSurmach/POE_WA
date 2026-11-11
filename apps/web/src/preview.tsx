import './theme.css';
import './workspace.css';
import { createRoot } from 'react-dom/client';
import { createPreviewFetch } from './preview/previewApi.js';

globalThis.fetch = createPreviewFetch();
// API clients capture fetch on import, after the offline implementation is installed.
const { PreviewApp } = await import('./preview/PreviewApp.js');
const root = document.querySelector('#root');
if (!root) throw new Error('Missing preview root');
createRoot(root).render(<PreviewApp />);
