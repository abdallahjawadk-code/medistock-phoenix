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
import '@/shared/lib/phase-a-command-center.css';
import '@/shared/lib/phase-a-inventory-transfers.css';
import '@/shared/lib/phase-a-institutions-outlets.css';
import '@/shared/lib/phase-a-alerts-admin-qr.css';
import '@/shared/lib/phase-a-visual-convergence.css';
import { App } from '@/app/App';
import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker';

// PHASE-A-DESIGN-FOUNDATION: one explicit document-level marker lets the new
// presentation layer remain isolated and removable. It changes no application
// state and is intentionally set before the first React paint.
document.documentElement.dataset.phoenixUiPhase = 'a';

// PHASE-A7-VISUAL-CONVERGENCE: names the visual language explicitly (as
// opposed to the previous unnamed cinematic layer) so the daylight contract
// is greppable/testable as its own concern. Always "daylight" for Phase A —
// it does not track the light/dark theme toggle, which keeps full ownership
// of data-theme; this marker only says which STRUCTURAL design language the
// phase uses, in both themes.
document.documentElement.dataset.phoenixVisual = 'daylight';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
