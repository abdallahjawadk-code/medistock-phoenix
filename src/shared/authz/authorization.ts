/* ─── MEDISTOCK PHOENIX — Central authorization service ───────────────────────
   ONE place in the application that answers "may this person do this here".

   WHAT THIS IS NOT: a reimplementation of migration 062. The scoped decision is
   whatever phoenix_profile_has_scoped_permission returns — this file does not
   re-derive super_admin's bypass, the override precedence, the org check or the
   assignment check, because two implementations of an authorization rule
   eventually disagree, and the disagreement is always a hole. RLS and the
   062/063 functions remain authoritative for DATA ACCESS; this layer decides
   what the UI shows and, for the super_admin pilot only, what it lets through.

   THE SHADOW PREMISE: the legacy decision (AppContext.myPermissions, i.e.
   get_effective_permissions from migration 010) is preserved BYTE-FOR-BYTE as
   the effective answer in 'off' and 'shadow'. The scoped result is computed
   alongside, compared, reported — and discarded. Nothing is blocked because the
   new engine disagreed.

   FAIL-CLOSED, EVERYWHERE: there is no path in this file where an RPC error, a
   missing profile, a missing session or an unknown key becomes `allowed: true`
   in the scoped result. When the scoped engine cannot answer, shadow mode still
   returns the legacy answer (that is the point of shadow mode), and the
   super_admin pilot returns false.
   ──────────────────────────────────────────────────────────────────────────── */

import {
  combineReporters, createShadowReporter, nullShadowReporter, truncateProfileRef,
  type AuthzReasonCode, type ShadowOutcome, type ShadowReporter,
} from './diagnostics';
import { createRbacTelemetryStore, telemetryReporter, type RbacTelemetryStore } from './telemetry';
import {
  currentScopedRbacMode, scopedEngineEnabled, scopedEngineEnforcesRole,
  type ScopedRbacMode,
} from './mode';
import {
  fetchMyScopeAssignments, supabaseRbacTransport,
  type RbacTransport, type ScopeAssignment,
} from './rbac.service';

/* ── Types ───────────────────────────────────────────────────────────────── */

/** The resource a permission question is asked about. Never both targets. */
export interface AuthzScope {
  organizationId?: string | null;
  warehouseId?: string | null;
  distributionPointId?: string | null;
}

export interface AuthzContext {
  /** False when there is no Supabase session at all. */
  authenticated: boolean;
  /** Null when the session exists but the profile row could not be loaded. */
  profileId: string | null;
  /** The profile's role AS STORED. Never inferred, never defaulted upward. */
  role: string | null;
  organizationId: string | null;
  /** The legacy effective permission set — AppContext.myPermissions, unmodified. */
  legacyPermissions: ReadonlySet<string>;
}

export interface AuthzDecision {
  /** The EFFECTIVE answer the application must obey. */
  allowed: boolean;
  /** Which engine produced `allowed`. 'scoped' only in the super_admin pilot. */
  source: 'legacy' | 'scoped';
  /** What the current production engine said. Always computed. */
  legacy: boolean;
  /**
   * What migration 062 said.
   *   true/false — the function answered.
   *   null       — the engine COULD NOT answer: the flag is off, there is no
   *                session/profile, or the RPC failed. Unknown is not `false`:
   *                conflating them would report every network blip as an RBAC
   *                disagreement and drown the real ones.
   */
  scoped: boolean | null;
  /** The effective reason — why `allowed` is what it is. */
  reason: AuthzReasonCode;
  /** Why the scoped engine answered as it did. Refined by explainDecision(). */
  scopedReason: AuthzReasonCode | null;
  /**
   * True only when both engines answered AND disagreed. An unknown scoped
   * result is never a mismatch. Never itself a reason to block.
   */
  mismatch: boolean;
  mode: ScopedRbacMode;
  permissionKey: string;
  scope: AuthzScope;
}

