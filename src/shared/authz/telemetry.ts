/* ─── MEDISTOCK PHOENIX — Staging shadow-mismatch telemetry ───────────────────
   RBAC-PHASE-2-STAGING-SHADOW-TELEMETRY-AND-LEGACY-ROLE-ALIGNMENT, Phase D.

   An in-memory, session-scoped, bounded aggregate of what the scoped engine
   disagreed with the legacy engine about — the evidence a human reads before
   anyone argues for enforcement.

   DELIBERATELY NOT A VENDOR. No third-party telemetry SDK, no network
   transport, no service-role key, no endpoint. The repository has no approved
   telemetry transport today, and introducing one would mean shipping every
   authorization decision of a health system to somebody else's server to solve
   a problem that a JSON export solves. Events live in a Map, die with the tab,
   and leave only if a human exports them.

   PRIVACY IS STRUCTURAL, NOT PROCEDURAL. RbacTelemetryEvent has no field for a
   name, an email, a token, a document, a URL or any clinical value — so there is
   no code path that can emit one, and no redaction step anyone can forget. The
   profile identifier is truncated to 8 characters by the caller (see
   truncateProfileRef): enough to see that two mismatches are the same person,
   useless for identifying who.

   Organization and resource UUIDs are kept whole, and that is a considered
   decision rather than an oversight: they identify a WAREHOUSE, not a person,
   and a mismatch report that cannot say which warehouse diverged is not
   reviewable — which would defeat the only reason this file exists.
   ──────────────────────────────────────────────────────────────────────────── */

import { dedupKey, type ShadowMismatchRecord, type ShadowOutcome, type ShadowReporter } from './diagnostics';
import type { AuthzReasonCode } from './diagnostics';
import type { ScopedRbacMode } from './mode';

export type ScopeType = 'organization' | 'warehouse' | 'distribution_point';

