/* ─── PHOENIX WEBGL — welcome warm-up ──────────────────────────────────────────
   Kicks off the (code-split) three.js welcome chunk WITHOUT statically importing
   it, so it never lands in the eager bundle. Call this when a login submit
   succeeds / the Auth request is in flight — the rebirth scene then arrives in
   parallel with authentication instead of blocking the transition afterwards.
   Idempotent: the browser dedupes the dynamic import, and the guard avoids
   re-triggering work on repeated calls.
   ─────────────────────────────────────────────────────────────────────────── */
let started = false;

export function preloadPhoenixWelcome(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  // Fire-and-forget: a failed prefetch simply means the stage lazy-loads later.
  void import('./PhoenixWelcomeCanvas').catch(() => {
    started = false;
  });
}
