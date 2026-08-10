// MediStock-Babil Phoenix — lightweight app-shell service worker.
// PWA-INSTALL-PROMPT-A
//
// Scope: caches same-origin static app-shell assets only (HTML/JS/CSS/SVG/
// manifest), using a network-first strategy with cache fallback for offline
// support. It NEVER intercepts, caches, or serves Supabase REST/RPC/Auth/
// Storage requests, or any authenticated/medical data — those always go
// straight to the network untouched (the fetch handler returns early for
// them, so the browser handles them exactly as if this worker did not
// exist).

// APP-ICON-REFRESH-HOTFIX-A: bumped so every client discards the v1 app-shell
// cache (which pinned the retired icon assets) on activation. The activate
// handler below already deletes every cache whose key differs, and ONLY
// app-shell caches ever exist here - Supabase/API responses are never cached.
const CACHE_VERSION = 'medistock-shell-v2';

function isSupabaseOrApiRequest(url) {
  return (
    url.hostname.endsWith('.supabase.co') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('/rest/v1') ||
    url.pathname.includes('/auth/v1') ||
    url.pathname.includes('/rpc/') ||
    url.pathname.includes('/storage/v1')
  );
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only ever handle simple, safe GET requests.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept Supabase/API/RPC/Auth/Storage requests — always network,
  // never cached, never served stale or offline. This is the hard boundary
  // that keeps medical/institution/availability/alert data live-only.
  if (isSupabaseOrApiRequest(url)) return;

  // Only handle same-origin static app-shell requests.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
