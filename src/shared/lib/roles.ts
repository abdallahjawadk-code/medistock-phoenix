/* ─── MEDISTOCK PHOENIX — Official Role Model ──────────────────────────────────
   Migration-066 role model. Legacy values remain readable, but each keeps its
   own authorization identity so later operational keys cannot widen it through
   an alias. Old roles are never offered for new assignment.
   ──────────────────────────────────────────────────────────────────────────── */

export type OfficialRole =
  | 'super_admin'
  | 'institution_admin'
  | 'central_warehouse_manager'
  | 'warehouse_officer'
  | 'outlet_officer'
  | 'health_center_manager';

/** The only roles offered in the official role dropdown, in display order. */
export const OFFICIAL_ROLES: readonly OfficialRole[] = [
  'super_admin',
  'institution_admin',
  'central_warehouse_manager',
  'warehouse_officer',
  'outlet_officer',
  'health_center_manager',
];

/**
 * R1.1-U: roles whose authority is FACILITY-SCOPED rather than organization-wide.
 *
 * A role listed here is meaningless without at least one active
 * profile_scope_assignments row of scope_type='facility', and the database
 * refuses to let it exist outside an active care_institution health sector
 * (Migration 182). The UI uses this only to decide whether to show the
 * health-centre picker; the database remains the authority.
 */
export const FACILITY_SCOPED_ROLES = ['health_center_manager'] as const;
export type FacilityScopedRole = typeof FACILITY_SCOPED_ROLES[number];

export function isFacilityScopedRole(role: string | null | undefined): role is FacilityScopedRole {
  return !!role && (FACILITY_SCOPED_ROLES as readonly string[]).includes(role);
}

/** Legacy admin role kept for compatibility — not an official dropdown option. */
export const LEGACY_ADMIN_ROLE = 'hospital_admin';

/**
 * Hidden legacy roles that keep their OWN authorization identity.
 *
 * Migration 062 already proved this for transfer_manager. Migration 066 makes
 * the same boundary load-bearing for warehouse_manager, port_officer and
 * point_operator: newer operational roles receive keys those legacy roles are
 * explicitly denied. An alias would silently undo that database decision.
 *
 * The stored DB value is never rewritten; display marks it as legacy.
 */
export const LEGACY_AUTHORIZATION_ROLES = [
  'warehouse_manager',
  'port_officer',
  'point_operator',
  'transfer_manager',
] as const;
export type LegacyAuthorizationRole = typeof LEGACY_AUTHORIZATION_ROLES[number];

export function isLegacyAuthorizationRole(role: string): role is LegacyAuthorizationRole {
  return (LEGACY_AUTHORIZATION_ROLES as readonly string[]).includes(role);
}

/** i18n key per official role (labels live in strings.ts). */
export const OFFICIAL_ROLE_LABEL_KEY: Record<OfficialRole, string> = {
  super_admin:            'orole_super_admin',
  institution_admin:      'orole_institution_admin',
  central_warehouse_manager: 'orole_central_warehouse_manager',
  warehouse_officer:      'orole_warehouse_officer',
  outlet_officer:         'orole_outlet_officer',
  health_center_manager:  'orole_health_center_manager',
};

/**
 * Kept as an exported empty object for compatibility with older imports.
 * Migration 066 makes every legacy alias unsafe, so no role is mapped here.
 */
export const LEGACY_TO_OFFICIAL: Readonly<Record<string, OfficialRole>> = Object.freeze({});

/** A role as it may appear in the DB today: official or retained legacy. */
export type AnyRole =
  | OfficialRole
  | 'hospital_admin'
  | LegacyAuthorizationRole;

/** What authorization sees: an official role, or a legacy role that is itself. */
export type AuthorizationRole = OfficialRole | 'hospital_admin' | LegacyAuthorizationRole;

export function isOfficialRole(role: string): role is OfficialRole {
  return (OFFICIAL_ROLES as readonly string[]).includes(role);
}

/**
 * Normalise any stored role to its AUTHORIZATION identity: an official role, the
 * legacy admin, or a hidden legacy role that keeps its own identity.
 *
 * Unknown values fall back to the safest role: outlet_officer, whose default
 * permission set is empty (PHOENIX-FIVE-ROLE-CUTOVER-091 removed viewer, which
 * held this fallback previously). Every recognised legacy role round-trips
 * literally; normalization never invents equivalence.
 *
 * The stored DB value is never rewritten by this function; it only interprets.
 */
export function normalizeRole(role: string | null | undefined): AuthorizationRole {
  if (!role) return 'outlet_officer';
  if (isOfficialRole(role)) return role;
  if (role === LEGACY_ADMIN_ROLE) return 'hospital_admin';
  // Before LEGACY_TO_OFFICIAL: a role that keeps its own identity must never be
  // resolved through an alias table.
  if (isLegacyAuthorizationRole(role)) return role;
  const mapped = LEGACY_TO_OFFICIAL[role];
  return mapped ?? 'outlet_officer';
}

/**
 * i18n key for displaying ANY role.
 *
 * Official roles use their approved labels. Retained roles are visibly marked
 * as legacy so an administrator knows they still require migration.
 */
export function roleLabelKey(role: string | null | undefined): string {
  const n = normalizeRole(role);
  if (n === 'hospital_admin')    return 'orole_legacy_admin';
  if (n === 'warehouse_manager') return 'orole_legacy_warehouse_manager';
  if (n === 'port_officer')      return 'orole_legacy_port_officer';
  if (n === 'point_operator')    return 'orole_legacy_point_operator';
  if (n === 'transfer_manager')  return 'orole_legacy_transfer_manager';
  return OFFICIAL_ROLE_LABEL_KEY[n];
}

/**
 * Can actorRole create / assign targetRole?
 * - Only super_admin may create super_admin.
 * - Only super_admin may create institution_admin.
 * - Only super_admin may create central_warehouse_manager.
 * - health_center_manager is targetable only by super_admin or an
 *   institution_admin, and — because this function sees no organization — the
 *   HEALTH-SECTOR requirement is proved server-side, never here.
 * - All lower operational roles remain targetable subject to the caller's
 *   server-enforced users.create/users.assign_role permissions.
 *
 * This is a UI affordance. Migration 182 and the admin-create-user Edge function
 * refuse a health_center_manager outside an active care_institution health
 * sector even when this returns true — a hospital institution_admin is rejected
 * by the server, not by this predicate.
 */
export function canTargetRole(actorRole: string, targetRole: OfficialRole): boolean {
  const actor = normalizeRole(actorRole);
  if (targetRole === 'super_admin')       return actor === 'super_admin';
  if (targetRole === 'institution_admin') return actor === 'super_admin';
  if (targetRole === 'central_warehouse_manager') return actor === 'super_admin';
  if (targetRole === 'health_center_manager') {
    return actor === 'super_admin' || actor === 'institution_admin';
  }
  return true;
}
