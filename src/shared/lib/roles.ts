/* ─── MEDISTOCK PHOENIX — Official Role Model ──────────────────────────────────
   Official simplified role model (USER-PERMISSION-MATRIX-A).
   The live DB still stores legacy keys for existing users; we keep a
   non-destructive compatibility mapping so nothing breaks before migration 010
   expands the role CHECK. Old Arabic labels are NEVER shown as official labels.
   ──────────────────────────────────────────────────────────────────────────── */

export type OfficialRole =
  | 'super_admin'
  | 'warehouse_officer'
  | 'port_officer'
  | 'monthly_status_officer'
  | 'viewer';

/** The only roles offered in the official role dropdown, in display order. */
export const OFFICIAL_ROLES: readonly OfficialRole[] = [
  'super_admin',
  'warehouse_officer',
  'port_officer',
  'monthly_status_officer',
  'viewer',
];

/** Legacy admin role kept for compatibility — not an official dropdown option. */
export const LEGACY_ADMIN_ROLE = 'hospital_admin';

/** i18n key per official role (labels live in strings.ts). */
export const OFFICIAL_ROLE_LABEL_KEY: Record<OfficialRole, string> = {
  super_admin:            'orole_super_admin',
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
  transfer_manager:  'monthly_status_officer',
};

/** A role as it may appear in the DB today: official, legacy-admin, or mapped legacy. */
export type AnyRole = OfficialRole | 'hospital_admin' | keyof typeof LEGACY_TO_OFFICIAL;

export function isOfficialRole(role: string): role is OfficialRole {
  return (OFFICIAL_ROLES as readonly string[]).includes(role);
}

/**
 * Normalise any stored role to either an official role or the legacy admin.
 * Unknown values fall back to the safest role: viewer.
 */
export function normalizeRole(role: string | null | undefined): OfficialRole | 'hospital_admin' {
  if (!role) return 'viewer';
  if (isOfficialRole(role)) return role;
  if (role === LEGACY_ADMIN_ROLE) return 'hospital_admin';
  const mapped = LEGACY_TO_OFFICIAL[role];
  return mapped ?? 'viewer';
}

/** i18n key for displaying ANY role, including the legacy admin. */
export function roleLabelKey(role: string | null | undefined): string {
  const n = normalizeRole(role);
  if (n === 'hospital_admin') return 'orole_legacy_admin';
  return OFFICIAL_ROLE_LABEL_KEY[n];
}

/** Only super_admin may create or assign super_admin. */
export function canTargetRole(actorRole: string, targetRole: OfficialRole): boolean {
  if (targetRole === 'super_admin') return normalizeRole(actorRole) === 'super_admin';
  return true;
}
