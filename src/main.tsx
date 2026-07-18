import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted variable fonts (weight axis only) — bundled by Vite, served from
// our own origin so they satisfy the production CSP (font-src 'self'). No CDN.
import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/noto-sans-arabic/wght.css';
import '@/shared/lib/global.css';
import { App } from '@/app/App';
import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
