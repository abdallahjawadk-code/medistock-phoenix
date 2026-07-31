import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted variable fonts (weight axis only) — bundled by Vite, served from
// our own origin so they satisfy the production CSP (font-src 'self'). No CDN.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-500.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-sans-arabic/latin-700.css';
import '@/shared/lib/global.css';
import '@/shared/lib/phase-a-foundation.css';
import '@/shared/lib/phase-a-auth.css';
import { App } from '@/app/App';
import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker';

// PHASE-A-DESIGN-FOUNDATION: one explicit document-level marker lets the new
// presentation layer remain isolated and removable. It changes no application
// state and is intentionally set before the first React paint.
document.documentElement.dataset.phoenixUiPhase = 'a';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
