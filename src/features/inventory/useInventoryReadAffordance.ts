import { useApp } from '@/app/AppContext';
import { isFacilityScopedRole, normalizeRole } from '@/shared/lib/roles';

/**
 * R1.5-E — THE ONE read-discoverability affordance for the Inventory Center.
 *
 * WHAT PROBLEM THIS SOLVES
 *   Every Inventory Center history tab was gated on a MUTATION permission:
 *   Returns on `outlet_stock.return_receive`, Quarantine on
 *   `warehouse_transfer.return_request`, Corrections on
 *   `*.approve_correction`. An actor who may READ those rows but may not act on
 *   them therefore saw no tab at all — the operation key was being used to hide
 *   readable history.
 *
 *   Section D of Migration 185 gives `health_center_manager` facility-safe RLS
 *   SELECT parity on exactly those surfaces. Without a read affordance the tab
 *   stays hidden and that parity is unreachable, so the fix belongs here and
 *   NOT in a new permission key: inventing a key to make a tab appear would put
 *   a real grant into the RBAC matrix to solve a rendering problem.
 *
 * WHAT THIS IS
 *   UI DISCOVERABILITY ONLY. It answers "should this actor be offered the tab",
 *   never "may this actor read these rows" and never "may this actor act".
 *
 *   - The DATABASE decides what is readable. Every query behind these tabs is a
 *     plain RLS-scoped SELECT; if RLS returns nothing the tab renders its empty
 *     state and nothing leaks. There is no client-side sibling-facility filter,
 *     because client filtering is not a security mechanism.
 *   - MUTATION stays exactly where it was. This value is never OR-ed into a
 *     `canDispose` / `canReceive` / `canApprove` decision. Those keep coming
 *     from the scoped permission hooks, unchanged, and every RPC re-checks them
 *     server-side regardless.
 *
 * WHY A ROLE PREDICATE
 *   Migration 182 deliberately gives this role only minimal read defaults and
 *   R1.5-E adds no permission key, so there is no key to ask about. The role
 *   question is asked ONCE, here, through the canonical `isFacilityScopedRole`
 *   helper rather than a literal string compare, so the check cannot drift
 *   across components and adding a future facility-scoped role reaches every
 *   tab at once.
 */
export function useInventoryReadAffordance(): boolean {
  const { profile } = useApp();
  return isFacilityScopedRole(normalizeRole(profile?.role ?? ''));
}
