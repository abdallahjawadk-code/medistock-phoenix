import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
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
import '@/shared/lib/rac3-command-center.css';
import '@/shared/lib/central-needs.css';
import '@/shared/lib/phase-a-inventory-transfers.css';
import '@/shared/lib/phase-a-institutions-outlets.css';
import '@/shared/lib/phase-a-alerts-admin-qr.css';
import '@/shared/lib/pharma-molecular.css';
import '@/shared/lib/phase-a-visual-convergence.css';
import '@/shared/lib/phase-a-auth-welcome-signature.css';
// This entry is outside the production import graph and refuses a production build.
if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_VISUAL_QA === 'true') {
  document.documentElement.dataset.phoenixUiPhase='a';
  document.documentElement.dataset.phoenixVisual='daylight';
  document.documentElement.dataset.pharmaDesign='molecular';
  const Review=lazy(()=>import('./PharmaReview'));
  createRoot(document.getElementById('root')!).render(<Suspense fallback={null}><Review/></Suspense>);
} else {
  document.body.textContent='Development-only visual review is disabled.';
}
