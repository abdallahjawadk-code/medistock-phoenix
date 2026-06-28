/* ─── MEDISTOCK PHOENIX — Permission Matrix Engine ─────────────────────────────
   Two-layer permission model (USER-PERMISSION-MATRIX-A):
     Layer 1 — role defaults (per official role).
     Layer 2 — per-user overrides (allow / deny / inherit).
   Effective = role default, then override.

   IMPORTANT: this module is a CONVENIENCE layer for the UI and view-model
   tests. It is NOT the security boundary. Critical/dangerous actions are
   enforced server-side by RLS + SECURITY DEFINER RPCs (migration 010) and the
   admin-create-user Edge Function. Never trust the checkbox grid alone.
   ──────────────────────────────────────────────────────────────────────────── */

import { normalizeRole, type OfficialRole } from './roles';

export interface PermissionKeyDef {
  key: string;
  module: string;
  action: string;
  labelKey: string;   // i18n key (strings.ts)
  dangerous: boolean;
}

/** The complete, allowlisted permission catalog. No future/unimplemented modules. */
export const PERMISSION_KEYS: readonly PermissionKeyDef[] = [
  { key: 'dashboard.view',                       module: 'dashboard',          action: 'view',              labelKey: 'perm_dashboard_view',            dangerous: false },
  { key: 'organizations.view',                   module: 'organizations',      action: 'view',              labelKey: 'perm_organizations_view',        dangerous: false },
  { key: 'organizations.create',                 module: 'organizations',      action: 'create',            labelKey: 'perm_organizations_create',      dangerous: true  },
  { key: 'organizations.edit',                   module: 'organizations',      action: 'edit',              labelKey: 'perm_organizations_edit',        dangerous: false },
  { key: 'organizations.archive',                module: 'organizations',      action: 'archive',           labelKey: 'perm_organizations_archive',     dangerous: true  },
  { key: 'users.view',                           module: 'users',              action: 'view',              labelKey: 'perm_users_view',                dangerous: false },
  { key: 'users.create',                         module: 'users',              action: 'create',            labelKey: 'perm_users_create',              dangerous: true  },
  { key: 'users.assign_role',                    module: 'users',              action: 'assign_role',       labelKey: 'perm_users_assign_role',         dangerous: true  },
  { key: 'users.manage_permissions',             module: 'users',              action: 'manage_permissions',labelKey: 'perm_users_manage_permissions',  dangerous: true  },
  { key: 'users.disable',                        module: 'users',              action: 'disable',           labelKey: 'perm_users_disable',             dangerous: true  },
  { key: 'users.delete',                         module: 'users',              action: 'delete',            labelKey: 'perm_users_delete',              dangerous: true  },
  { key: 'warehouses.view',                      module: 'warehouses',         action: 'view',              labelKey: 'perm_warehouses_view',           dangerous: false },
  { key: 'warehouses.manage',                    module: 'warehouses',         action: 'manage',            labelKey: 'perm_warehouses_manage',         dangerous: false },
  { key: 'ports.view',                           module: 'ports',              action: 'view',              labelKey: 'perm_ports_view',                dangerous: false },
  { key: 'ports.create',                         module: 'ports',              action: 'create',            labelKey: 'perm_ports_create',              dangerous: false },
  { key: 'ports.edit',                           module: 'ports',              action: 'edit',              labelKey: 'perm_ports_edit',                dangerous: false },
  { key: 'ports.archive',                        module: 'ports',              action: 'archive',           labelKey: 'perm_ports_archive',             dangerous: true  },
  { key: 'qr.view',                              module: 'qr',                 action: 'view',              labelKey: 'perm_qr_view',                   dangerous: false },
  { key: 'qr.generate',                          module: 'qr',                 action: 'generate',          labelKey: 'perm_qr_generate',               dangerous: false },
  { key: 'qr.revoke',                            module: 'qr',                 action: 'revoke',            labelKey: 'perm_qr_revoke',                 dangerous: true  },
  { key: 'availability.view',                    module: 'availability',       action: 'view',              labelKey: 'perm_availability_view',         dangerous: false },
  { key: 'availability.manage',                  module: 'availability',       action: 'manage',            labelKey: 'perm_availability_manage',       dangerous: false },
  { key: 'status_center.view',                   module: 'status_center',      action: 'view',              labelKey: 'perm_status_center_view',         dangerous: false },
  { key: 'status_center.create',                 module: 'status_center',      action: 'create',            labelKey: 'perm_status_center_create',       dangerous: false },
  { key: 'status_center.edit',                   module: 'status_center',      action: 'edit',              labelKey: 'perm_status_center_edit',         dangerous: false },
  { key: 'status_center.resolve',                module: 'status_center',      action: 'resolve',           labelKey: 'perm_status_center_resolve',      dangerous: false },
  { key: 'exchange_alerts.view',                 module: 'exchange_alerts',    action: 'view',              labelKey: 'perm_exchange_alerts_view',      dangerous: false },
  { key: 'inter_institution_alerts.view',        module: 'inter_institution_alerts', action: 'view',        labelKey: 'perm_inter_institution_alerts_view', dangerous: false },
  { key: 'status_contacts.view',                 module: 'status_contacts',    action: 'view',              labelKey: 'perm_status_contacts_view',      dangerous: false },
  { key: 'status_contacts.manage',               module: 'status_contacts',    action: 'manage',            labelKey: 'perm_status_contacts_manage',    dangerous: false },
  { key: 'deletion_wizard.view',                 module: 'deletion_wizard',    action: 'view',              labelKey: 'perm_deletion_wizard_view',      dangerous: false },
  { key: 'deletion_wizard.clear_port_items',     module: 'deletion_wizard',    action: 'clear_port_items',  labelKey: 'perm_deletion_wizard_clear_port_items',   dangerous: true },
  { key: 'deletion_wizard.archive_port',         module: 'deletion_wizard',    action: 'archive_port',      labelKey: 'perm_deletion_wizard_archive_port',       dangerous: true },
  { key: 'deletion_wizard.archive_organization', module: 'deletion_wizard',    action: 'archive_organization', labelKey: 'perm_deletion_wizard_archive_organization', dangerous: true },
];

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS.map(p => p.key));
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(PERMISSION_KEYS.filter(p => p.dangerous).map(p => p.key));
const ALL_KEYS = PERMISSION_KEYS.map(p => p.key);

