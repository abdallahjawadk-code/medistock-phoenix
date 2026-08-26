import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import {
  isCorrectionApprovalAuthorized,
  type CorrectionApprovalKey,
} from './correction-approval-authorization.service';

/**
 * SECOND-PERSON-CORRECTION-APPROVAL (098 outlet, 101 warehouse) — the exact,
 * ORG-WIDE decision for approving/rejecting a pending correction request.
 *
 * Both phoenix_approve_(outlet|warehouse)_stock_correction check
 * phoenix_status_center_authorized(org, key), which resolves via
 * phoenix_profile_has_permission — a PLAIN, non-resource-scoped check (never
 * warehouse- or outlet-scoped, unlike every other permission in this
 * feature). This hook asks the identical question so the pending-corrections
 * panel is shown to exactly the actors the RPCs would let through — and
 * covers BOTH scopes with one shared org-wide answer, matching the schema
 * (central_warehouse_manager is the sole default holder of both keys).
 *
 * UAT-DEFECT-006 — IT NOW ACTUALLY ASKS THAT QUESTION.
 * The paragraph above described the intent correctly and the code did
 * something else: it called phoenix_profile_has_scoped_permission with both
 * resource targets NULL, whose "both NULL" branch answers only
 * `v_role = ANY(ARRAY['institution_admin'])` and so returned FALSE for
 * central_warehouse_manager — the one role migration 101 grants the key to.
 * The Corrections surface was therefore reachable only by a super_admin,
 * while the writers would have accepted a correctly provisioned
 * central_warehouse_manager all along. The call now goes to the server's own
 * gate; see correction-approval-authorization.service.ts for why this
 * expands no privilege.
 *
 * FAIL CLOSED: a transport or contract failure yields `false`, never a grant.
 *
 * UI preflight ONLY: both RPCs repeat this authorization server-side before
 * any decision is recorded, and separately refuse a proposer approving their
 * own request by profile identity, not permission.
 */
export function useApproveCorrectionPermission(
  orgId: string | null,
  permissionKey: CorrectionApprovalKey,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !profile?.id) return false;
    // Kept as a local short-circuit purely to save a round trip: the server
    // function returns true for super_admin on its own first branch, so this
    // decides nothing the database would not have decided identically.
    if (profile.role === 'super_admin') return true;

    const result = await isCorrectionApprovalAuthorized(orgId, permissionKey);
    return result.ok && result.allowed;
  }, [orgId, permissionKey, profile?.id, profile?.role]);
}
