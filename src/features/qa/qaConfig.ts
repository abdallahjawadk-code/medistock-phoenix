/**
 * VISUAL-QA-HARNESS-A — DEV/TEST-ONLY gate.
 *
 * The visual-QA harness renders real screens against deterministic local
 * fixtures so we can capture layout / theme / RTL / focus / responsive states
 * without a live session. It is NOT a functional or security surface:
 *   - never uses any elevated/admin Supabase key or admin auth API,
 *   - never writes to Supabase, calls a mutating RPC, or bypasses RLS,
 *   - never stores fixtures in any database,
 *   - never modifies the real auth flow.
 *
 * It is reachable ONLY when BOTH hold:
 *   1. `import.meta.env.DEV === true`  (stripped from every production build), and
 *   2. `VITE_ENABLE_VISUAL_QA === 'true'` (opt-in, off by default).
 *
 * A production build has `import.meta.env.DEV === false`, so `visualQaEnabled`
 * folds to a literal `false` and the whole harness tree is tree-shaken out.
 * `tests/qa-harness-production-safety.test.ts` proves the built bundle carries
 * no QA route, marker, or fixture.
 */

/** Marker string asserted-absent from production bundles by the safety test. */
export const QA_HARNESS_MARKER = 'PHOENIX_VISUAL_QA_HARNESS_ONLY';

/** URL flag that activates the harness (only honoured when {@link visualQaEnabled}). */
export const QA_QUERY_KEY = 'qa';

/** True only in a dev build with the explicit opt-in env flag set. */
export const visualQaEnabled: boolean =
  import.meta.env.DEV === true &&
  import.meta.env.VITE_ENABLE_VISUAL_QA === 'true';

/** True when the current URL requests the harness AND it is enabled. */
export function isQaHarnessRequested(): boolean {
  if (!visualQaEnabled) return false;
  try {
    return new URLSearchParams(window.location.search).has(QA_QUERY_KEY);
  } catch {
    return false;
  }
}