export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_KEY_SET.has(key);
}
export function isDangerousPermission(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/** Group catalog by module (for the collapsible UI). */
export function permissionsByModule(): Record<string, PermissionKeyDef[]> {
  const out: Record<string, PermissionKeyDef[]> = {};
  for (const p of PERMISSION_KEYS) (out[p.module] ??= []).push(p);
  return out;
}

// ── Layer 1: role default permissions ────────────────────────────────────────

const VIEWER_DEFAULTS = [
  'dashboard.view', 'organizations.view', 'warehouses.view', 'ports.view',
  'qr.view', 'availability.view', 'status_center.view', 'exchange_alerts.view',
  'inter_institution_alerts.view', 'status_contacts.view',
];

const WAREHOUSE_OFFICER_DEFAULTS = [
  'dashboard.view', 'organizations.view', 'warehouses.view', 'warehouses.manage',
  'ports.view', 'qr.view', 'qr.generate', 'availability.view', 'availability.manage',
  'status_center.view', 'exchange_alerts.view', 'inter_institution_alerts.view',
  'deletion_wizard.view', 'deletion_wizard.clear_port_items', 'deletion_wizard.archive_port',
];

const PORT_OFFICER_DEFAULTS = [
  'dashboard.view', 'organizations.view', 'ports.view', 'ports.edit',
  'qr.view', 'availability.view', 'availability.manage',
  'status_center.view', 'exchange_alerts.view', 'inter_institution_alerts.view',
];

const MONTHLY_STATUS_OFFICER_DEFAULTS = [
  'dashboard.view', 'availability.view',
  'status_center.view', 'status_center.create', 'status_center.edit', 'status_center.resolve',
  'exchange_alerts.view', 'inter_institution_alerts.view',
  'status_contacts.view', 'status_contacts.manage',
];

// Legacy org-admin (hospital_admin) — broad org scope, but NOT platform-level.
const LEGACY_ADMIN_DEFAULTS = [
  'dashboard.view', 'organizations.view', 'organizations.edit',
  'users.view', 'users.create', 'users.assign_role', 'users.manage_permissions',
  'warehouses.view', 'warehouses.manage',
  'ports.view', 'ports.create', 'ports.edit', 'ports.archive',
  'qr.view', 'qr.generate', 'qr.revoke',
  'availability.view', 'availability.manage',
  'status_center.view', 'status_center.create', 'status_center.edit', 'status_center.resolve',
  'exchange_alerts.view', 'inter_institution_alerts.view',
  'status_contacts.view', 'status_contacts.manage',
  'deletion_wizard.view', 'deletion_wizard.clear_port_items', 'deletion_wizard.archive_port',
];

const OFFICIAL_DEFAULTS: Record<OfficialRole, readonly string[]> = {
  super_admin:            ALL_KEYS,
  warehouse_officer:      WAREHOUSE_OFFICER_DEFAULTS,
  port_officer:           PORT_OFFICER_DEFAULTS,
  monthly_status_officer: MONTHLY_STATUS_OFFICER_DEFAULTS,
  viewer:                 VIEWER_DEFAULTS,
};

/** Default permission set for any role string (legacy-aware). */
export function roleDefaults(role: string): Set<string> {
  const n = normalizeRole(role);
  if (n === 'hospital_admin') return new Set(LEGACY_ADMIN_DEFAULTS);
  return new Set(OFFICIAL_DEFAULTS[n]);
}

// ── Layer 2: overrides + effective permissions ───────────────────────────────

/** key → true (grant) | false (deny) | null/absent (inherit role default). */
export type OverrideMap = Record<string, boolean | null>;

export function effectivePermissions(role: string, overrides: OverrideMap = {}): Set<string> {
  const eff = roleDefaults(role);
  for (const [key, val] of Object.entries(overrides)) {
    if (!isValidPermissionKey(key) || val == null) continue;
    if (val) eff.add(key); else eff.delete(key);
  }
  return eff;
}

export function hasPermission(role: string, overrides: OverrideMap, key: string): boolean {
  return effectivePermissions(role, overrides).has(key);
}

/** Reset = clear all overrides (inherit role defaults). */
export function resetToDefaults(): OverrideMap {
  return {};
}

// ── Authority checks (mirrored server-side in migration 010 RPCs) ─────────────

export interface GrantContext {
  actorRole: string;
  actorOverrides?: OverrideMap;
  /** True when actor and target are the same profile (self-edit). */
  isSelf: boolean;
  /** True when actor and target share an organization, or actor is super_admin. */
  sameScope: boolean;
}

export type GrantError =
  | 'UNKNOWN_PERMISSION'
  | 'SELF_ESCALATION'
  | 'OUT_OF_SCOPE'
  | 'CANNOT_GRANT_UNHELD'
  | 'NEEDS_AUTHORITY_FOR_DANGEROUS';

export interface GrantCheck { ok: boolean; error?: GrantError }

const isSuper = (role: string) => normalizeRole(role) === 'super_admin';

/**
 * Can the actor set `key` to `desired` on the target?
 * - unknown keys rejected
 * - no self-escalation (granting yourself a permission)
 * - no acting out of scope (non-super, different org)
 * - cannot grant a permission you do not hold yourself
 * - dangerous permission requires the actor to hold that exact permission
 * Denying (desired=false) is always allowed within scope.
 */
export function canActorSetPermission(ctx: GrantContext, key: string, desired: boolean | null): GrantCheck {
  if (!isValidPermissionKey(key)) return { ok: false, error: 'UNKNOWN_PERMISSION' };
  if (!ctx.sameScope && !isSuper(ctx.actorRole)) return { ok: false, error: 'OUT_OF_SCOPE' };

  // Removing or inheriting a permission is safe (no escalation risk).
  if (desired !== true) return { ok: true };

  // Granting:
  if (ctx.isSelf) return { ok: false, error: 'SELF_ESCALATION' };

  const actorEff = effectivePermissions(ctx.actorRole, ctx.actorOverrides);
  if (!actorEff.has(key)) {
    return { ok: false, error: isDangerousPermission(key) ? 'NEEDS_AUTHORITY_FOR_DANGEROUS' : 'CANNOT_GRANT_UNHELD' };
  }
  return { ok: true };
}

export interface ValidateResult {
  ok: boolean;
  accepted: OverrideMap;
  rejected: { key: string; error: GrantError }[];
}

/** Validate a full requested override map; returns only the accepted subset. */
export function validateOverrides(ctx: GrantContext, requested: OverrideMap): ValidateResult {
  const accepted: OverrideMap = {};
  const rejected: { key: string; error: GrantError }[] = [];
  for (const [key, desired] of Object.entries(requested)) {
    const check = canActorSetPermission(ctx, key, desired);
    if (check.ok) accepted[key] = desired;
    else rejected.push({ key, error: check.error! });
  }
  return { ok: rejected.length === 0, accepted, rejected };
}
