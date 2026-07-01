import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/shared/lib/global.css';
import { App } from '@/app/App';
import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