/** The complete telemetry record. Every field is non-identifying by construction. */
export interface RbacTelemetryEvent {
  /** 'disagreement' is signal; 'unknown' is RPC health. Never conflated. */
  outcome: ShadowOutcome;
  /** Truncated profile reference — never the full ID. */
  profileRef: string;
  role: string;
  permissionKey: string;
  scopeType: ScopeType;
  organizationRef: string | null;
  /** The warehouse or distribution-point UUID, per scopeType. */
  resourceRef: string | null;
  legacyDecision: boolean;
  /** null = the scoped engine could not answer. Distinct from false. */
  scopedDecision: boolean | null;
  reasonCode: AuthzReasonCode;
  mode: ScopedRbacMode;
  /** How many identical occurrences collapsed into this event. */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface RbacTelemetrySnapshot {
  capturedAt: string;
  mode: ScopedRbacMode;
  environment: string;
  /** Distinct events currently held. */
  eventCount: number;
  /** Total occurrences, including those collapsed by deduplication. */
  occurrenceCount: number;
  /** Distinct events refused because the store was full. */
  droppedEventCount: number;
  disagreementCount: number;
  unknownCount: number;
  events: RbacTelemetryEvent[];
}

export interface RbacTelemetryStore {
  record(r: Omit<ShadowMismatchRecord, 'suppressedCount'>): void;
  events(): RbacTelemetryEvent[];
  snapshot(): RbacTelemetrySnapshot;
  /** Sanitized JSON for a human to paste into a review. */
  exportJson(): string;
  /** Session end, logout, or a profile switch. */
  clear(): void;
  enabled: boolean;
}

export interface RbacTelemetryOptions {
  mode: ScopedRbacMode;
  environment?: string;
  dev?: boolean;
  /** Max DISTINCT events retained. Default 200. */
  maxEvents?: number;
  /** Minimum ms between two recordings of the SAME event. Default 1000. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Whether telemetry collects at all.
 *
 * Production with mode=off collects nothing — there is nothing to observe, and
 * an idle collector in production is a liability with no upside. Everywhere the
 * scoped engine actually runs (dev, test, staging shadow, the pilot), it does.
 */
export function telemetryEnabled(mode: ScopedRbacMode, dev = false): boolean {
  if (dev) return true;
  return mode !== 'off';
}

function scopeTypeOf(r: Omit<ShadowMismatchRecord, 'suppressedCount'>): ScopeType {
  if (r.warehouseId) return 'warehouse';
  if (r.distributionPointId) return 'distribution_point';
  return 'organization';
}

export function createRbacTelemetryStore(opts: RbacTelemetryOptions): RbacTelemetryStore {
  const maxEvents     = opts.maxEvents ?? 200;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const now           = opts.now ?? (() => Date.now());
  const enabled       = telemetryEnabled(opts.mode, opts.dev);
  const environment   = opts.environment ?? (opts.dev ? 'development' : 'production');

  const events = new Map<string, RbacTelemetryEvent>();
  // Last ingest time per key — the rate limit. Distinct from the event's
  // lastSeen, which only advances when an occurrence is actually counted.
  const lastIngest = new Map<string, number>();
  let dropped = 0;

  return {
    enabled,

    record(r) {
      if (!enabled) return;

      const key = dedupKey(r);
      const t = now();

      const existing = events.get(key);
      if (existing) {
        // Rate limit: a React list re-rendering 40 times in one tick is one
        // event, not 40 occurrences. Counting every render would make `count`
        // a measure of render churn rather than of how often the mismatch is
        // actually reached — which is the number a reviewer will read.
        const last = lastIngest.get(key) ?? 0;
        if (t - last < minIntervalMs) return;
        lastIngest.set(key, t);
        existing.count += 1;
        existing.lastSeen = new Date(t).toISOString();
        return;
      }

      // Bounded: refuse rather than evict. Evicting the oldest would silently
      // discard the first mismatch of the session, which is usually the most
      // informative one; a visible dropped count is more honest than a quietly
      // rewritten history.
      if (events.size >= maxEvents) { dropped += 1; return; }

      const iso = new Date(t).toISOString();
      lastIngest.set(key, t);
      events.set(key, {
        outcome:         r.outcome,
        profileRef:      r.profileRef,
        role:            r.role,
        permissionKey:   r.permissionKey,
        scopeType:       scopeTypeOf(r),
        organizationRef: r.organizationId ?? null,
        resourceRef:     r.warehouseId ?? r.distributionPointId ?? null,
        legacyDecision:  r.legacyDecision,
        scopedDecision:  r.scopedDecision,
        reasonCode:      r.reasonCode,
        mode:            r.mode,
        count:           1,
        firstSeen:       iso,
        lastSeen:        iso,
      });
    },

    events() {
      // Most-frequent first: the reviewer's first question is always "what is
      // the biggest divergence", never "what happened alphabetically".
      return [...events.values()].sort((a, b) => b.count - a.count);
    },

    snapshot() {
      const all = [...events.values()];
      return {
        capturedAt:        new Date(now()).toISOString(),
        mode:              opts.mode,
        environment,
        eventCount:        all.length,
        occurrenceCount:   all.reduce((n, e) => n + e.count, 0),
        droppedEventCount: dropped,
        disagreementCount: all.filter(e => e.outcome === 'disagreement').length,
        unknownCount:      all.filter(e => e.outcome === 'unknown').length,
        events:            all.sort((a, b) => b.count - a.count),
      };
    },

    exportJson() {
      // Export follows collection: if this build never collected, there is
      // nothing to hand out, and saying so beats returning an empty object that
      // reads like "no mismatches found".
      if (!enabled) {
        return JSON.stringify({ error: 'TELEMETRY_DISABLED', mode: opts.mode, environment }, null, 2);
      }
      return JSON.stringify(this.snapshot(), null, 2);
    },

    clear() {
      events.clear();
      lastIngest.clear();
      dropped = 0;
    },
  };
}

/**
 * Adapt a store to the reporter interface the engine emits through.
 *
 * reset() is deliberately a NO-OP. The engine calls reporter.reset() from
 * invalidate(), which also fires on a permission refresh and on the pilot's
 * Retry button — wiping the session's evidence because someone clicked Retry
 * would be a bug that looks exactly like "no mismatches". The store is cleared
 * explicitly, and only when the profile or session actually changes.
 */
export function telemetryReporter(store: RbacTelemetryStore): ShadowReporter {
  return {
    report(record) { store.record(record); },
    reset() { /* intentionally not clearing — see above */ },
  };
}
