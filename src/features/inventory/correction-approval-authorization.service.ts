/* ─── MEDISTOCK PHOENIX — Correction-approval authorization (UAT-DEFECT-006) ───
   The UI's preflight for "may this actor approve/reject a pending stock
   correction" asked a DIFFERENT question from the one the writers enforce, and
   the two disagreed for the very role the Product designates as the approver.

   THE ASYMMETRY, EXACTLY
     Both writers — phoenix_approve/reject_(outlet|warehouse)_stock_correction
     (migrations 098, 101, 133) — gate on:

         phoenix_status_center_authorized(organization_id, <key>)

     which is: active profile, AND (super_admin OR (profile.organization_id =
     the organization AND phoenix_profile_has_permission(actor, key))). It is a
     PLAIN, non-resource-scoped check, because both approve_correction keys are
     organization-level by design — migration 101 grants
     warehouse_stock.approve_correction to central_warehouse_manager and to
     nobody else.

     The UI instead asked phoenix_profile_has_scoped_permission(profile, key,
     org, NULL, NULL). With both resource targets NULL that helper answers a
     deliberately different question — "does this ROLE carry org-wide read
     compatibility for a warehouse/outlet-scoped key" — and its final line is

         RETURN v_role = ANY(v_org_wide_roles);   -- ARRAY['institution_admin']

     so it returns FALSE for central_warehouse_manager no matter how the profile
     is scoped. Migration 092 says so in its own header comment: that helper is
     "the WRONG tool here". The result was a Corrections tab that only a
     super_admin could see, while the server would have accepted the intended
     operational approver all along.

   WHAT THIS MODULE DOES
     Asks the SERVER'S OWN function, so the UI decision cannot drift from the
     writer's decision again. This is convergence, not a new grant:

       - No permission key is created, granted or widened.
       - No role gains organization-wide rights. The key was already org-level;
         nothing here makes central_warehouse_manager org-wide for anything
         else.
       - The function is SECURITY DEFINER but answers only about auth.uid() —
         it takes no profile-id argument, so unlike the scoped helper it cannot
         be used to probe another user's permissions. Strictly narrower.
       - EXECUTE is already granted to `authenticated` and revoked from
         PUBLIC/anon (migrations 092, 113, 121). Nothing is regranted here.

     And it stays a PREFLIGHT. Every writer repeats this authorization
     server-side before recording a decision, and separately refuses a proposer
     approving their own request by profile identity rather than permission.

   FAIL-CLOSED CONTRACT: every failure path returns { ok: false } and carries no
   `allowed` field at all. No branch in this file turns an error into a grant.
   ──────────────────────────────────────────────────────────────────────────── */

import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/** The canonical server-side gate, named once. */
export const CORRECTION_APPROVAL_AUTHORIZATION_RPC = 'phoenix_status_center_authorized';

/** The two organization-level approval keys, exactly as 098 and 101 spell them. */
export type CorrectionApprovalKey =
  | 'outlet_stock.approve_correction'
  | 'warehouse_stock.approve_correction';

export type CorrectionApprovalAuthorizationResult =
  | { ok: true; allowed: boolean }
  | { ok: false; error: 'NOT_CONFIGURED' | 'MISSING_FUNCTION' | 'RPC_ERROR' | 'NETWORK_ERROR' };

/** PostgREST reports an unknown function as PGRST202 / 42883. */
function isMissingFunctionError(error: { code?: string; message?: string }): boolean {
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  const m = (error.message ?? '').toLowerCase();
  return m.includes('could not find the function') || m.includes('does not exist');
}

/**
 * The exact decision the correction writers make, asked ahead of time.
 *
 * Returns `{ ok: true, allowed }` only when the database answered with a real
 * boolean. Anything else — unconfigured client, missing function, transport
 * failure, non-boolean payload — is an error, never a grant.
 */
export async function isCorrectionApprovalAuthorized(
  organizationId: string | null,
  permissionKey: CorrectionApprovalKey,
): Promise<CorrectionApprovalAuthorizationResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  if (!organizationId) return { ok: true, allowed: false };
  try {
    const { data, error } = await supabase.rpc(CORRECTION_APPROVAL_AUTHORIZATION_RPC, {
      p_organization_id: organizationId,
      p_key: permissionKey,
    });
    if (error) {
      return { ok: false, error: isMissingFunctionError(error) ? 'MISSING_FUNCTION' : 'RPC_ERROR' };
    }
    // The function RETURNS boolean; PostgREST hands it back as a bare JSON
    // bool. Anything else is a contract surprise and must not read as a grant.
    return { ok: true, allowed: data === true };
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}
