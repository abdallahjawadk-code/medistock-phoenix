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
// RAC-3 sits with its Phase-A sibling rather than last: the A7.1/A7.2 layers
// must remain the final CSS imports. Every selector here is `.rac3-`
// prefixed and unique to the Command Center, so no later layer collides.
import '@/shared/lib/rac3-command-center.css';
import '@/shared/lib/phase-a-inventory-transfers.css';
import '@/shared/lib/phase-a-institutions-outlets.css';
import '@/shared/lib/phase-a-alerts-admin-qr.css';
import '@/shared/lib/phase-a-visual-convergence.css';
import '@/shared/lib/phase-a-auth-welcome-signature.css';
import { App } from '@/app/App';
import { restoreThemeBeforeReact } from '@/shared/lib/themePreference';
import { restoreLanguageBeforeReact } from '@/shared/lib/languagePreference';
import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker';

// THEME-PERSISTENCE-HOTFIX: restore the validated browser-local preference
// before React mounts. `index.html` remains light as the no-preference fallback;
// this synchronous override prevents AppContext from starting a refresh on the
// wrong visual theme while the preference bridge aligns its in-memory state.
restoreThemeBeforeReact();

// INTERACTIVE-GUIDE-IG1: same contract, one line later, for the application
// language. index.html ships dir="rtl"/lang="ar" as the no-preference
// fallback; this synchronous restore prevents an English operator's refresh
// from painting one Arabic RTL frame before LanguagePreferenceBridge aligns
// AppContext's in-memory state.
restoreLanguageBeforeReact();

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