export interface AuthorizationService {
  can(permissionKey: string): Promise<AuthzDecision>;
  canForOrganization(permissionKey: string, organizationId: string | null): Promise<AuthzDecision>;
  canForWarehouse(permissionKey: string, organizationId: string | null, warehouseId: string | null): Promise<AuthzDecision>;
  canForPoint(permissionKey: string, organizationId: string | null, distributionPointId: string | null): Promise<AuthzDecision>;
  /** A decision plus the extra RPC round-trip needed to name WHY it was denied. */
  explainDecision(permissionKey: string, scope?: AuthzScope): Promise<AuthzDecision>;
  /** The caller's own ACTIVE scope assignments (062 psa_select_scoped). */
  currentScopes(): Promise<ScopeAssignment[]>;
  setContext(ctx: AuthzContext): void;
  getContext(): AuthzContext;
  /** Drop every cached decision. Called on login/logout/profile/permission change. */
  invalidate(): void;
  mode(): ScopedRbacMode;
}

export const ANONYMOUS_CONTEXT: AuthzContext = {
  authenticated: false,
  profileId: null,
  role: null,
  organizationId: null,
  legacyPermissions: new Set(),
};

/* ── Options ─────────────────────────────────────────────────────────────── */

export interface AuthorizationServiceOptions {
  mode?: ScopedRbacMode;
  transport?: RbacTransport;
  reporter?: ShadowReporter;
  loadScopes?: (profileId: string) => Promise<ScopeAssignment[]>;
  now?: () => number;
  /** Bounded lifetime for a cached REMOTE decision. Default 30s. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  /** The context generation this was computed under. */
  generation: number;
  expiresAt: number;
  decision: AuthzDecision;
}

/* ── Engine ──────────────────────────────────────────────────────────────── */

function scopeKey(profileId: string | null, key: string, s: AuthzScope): string {
  // The COMPLETE tuple. A cache keyed on anything less would let a decision for
  // warehouse A answer for warehouse B — which is the whole bug scoped RBAC
  // exists to prevent, reintroduced in the cache layer.
  return [
    profileId ?? 'anon',
    key,
    s.organizationId ?? '-',
    s.warehouseId ?? '-',
    s.distributionPointId ?? '-',
  ].join('|');
}

