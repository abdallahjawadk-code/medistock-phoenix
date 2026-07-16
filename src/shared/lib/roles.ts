/* ─── MEDISTOCK PHOENIX — Official Role Model ──────────────────────────────────
   Official simplified role model (USER-PERMISSION-MATRIX-A + INSTITUTION-ADMIN-USER-SCOPE-A).
   The live DB still stores legacy keys for existing users; we keep a
   non-destructive compatibility mapping so nothing breaks before migration 010
   expands the role CHECK. Old Arabic labels are NEVER shown as official labels.
   ──────────────────────────────────────────────────────────────────────────── */

export type OfficialRole =
  | 'super_admin'
  | 'institution_admin'
  | 'warehouse_officer'
  | 'port_officer'
  | 'monthly_status_officer'
  | 'viewer';

/** The only roles offered in the official role dropdown, in display order. */
export const OFFICIAL_ROLES: readonly OfficialRole[] = [
  'super_admin',
  'institution_admin',
  'warehouse_officer',
  'port_officer',
  'monthly_status_officer',
  'viewer',
];

/** Legacy admin role kept for compatibility — not an official dropdown option. */
export const LEGACY_ADMIN_ROLE = 'hospital_admin';

/**
 * Hidden legacy roles that keep their OWN authorization identity.
 *
 * RBAC-PHASE-2-STAGING-SHADOW-TELEMETRY-AND-LEGACY-ROLE-ALIGNMENT:
 * `transfer_manager` used to normalize to `monthly_status_officer`, which meant
 * its authorization identity was REWRITTEN into another role's. Migration 062
 * made that untenable: it grants monthly_status_officer `reports.view` and
 * `audit.view` while giving transfer_manager neither (their rows are absent,
 * which evaluates to false) and explicitly denying it the other eight new keys.
 *
 * The inheritance was therefore a live channel for silent escalation: the moment
 * the ten new keys reach the frontend catalog, a normalize-to-monthly mapping
 * hands transfer_manager two permissions the database denies it — with no code
 * change and no review. Keeping the identity distinct closes the channel at the
 * source rather than relying on nobody ever extending that list.
 *
 * This is an AUTHORIZATION identity only. Display still reads as the legacy
 * label (see roleLabelKey), and the stored DB value is never rewritten.
 */
export const LEGACY_AUTHORIZATION_ROLES = ['transfer_manager'] as const;
export type LegacyAuthorizationRole = typeof LEGACY_AUTHORIZATION_ROLES[number];

export function isLegacyAuthorizationRole(role: string): role is LegacyAuthorizationRole {
  return (LEGACY_AUTHORIZATION_ROLES as readonly string[]).includes(role);
}

/** i18n key per official role (labels live in strings.ts). */
export const OFFICIAL_ROLE_LABEL_KEY: Record<OfficialRole, string> = {
  super_admin:            'orole_super_admin',
  institution_admin:      'orole_institution_admin',
  warehouse_officer:      'orole_warehouse_officer',
  port_officer:           'orole_port_officer',
  monthly_status_officer: 'orole_monthly_status_officer',
  viewer:                 'orole_viewer',
};

/**
 * Non-destructive legacy → official mapping. We never rename live DB values
 * here; this only normalises a role string for display and default-permission
 * lookup. `hospital_admin` is intentionally NOT mapped to an official role —
 * it stays a recognised legacy admin (see normalizeRole).
 */
export const LEGACY_TO_OFFICIAL: Record<string, OfficialRole> = {
  warehouse_manager: 'warehouse_officer',
  point_operator:    'port_officer',
  // transfer_manager is deliberately ABSENT. It is not equivalent to
  // monthly_status_officer under migration 062 (see LEGACY_AUTHORIZATION_ROLES),
  // and an alias table is a claim of equivalence.
};

/** A role as it may appear in the DB today: official, legacy-admin, or mapped legacy. */
export type AnyRole =
  | OfficialRole
  | 'hospital_admin'
  | LegacyAuthorizationRole
  | keyof typeof LEGACY_TO_OFFICIAL;

/** What authorization sees: an official role, or a legacy role that is itself. */
export type AuthorizationRole = OfficialRole | 'hospital_admin' | LegacyAuthorizationRole;

export function isOfficialRole(role: string): role is OfficialRole {
  return (OFFICIAL_ROLES as readonly string[]).includes(role);
}

/**
 * Normalise any stored role to its AUTHORIZATION identity: an official role, the
 * legacy admin, or a hidden legacy role that keeps its own identity.
 *
 * Unknown values fall back to the safest role: viewer. A RECOGNISED legacy role
 * never falls back — `transfer_manager` returns `transfer_manager`, not viewer
 * and not monthly_status_officer, because a fallback is a guess and this is not
 * a case where anything needs guessing.
 *
 * The stored DB value is never rewritten by this function; it only interprets.
 */
export function normalizeRole(role: string | null | undefined): AuthorizationRole {
  if (!role) return 'viewer';
  if (isOfficialRole(role)) return role;
  if (role === LEGACY_ADMIN_ROLE) return 'hospital_admin';
  // Before LEGACY_TO_OFFICIAL: a role that keeps its own identity must never be
  // resolved through an alias table.
  if (isLegacyAuthorizationRole(role)) return role;
  const mapped = LEGACY_TO_OFFICIAL[role];
  return mapped ?? 'viewer';
}

/**
 * i18n key for displaying ANY role.
 *
 * Display compatibility is preserved deliberately: a transfer_manager still
 * READS as the monthly-status label it has always read as. Only its
 * authorization identity changed, and what a label says has never been what
 * authorizes anything.
 */
export function roleLabelKey(role: string | null | undefined): string {
  const n = normalizeRole(role);
  if (n === 'hospital_admin')   return 'orole_legacy_admin';
  if (n === 'transfer_manager') return OFFICIAL_ROLE_LABEL_KEY.monthly_status_officer;
  return OFFICIAL_ROLE_LABEL_KEY[n];
}

/**
 * Can actorRole create / assign targetRole?
 * - Only super_admin may create super_admin.
 * - Only super_admin may create institution_admin.
 * - All other combinations are allowed.
 */
export function canTargetRole(actorRole: string, targetRole: OfficialRole): boolean {
  const actor = normalizeRole(actorRole);
  if (targetRole === 'super_admin')       return actor === 'super_admin';
  if (targetRole === 'institution_admin') return actor === 'super_admin';
  return true;
}
