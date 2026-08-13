/**
 * SCREEN-ACCESS — the five-role visibility model for guarded screens.
 *
 * These are UX GATES only. Every screen's data path is re-checked server-side
 * by RLS + SECURITY DEFINER RPCs, so a hidden button or a forged route can
 * never become an unauthorized read or write. This module keeps the nav,
 * command palette and route guard agreeing on ONE predicate each, instead of
 * scattered role-name checks that drift apart.
 *
 * The five operational roles (migration-066 model):
 *   super_admin               — platform administrator
 *   central_warehouse_manager — pharmacy-department stock control
 *   institution_admin         — one institution
 *   warehouse_officer         — one institution store (depot)
 *   outlet_officer            — one dispensing outlet
 */
import { normalizeRole, isFacilityScopedRole } from '@/shared/lib/roles';

/** Platform administrator — the ONLY role that manages institutions globally. */
export function isPlatformAdmin(role: string | null | undefined): boolean {
  return normalizeRole(role ?? '') === 'super_admin';
}

/**
 * An institution-level administrator (current or legacy org admin). Gets the
 * "My Organization" settings scope — NOT the global institutions directory.
 */
export function isInstitutionAdmin(role: string | null | undefined): boolean {
  const n = normalizeRole(role ?? '');
  return n === 'institution_admin' || n === 'hospital_admin';
}

/**
 * Who may reach screen 11 at all, and in which mode:
 *   'directory' — the global institutions list/create (platform admin only);
 *   'own'       — "My Organization" for this actor's institution;
 *   false       — no access (route guard renders 403; nav hides the entry).
 */
export function institutionsScreenAccess(role: string | null | undefined): 'directory' | 'own' | false {
  if (isPlatformAdmin(role)) return 'directory';
  if (isInstitutionAdmin(role)) return 'own';
  return false;
}

/**
 * Choose the first authorized operational surface without granting any new
 * permission. Unknown roles normalize to the least-privileged outlet identity,
 * so a missing or stale role can never default into the reports surface.
 */
export function roleLandingScreen(role: string | null | undefined): number {
  const n = normalizeRole(role ?? '');
  if (n === 'outlet_officer') return 18;
  /**
   * R1.1-U — a FACILITY-SCOPED role must not land on the reports surface.
   *
   * Screen 21 carries eight tabs whose only boundary is `authenticated_rls`,
   * and RLS alone is organization-wide on several of the read models behind
   * them, so it is not a facility-safe landing (allowedReportTabs now refuses
   * those tabs to this role for the same reason, which would otherwise land it
   * on a Forbidden screen at login).
   *
   * Screen 18 is the correct first surface: it self-gates on the profile's
   * manageable outlets, which for this role are derived from its assigned
   * health centres, and every outlet read behind it resolves through
   * phoenix_profile_has_point_assignment. This grants no permission — it only
   * chooses which already-authorized surface opens first.
   */
  if (isFacilityScopedRole(n)) return 18;
  return 21;
}