export function createAuthorizationService(
  opts: AuthorizationServiceOptions = {},
): AuthorizationService {
  const mode       = opts.mode ?? currentScopedRbacMode();
  const transport  = opts.transport ?? supabaseRbacTransport;
  const reporter   = opts.reporter ?? nullShadowReporter;
  const now        = opts.now ?? (() => Date.now());
  const cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  const loadScopes = opts.loadScopes ?? (async (profileId: string) => {
    const res = await fetchMyScopeAssignments(profileId);
    return res.ok ? res.assignments : [];
  });

  let ctx: AuthzContext = ANONYMOUS_CONTEXT;
  // Bumped on every context change and every invalidate(). An in-flight check
  // that resolves after a logout carries the OLD generation and is dropped
  // rather than written into the new session's cache.
  let generation = 0;

  const cache    = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<AuthzDecision>>();

  function invalidate(): void {
    generation += 1;
    cache.clear();
    inflight.clear();
    reporter.reset();
  }

  /** The current production answer. Unchanged from what the app does today. */
  function legacyDecision(key: string): boolean {
    return ctx.legacyPermissions.has(key);
  }

  /**
   * Ask migration 062. Returns the boolean it returned, or an error reason.
   * Never called when the flag is off.
   */
  async function scopedDecision(
    key: string,
    s: AuthzScope,
  ): Promise<{ value: boolean | null; reason: AuthzReasonCode | null }> {
    // `null` here means UNKNOWN, and every caller treats unknown as not-a-grant.
    if (!ctx.authenticated)    return { value: null, reason: 'NOT_AUTHENTICATED' };
    if (!ctx.profileId)        return { value: null, reason: 'PROFILE_UNAVAILABLE' };

    // Rule 7 of the SQL, mirrored locally ONLY to avoid a pointless round-trip:
    // the function itself also fails closed on both targets. This is not a
    // second implementation of a grant path — it can only ever return false.
    if (s.warehouseId && s.distributionPointId) {
      return { value: false, reason: 'OUT_OF_SCOPE' };
    }

    const res = await transport.hasScopedPermission({
      profileId:           ctx.profileId,
      permissionKey:       key,
      organizationId:      s.organizationId ?? null,
      warehouseId:         s.warehouseId ?? null,
      distributionPointId: s.distributionPointId ?? null,
    });

    // An unreachable or absent authorization function is NOT a grant — and it
    // is not a disagreement either. It is an absence of an answer.
    if (!res.ok) return { value: null, reason: 'TEMPORARY_FAILURE' };
    return { value: res.allowed, reason: res.allowed ? 'ALLOWED' : 'PERMISSION_DENIED' };
  }

  function combine(
    key: string,
    s: AuthzScope,
    legacy: boolean,
    scoped: boolean | null,
    scopedReason: AuthzReasonCode | null,
  ): AuthzDecision {
    const enforcing = scopedEngineEnforcesRole(mode, ctx.role ?? '');
    const source: 'legacy' | 'scoped' = enforcing ? 'scoped' : 'legacy';

    // THE SHADOW GUARANTEE: outside the super_admin pilot, `allowed` is the
    // legacy answer and nothing else. `scoped` never contributes to it.
    // Inside the pilot, only an explicit `true` opens anything: unknown (null)
    // is a denial, which is what fail-closed means here.
    const allowed = enforcing ? scoped === true : legacy;

    // An unknown scoped result is not a disagreement.
    const mismatch = scoped !== null && scoped !== legacy;

    let reason: AuthzReasonCode;
    if (enforcing) {
      reason = allowed ? 'ALLOWED' : (scopedReason ?? 'PERMISSION_DENIED');
    } else if (allowed) {
      reason = 'ALLOWED';
    } else if (!ctx.authenticated) {
      reason = 'NOT_AUTHENTICATED';
    } else if (!ctx.profileId) {
      reason = 'PROFILE_UNAVAILABLE';
    } else {
      reason = 'PERMISSION_DENIED';
    }

    const decision: AuthzDecision = {
      allowed, source, legacy, scoped, reason, scopedReason, mismatch,
      mode, permissionKey: key, scope: s,
    };

    // Report a real disagreement, and separately report the scoped engine
    // FAILING to answer — the second is RPC health, not an RBAC finding, and
    // `outcome` keeps a reviewer from reading it as one. Nothing else is
    // reported: an anonymous or profile-less context produces unknowns by the
    // thousand and says nothing about migration 062.
    const reportable: ShadowOutcome | null =
      mismatch ? 'disagreement'
      : scopedReason === 'TEMPORARY_FAILURE' ? 'unknown'
      : null;

    if (reportable) {
      reporter.report({
        outcome:             reportable,
        profileRef:          truncateProfileRef(ctx.profileId),
        role:                ctx.role ?? 'unknown',
        permissionKey:       key,
        organizationId:      s.organizationId ?? null,
        warehouseId:         s.warehouseId ?? null,
        distributionPointId: s.distributionPointId ?? null,
        legacyDecision:      legacy,
        scopedDecision:      scoped,
        reasonCode:          scopedReason ?? 'PERMISSION_DENIED',
        mode,
      });
    }

    return decision;
  }

  async function evaluate(key: string, s: AuthzScope): Promise<AuthzDecision> {
    const legacy = legacyDecision(key);

    if (!scopedEngineEnabled(mode)) {
      return {
        allowed: legacy, source: 'legacy', legacy, scoped: null,
        reason: legacy ? 'ALLOWED' : 'PERMISSION_DENIED',
        scopedReason: 'FLAG_OFF',
        mismatch: false, mode, permissionKey: key, scope: s,
      };
    }

    const cacheK = scopeKey(ctx.profileId, key, s);
    const hit = cache.get(cacheK);
    if (hit && hit.generation === generation && hit.expiresAt > now()) {
      return hit.decision;
    }

    // Concurrent identical checks — the common case when a list renders N rows
    // that each ask the same question — share one round-trip.
    const pending = inflight.get(cacheK);
    if (pending) return pending;

    const startGeneration = generation;
    const promise = (async () => {
      const { value: scoped, reason } = await scopedDecision(key, s);
      const decision = combine(key, s, legacy, scoped, reason);

      // Only cache if the session did not change under us, and never cache a
      // non-answer (a network blip must not pin a denial for 30s).
      if (startGeneration === generation && scoped !== null) {
        cache.set(cacheK, {
          generation,
          expiresAt: now() + cacheTtlMs,
          decision,
        });
      }
      return decision;
    })().finally(() => {
      inflight.delete(cacheK);
    });

    inflight.set(cacheK, promise);
    return promise;
  }

  return {
    mode: () => mode,
    getContext: () => ctx,

    setContext(next: AuthzContext) {
      ctx = next;
      // Unconditional: a cache that survives a context change is a cache that
      // can answer for the previous user.
      invalidate();
    },

    invalidate,

    can(key) {
      // The org-only question, asked about the caller's own organization.
      return evaluate(key, { organizationId: ctx.organizationId });
    },

    canForOrganization(key, organizationId) {
      return evaluate(key, { organizationId });
    },

    canForWarehouse(key, organizationId, warehouseId) {
      return evaluate(key, { organizationId, warehouseId });
    },

    canForPoint(key, organizationId, distributionPointId) {
      return evaluate(key, { organizationId, distributionPointId });
    },

    async explainDecision(key, scope = {}) {
      const s: AuthzScope = {
        organizationId:      scope.organizationId ?? ctx.organizationId,
        warehouseId:         scope.warehouseId ?? null,
        distributionPointId: scope.distributionPointId ?? null,
      };
      const decision = await evaluate(key, s);

      // Refine ONLY when the scoped engine actually denied. A non-answer has
      // nothing to explain, and an allow has nothing to explain either. This is
      // where the extra assignment round-trip is worth its cost; can() must
      // never pay it.
      if (decision.scoped !== false || ctx.profileId === null) return decision;

      // The refinement lands on scopedReason. `reason` (the effective reason)
      // only follows it under the pilot, where the scoped answer IS the
      // decision — in shadow, `allowed` still came from the legacy engine and
      // must keep saying so.
      const refine = (scopedReason: AuthzReasonCode): AuthzDecision => ({
        ...decision,
        scopedReason,
        reason: decision.source === 'scoped' && !decision.allowed ? scopedReason : decision.reason,
      });

      // Organization disagreement is decidable locally — profiles.organization_id
      // is already in context and 062 rule 4 requires an exact match.
      if (
        ctx.role !== 'super_admin' &&
        (s.organizationId == null || s.organizationId !== ctx.organizationId)
      ) {
        return refine('OUT_OF_SCOPE');
      }

      if (s.warehouseId) {
        const res = await transport.hasWarehouseAssignment(ctx.profileId, s.warehouseId);
        if (!res.ok) return refine('TEMPORARY_FAILURE');
        return refine(res.allowed ? 'PERMISSION_DENIED' : 'ASSIGNMENT_MISSING');
      }

      if (s.distributionPointId) {
        const res = await transport.hasPointAssignment(ctx.profileId, s.distributionPointId);
        if (!res.ok) return refine('TEMPORARY_FAILURE');
        return refine(res.allowed ? 'PERMISSION_DENIED' : 'ASSIGNMENT_MISSING');
      }

      return decision;
    },

    async currentScopes() {
      if (!ctx.authenticated || !ctx.profileId) return [];
      return loadScopes(ctx.profileId);
    },
  };
}

/**
 * The observability this build should use.
 *
 * Two channels, deliberately different in lifetime:
 *   • console — dev/test only, heavily deduplicated, for the developer watching.
 *   • telemetry store — wherever the engine runs (including staging shadow),
 *     accumulating the session's evidence for a human to export and review.
 *
 * A production build with mode=off gets neither, and the store reports itself
 * disabled rather than pretending to be empty.
 */
export function createRbacObservability(mode: ScopedRbacMode): {
  reporter: ShadowReporter;
  store: RbacTelemetryStore;
} {
  const dev   = import.meta.env.DEV;
  const noisy = dev || import.meta.env.MODE === 'test';

  const store = createRbacTelemetryStore({
    mode, dev, environment: import.meta.env.MODE,
  });

  const console_ = noisy ? createShadowReporter() : nullShadowReporter;
  return { reporter: combineReporters(console_, telemetryReporter(store)), store };
}

export type { ScopeAssignment } from './rbac.service';
export type { AuthzReasonCode } from './diagnostics';
