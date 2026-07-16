/* ─── MEDISTOCK PHOENIX — Shadow-mode mismatch diagnostics ────────────────────
   Structured, deduplicated, privacy-bounded reporting of legacy-vs-scoped
   disagreements.

   WHAT MAY BE LOGGED is an allowlist, not a redaction pass. The record type
   below has no field for a name, an email address, a token, a batch number or a
   record body, so there is no code path that can emit one — a redactor you have
   to remember to call is a redactor that eventually is not called.

   The profile ID is truncated to its first 8 characters. That is enough to
   correlate two mismatches as the same person while debugging, and is not a
   usable identifier to anyone reading a console over someone's shoulder.

   DEDUPLICATION exists because these checks run inside React render paths: a
   list of 40 warehouses re-rendering on every keystroke would otherwise emit
   40 identical lines per keystroke. Identical mismatches collapse to one line
   per window, with the suppressed count carried on the next emission.
   ──────────────────────────────────────────────────────────────────────────── */

import type { ScopedRbacMode } from './mode';

export type AuthzReasonCode =
  | 'ALLOWED'
  | 'FLAG_OFF'
  | 'NOT_AUTHENTICATED'
  | 'PROFILE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'ASSIGNMENT_MISSING'
  | 'OUT_OF_SCOPE'
  | 'TEMPORARY_FAILURE';

/** The complete set of fields a shadow record may carry. Nothing else exists. */
export interface ShadowMismatchRecord {
  /** First 8 chars of the profile UUID. Never the full ID, never a name/email. */
  profileRef: string;
  role: string;
  permissionKey: string;
  organizationId: string | null;
  warehouseId: string | null;
  distributionPointId: string | null;
  legacyDecision: boolean;
  scopedDecision: boolean | null;
  reasonCode: AuthzReasonCode;
  mode: ScopedRbacMode;
  /** Identical mismatches collapsed into this one since the last emission. */
  suppressedCount: number;
}

export function truncateProfileRef(profileId: string | null): string {
  if (!profileId) return 'anonymous';
  return profileId.slice(0, 8);
}

export interface ShadowReporterOptions {
  /** Minimum ms between two identical records. Default 60_000. */
  windowMs?: number;
  /** Max distinct keys tracked before the dedup map is cleared. Default 500. */
  maxTrackedKeys?: number;
  now?: () => number;
  emit?: (record: ShadowMismatchRecord) => void;
}

export interface ShadowReporter {
  report(record: Omit<ShadowMismatchRecord, 'suppressedCount'>): void;
  /** Drop dedup state — called on login/logout/profile change. */
  reset(): void;
}

function defaultEmit(record: ShadowMismatchRecord): void {
  // Development/test only. A production build must stay silent: a mismatch is a
  // developer signal, and a console line in production is just an information
  // leak with no reader.
  console.warn('[phoenix][rbac-shadow] scoped/legacy mismatch', record);
}

const dedupKey = (r: Omit<ShadowMismatchRecord, 'suppressedCount'>): string =>
  [
    r.profileRef, r.role, r.permissionKey,
    r.organizationId ?? '-', r.warehouseId ?? '-', r.distributionPointId ?? '-',
    String(r.legacyDecision), String(r.scopedDecision), r.reasonCode,
  ].join('|');

export function createShadowReporter(opts: ShadowReporterOptions = {}): ShadowReporter {
  const windowMs       = opts.windowMs ?? 60_000;
  const maxTrackedKeys = opts.maxTrackedKeys ?? 500;
  const now            = opts.now ?? (() => Date.now());
  const emit           = opts.emit ?? defaultEmit;

  // key → { lastEmitted, suppressed }
  const seen = new Map<string, { lastEmitted: number; suppressed: number }>();

  return {
    report(record) {
      const k = dedupKey(record);
      const t = now();
      const prev = seen.get(k);

      if (prev && t - prev.lastEmitted < windowMs) {
        prev.suppressed += 1;
        return;
      }

      // Unbounded growth is the other way this floods: a long session touching
      // many warehouses would retain a key per resource forever.
      if (!prev && seen.size >= maxTrackedKeys) seen.clear();

      seen.set(k, { lastEmitted: t, suppressed: 0 });
      emit({ ...record, suppressedCount: prev?.suppressed ?? 0 });
    },

    reset() {
      seen.clear();
    },
  };
}

/** A reporter that emits nothing — the production default. */
export const nullShadowReporter: ShadowReporter = {
  report() { /* intentionally silent */ },
  reset()  { /* nothing to clear */ },
};
