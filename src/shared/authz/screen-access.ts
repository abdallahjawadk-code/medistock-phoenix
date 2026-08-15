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

/**
 * R1.1-U (U-B corrective, C2) — the FACILITY-SAFE screen allow-list.
 *
 * Every screen a facility-scoped role may occupy, by id. Deliberately an
 * ALLOW-list rather than a deny-list: a screen added later is refused to this
 * role until someone proves it facility-safe and names it here. A deny-list
 * would silently admit every future organization-level surface, which is the
 * failure mode this correction exists to remove.
 *
 *    3 — Inventory Center: scopes through useInventoryScopes, whose warehouse
 *        set is facility-derived and excludes the sector main (facility_id
 *        IS NULL) exactly as phoenix_profile_has_warehouse_assignment does.
 *    6 — QR: qr_targets / qr_tokens are narrowed to assigned resources (182 §9c-2).
 *   15 — My Account: the caller's own profile row only.
 *   18 — Outlet Operations: the role landing; every read resolves through
 *        phoenix_profile_has_point_assignment.
 */
const FACILITY_SAFE_SCREENS: readonly number[] = [3, 6, 15, 18];

/**
 * THE canonical screen authorization decision — one predicate the route guard,
 * the restoration path, the nav surfaces and the command palette all share.
 *
 * This is a UX/navigation gate, not a data boundary: every screen's reads are
 * still re-proved server-side by RLS and SECURITY DEFINER RPCs. It exists
 * because "the page happens to render zero rows" is not an authorization
 * decision — an unsafe organization-level screen must be REFUSED to a
 * facility-scoped role, not merely rendered empty.
 *
 * Historical roles keep their previous behaviour for screens 11 and 14 (through
 * institutionsScreenAccess and `users.view`), and everything else stays open.
 *
 * Screen 17 is the ONE deliberate widening, made by R1.3: it now also admits
 * `warehouse_transfer.send`, because gating it on `users.edit_scope` alone
 * refused the supply surface to the role whose whole purpose is to use it. See
 * the inline note on that branch for why this grants no scope-admin authority
 * and cannot reach a facility-scoped role.
 */
export function isScreenAuthorized(
  screen: number,
  role: string | null | undefined,
  permissions: ReadonlySet<string>,
): boolean {
  const n = normalizeRole(role ?? '');

  // A facility-scoped role is confined to the proven-safe surfaces, whatever
  // permissions it may additionally hold.
  if (isFacilityScopedRole(n)) return FACILITY_SAFE_SCREENS.includes(screen);

  if (screen === 11) return institutionsScreenAccess(n) !== false;
  if (screen === 14) return n === 'super_admin' || permissions.has('users.view');

  /**
   * R1.3 - screen 17 is CAPABILITY-gated, not scope-admin-gated.
   *
   * Screen 17 hosts two unrelated sub-surfaces: warehouse/network structural
   * administration and scope assignment (`users.edit_scope`), and the SUPPLY
   * authoring surface (`warehouse_transfer.send`). Gating the whole screen on
   * `users.edit_scope` refused the screen to the very role that exists to use
   * its supply tab: `central_warehouse_manager` holds
   * `warehouse_transfer.send = true` (068) and is granted `users.edit_scope` by
   * no migration at all. It could therefore satisfy every server-side check the
   * supply RPC makes and still be bounced to its landing screen on the way in.
   *
   * The fix is to admit the supply capability here, NOT to hand scope-admin
   * rights to warehouse senders. Reaching the screen is not authority over it:
   * NetworkManagementScreen still computes `canEditScope` from
   * `users.edit_scope` independently, so a send-only actor sees the Supply tab
   * and never the scope-assignment tab.
   *
   * This cannot widen a facility-scoped role: `isFacilityScopedRole` returns
   * above, and 17 is deliberately absent from FACILITY_SAFE_SCREENS.
   */
  if (screen === 17) {
    return n === 'super_admin'
      || permissions.has('users.edit_scope')
      || permissions.has('warehouse_transfer.send');
  }
  return true;
}
