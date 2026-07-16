/**
 * PWA-INSTALL-PROMPT-A
 *
 * Registers the lightweight app-shell service worker (public/sw.js). Safe by
 * design: only registers in production builds (never during local dev, so a
 * stale worker can never interfere with Vite's dev server/HMR), never throws
 * uncaught, and logs only a minimal warning on failure — no secrets, no user
 * data, no request bodies.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.warn('[pwa] service worker registration failed:', message);
    });
  });
}
