/* ─── MEDISTOCK PHOENIX — React binding for the authorization service ─────────
   The service is async (the scoped decision is an RPC), React render is not.
   These hooks bridge the two WITHOUT ever rendering an optimistic `true`: the
   pending state is its own state, and callers must handle it. A hook that
   returned `false` while loading would flash denied UI; one that returned `true`
   would flash granted UI. Neither is acceptable, so `pending` is explicit.
   ──────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import type { AuthorizationService, AuthzDecision, AuthzScope } from './authorization';

export interface AuthzState {
  /** True until the first decision resolves. Render a loading affordance. */
  pending: boolean;
  decision: AuthzDecision | null;
  /** Convenience: the effective answer, false while pending. */
  allowed: boolean;
}

const PENDING: AuthzState = { pending: true, decision: null, allowed: false };

/**
 * Evaluate one permission against one scope.
 *
 * `explain` costs an extra round-trip on a denial and should be passed only
 * where the UI actually shows the reason.
 */
export function useAuthzDecision(
  authz: AuthorizationService,
  permissionKey: string,
  scope?: AuthzScope,
  explain = false,
): AuthzState {
  const [state, setState] = useState<AuthzState>(PENDING);

  // Scope is an object literal at most call sites — depending on its identity
  // would re-run this effect on every render and defeat the service's cache.
  const orgId   = scope?.organizationId ?? null;
  const whId    = scope?.warehouseId ?? null;
  const pointId = scope?.distributionPointId ?? null;

  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    let active = true;
    setState(PENDING);

    const s: AuthzScope = {
      organizationId: orgId, warehouseId: whId, distributionPointId: pointId,
    };

    const run = explain
      ? authz.explainDecision(permissionKey, s)
      : whId
        ? authz.canForWarehouse(permissionKey, orgId, whId)
        : pointId
          ? authz.canForPoint(permissionKey, orgId, pointId)
          : authz.canForOrganization(permissionKey, orgId);

    void run.then(decision => {
      // Drop a resolution that a newer question has already superseded.
      if (!active || mine !== seq.current) return;
      setState({ pending: false, decision, allowed: decision.allowed });
    });

    return () => { active = false; };
  }, [authz, permissionKey, orgId, whId, pointId, explain]);

  return state;
}

/**
 * SHADOW OBSERVATION — evaluate a permission for comparison and throw the
 * answer away.
 *
 * This is the integration primitive for surfaces that are NOT gated today.
 * Placing a real gate on them would newly block users whose legacy permissions
 * happen to lack the key, which is a production behavior change and precisely
 * what this phase forbids. This hook returns nothing: it exists so the engine
 * runs, the comparison happens, and any mismatch is reported — with the screen
 * rendering exactly as it did before.
 *
 * Deliberately returns `void`, not the decision. A caller that could read the
 * result could branch on it, and the next person to touch the file would.
 */
export function useShadowObservation(
  authz: AuthorizationService,
  permissionKey: string,
  scope?: AuthzScope,
): void {
  const orgId   = scope?.organizationId ?? null;
  const whId    = scope?.warehouseId ?? null;
  const pointId = scope?.distributionPointId ?? null;

  useEffect(() => {
    // Nothing to observe until a session and an org scope exist; asking with a
    // null org would only ever produce a rule-4 denial and a noisy false
    // mismatch that says nothing about the scoped engine.
    if (!authz.getContext().authenticated || !orgId) return;

    void (whId
      ? authz.canForWarehouse(permissionKey, orgId, whId)
      : pointId
        ? authz.canForPoint(permissionKey, orgId, pointId)
        : authz.canForOrganization(permissionKey, orgId));
  }, [authz, permissionKey, orgId, whId, pointId]);
}

/** The caller's own active scope assignments. */
export function useCurrentScopes(authz: AuthorizationService) {
  const [scopes, setScopes] = useState<Awaited<ReturnType<AuthorizationService['currentScopes']>>>([]);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let active = true;
    setPending(true);
    void authz.currentScopes().then(s => {
      if (!active) return;
      setScopes(s);
      setPending(false);
    });
    return () => { active = false; };
  }, [authz]);

  return { scopes, pending };
}
