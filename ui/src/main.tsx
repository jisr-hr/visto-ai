import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApi } from './api.ts';
import { App } from './app.tsx';
import './index.css';
import { applyTheme, currentTheme, followSystem } from './theme.ts';

// Before the first render (call 18). Until here the CSS has followed the system, so the first paint is never in the other theme.
applyTheme(currentTheme());
followSystem();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={createApi()} />
    </StrictMode>,
  );
}
