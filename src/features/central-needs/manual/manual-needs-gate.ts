/**
 * R1-A4 — the activation gate of the Screen-3 "الاحتياجات والتحصيص" tab.
 *
 * INACTIVE BY DEFAULT and FAIL-CLOSED. The tab exists only when ALL of these hold, and every unknown means "off":
 *   1. the build carries the explicit activation flag (`VITE_R1_MANUAL_NEEDS_TAB === 'enabled'`); without it NOTHING
 *      below runs — in particular no network call is made;
 *   2. the signed-in role is one of the two Central Needs authoring roles (super_admin, central_warehouse_manager);
 *   3. the actor is acting for HOME organization, and that organization is a Pharmacy Department authority
 *      (org-level scope: no warehouse involved, a care institution never qualifies);
 *   4. the SERVER says the actor holds the manual-entry key (`manual_set`) OR the approve key (`approve`) for that organization: an independent
 *      approver reaches the tab WITHOUT any entry right - every write control inside stays gated by the server capability.
 * The gate is a UX affordance only: every routine re-authorizes on the server, and the writers stay owner-only (no EXECUTE for
 * authenticated) until the independently approved R1-b activation.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { getManualCapabilities, type ManualCapabilities } from './manual-needs.service';

export type ManualNeedsTabState = 'off' | 'checking' | 'on';

export interface ManualNeedsGateInputs {
  /** The explicit build-time activation flag. */
  flag: boolean;
  role: string | null | undefined;
  /** The organization the actor is acting for, and the organization their profile belongs to. */
  activeOrgId: string | null | undefined;
  homeOrgId: string | null | undefined;
  /** `organization_kind` of that organization once known (`null` = unknown / not loaded / failed). */
  orgKind: string | null;
  orgKindLoaded: boolean;
  /** The server's capability answer: undefined = not asked yet, null = the question failed. */
  capabilities: Pick<ManualCapabilities, 'manualSet' | 'approve'> | null | undefined;
}

const AUTHORING_ROLES = new Set(['super_admin', 'central_warehouse_manager']);

/** Pure decision. Anything not positively proven is `off`; `checking` only while a still-possible `on` awaits an answer. */
export function computeManualNeedsTabState(i: ManualNeedsGateInputs): ManualNeedsTabState {
  if (i.flag !== true) return 'off';
  if (!i.role || !AUTHORING_ROLES.has(i.role)) return 'off';
  if (!i.activeOrgId || !i.homeOrgId || i.activeOrgId !== i.homeOrgId) return 'off';
  if (!i.orgKindLoaded) return 'checking';
  if (i.orgKind !== 'pharmacy_department_authority') return 'off';
  if (i.capabilities === undefined) return 'checking';
  if (i.capabilities === null) return 'off';
  // The tab is for the two roles the server confirms: an ENTRANT (manual_set) and an independent APPROVER (approve). Seeing the tab grants no
  // right: every write control inside is gated by the server's own capability answer (an approver without manual_set cannot enter needs).
  return i.capabilities.manualSet === true || i.capabilities.approve === true ? 'on' : 'off';
}

/** The build flag. A function so tests can pin it; the default build has no such variable. */
export function manualNeedsTabFlag(): boolean {
  try {
    return (import.meta.env as Record<string, unknown>).VITE_R1_MANUAL_NEEDS_TAB === 'enabled';
  } catch {
    return false;
  }
}

export interface ManualNeedsGateDeps {
  flag: () => boolean;
  getOrganizations: typeof getOrganizations;
  getManualCapabilities: typeof getManualCapabilities;
}

const realDeps: ManualNeedsGateDeps = { flag: manualNeedsTabFlag, getOrganizations, getManualCapabilities };

/**
 * Hook used by the screen. With the flag off it returns 'off' and performs NO request. Responses of a previous organization
 * or role are discarded (epoch), and any failure resolves to 'off'.
 */
export function useManualNeedsTabGate(deps: ManualNeedsGateDeps = realDeps): ManualNeedsTabState {
  const { role, activeOrgId, profile } = useApp();
  const homeOrgId = profile?.organization_id ?? null;
  const flag = deps.flag();
  const [org, setOrg] = useState<{ id: string; kind: string | null } | null>(null);
  const [caps, setCaps] = useState<{ id: string; value: ManualCapabilities | null } | null>(null);
  const epoch = useRef(0);

  const precondition = flag && !!role && AUTHORING_ROLES.has(role) && !!activeOrgId && activeOrgId === homeOrgId;

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setOrg(null);
    setCaps(null);
    if (!precondition || !activeOrgId) return undefined;
    void (async () => {
      let kind: string | null = null;
      try {
        const rows = await deps.getOrganizations();
        kind = rows.find((o) => o.id === activeOrgId)?.organizationKind ?? null;
      } catch {
        kind = null;
      }
      if (epoch.current !== mine) return;
      setOrg({ id: activeOrgId, kind });
      if (kind !== 'pharmacy_department_authority') return;     // never ask the server for anything else
      let value: ManualCapabilities | null = null;
      try {
        value = await deps.getManualCapabilities(activeOrgId, null);
      } catch {
        value = null;
      }
      if (epoch.current !== mine) return;
      setCaps({ id: activeOrgId, value });
    })();
    return () => { epoch.current += 1; };
  }, [precondition, activeOrgId, role]);

  return computeManualNeedsTabState({
    flag,
    role,
    activeOrgId,
    homeOrgId,
    orgKind: org && org.id === activeOrgId ? org.kind : null,
    orgKindLoaded: !!org && org.id === activeOrgId,
    capabilities: caps && caps.id === activeOrgId ? caps.value : undefined,
  });
}
