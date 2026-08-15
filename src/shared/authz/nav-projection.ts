/**
 * NAV-PROJECTION — R1.1-P (P1).
 *
 * ONE projection every visible navigation surface shares: the desktop sidebar,
 * the mobile drawer, the mobile bottom bar and the command palette.
 *
 * The defect this closes: each of those four components carried its own
 * hand-copied gates (`role === 'super_admin' || myPermissions.has('users.view')`
 * and friends), so they could — and did — offer a screen that
 * `isScreenAuthorized` would then refuse at the route guard. A facility-scoped
 * health_center_manager saw Reports, Inter-Institution Alerts and Local
 * Procurement in the menu, clicked one, and was bounced to its landing screen.
 * A menu entry that cannot be entered is not a cosmetic defect: it advertises
 * organization-level surfaces to an operator confined to one health centre.
 *
 * The fix is not a fifth copy of the role checks. Every candidate list is
 * intersected with the canonical decision instead, so the menu can never again
 * disagree with the guard — adding a screen to one surface cannot widen it, and
 * a screen added to FACILITY_SAFE_SCREENS reaches all four at once.
 *
 * Note the per-screen gates for 11/14/17 are NOT re-implemented here. They live
 * in `isScreenAuthorized` and are reproduced from it exactly, which is what lets
 * historical roles keep byte-identical menus: for any non-facility-scoped role
 * this projection returns precisely what the four hand-written gates returned.
 *
 * This is a UX projection, never a security boundary. Every screen behind it is
 * still re-proved by the route guard, by RLS and by SECURITY DEFINER RPCs.
 */
import { institutionsScreenAccess, isScreenAuthorized } from './screen-access';
import { normalizeRole } from '@/shared/lib/roles';

/** The minimum shape a navigation candidate must have to be projected. */
export interface NavProjectable {
  screen: number;
  labelKey: string;
  /** Retained from the historical nav item shape; no current item sets it. */
  superAdminOnly?: boolean;
}

/** Who is navigating. Raw role is fine — every predicate normalizes it. */
export interface NavActor {
  role: string | null | undefined;
  permissions: ReadonlySet<string>;
}

/**
 * Project a surface's candidate items down to what this actor may actually
 * reach, preserving each surface's own ordering and item shape.
 *
 * Screen 11 keeps its established two-mode label: the platform admin sees the
 * institutions directory, an institution admin sees the same entry relabelled
 * "My Organization". Every other label is the caller's.
 */
export function projectNavigation<T extends NavProjectable>(
  candidates: readonly T[],
  actor: NavActor,
): T[] {
  const role = normalizeRole(actor.role ?? '');
  return candidates
    .filter(item => !item.superAdminOnly || role === 'super_admin')
    .filter(item => isScreenAuthorized(item.screen, actor.role, actor.permissions))
    .map(item => item.screen === 11 && institutionsScreenAccess(actor.role) === 'own'
      ? { ...item, labelKey: 'nav_my_organization' }
      : item);
}

/**
 * May this actor reach the institutions surface at all?
 *
 * The command palette uses this to decide whether to perform its lazy
 * `getOrganizations()` read. Searching a directory you cannot open is not a
 * harmless convenience — it puts organization-level records in front of a
 * facility-scoped operator and offers a navigation result into a screen the
 * guard will refuse.
 */
export function canSearchInstitutions(actor: NavActor): boolean {
  return isScreenAuthorized(11, actor.role, actor.permissions);
}
