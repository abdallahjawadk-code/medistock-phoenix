/* ─── MEDISTOCK PHOENIX — Scoped RBAC key catalog (migration 062) ─────────────
   The ten permission keys introduced by migration 062 section B, transcribed
   verbatim from the committed SQL. This catalog is DELIBERATELY SEPARATE from
   shared/lib/permissions.ts:

     • permissions.ts drives the user-management permission-matrix UI. Adding
       these keys there would render ten new checkboxes and activate user-scope
       mutations, which this phase explicitly does not do.
     • permissions.ts also feeds the super_admin frontend top-up and
       validateOverrides. Touching it would change LEGACY decisions — and shadow
       mode's whole premise is that the legacy decision is unchanged.

   So: this module is read-only reference data for the scoped-RBAC layer, and
   nothing else reads it. The DATABASE remains authoritative for what a key
   means; this catalog exists to validate call sites and to declare which target
   a key must be asked about.
   ──────────────────────────────────────────────────────────────────────────── */

/** Which resource target the scoped helper expects alongside the key. */
export type ScopeTarget =
  /** Organization-only question (no warehouse/outlet target). */
  | 'organization'
  /** Names a warehouse. */
  | 'warehouse'
  /** Names a distribution point (outlet). */
  | 'distribution_point';

export interface ScopedPermissionKeyDef {
  key: string;
  module: string;
  action: string;
  /** is_dangerous, mirroring migration 062 section B exactly. */
  dangerous: boolean;
  /**
   * The targets this key is legitimately asked about. `organization` means the
   * key answers an org-wide question; a warehouse-targeted key asked with a
   * NULL target fails closed for operational roles by design (062 rule 8).
   */
  targets: readonly ScopeTarget[];
}

/** Migration 062 section B — the exact ten keys, in the SQL's own order. */
export const SCOPED_PERMISSION_KEYS: readonly ScopedPermissionKeyDef[] = [
  { key: 'users.edit_scope',              module: 'users',           action: 'edit_scope',       dangerous: true,  targets: ['organization'] },
  { key: 'users.reset_permissions',       module: 'users',           action: 'reset_permissions',dangerous: true,  targets: ['organization'] },
  { key: 'warehouse_stock.view',          module: 'warehouse_stock', action: 'view',             dangerous: false, targets: ['warehouse'] },
  { key: 'warehouse_stock.adjust',        module: 'warehouse_stock', action: 'adjust',           dangerous: true,  targets: ['warehouse'] },
  { key: 'warehouse_stock.correct',       module: 'warehouse_stock', action: 'correct',          dangerous: true,  targets: ['warehouse'] },
  { key: 'warehouse_stock.movements_view',module: 'warehouse_stock', action: 'movements_view',   dangerous: false, targets: ['warehouse'] },
  { key: 'reports.view',                  module: 'reports',         action: 'view',             dangerous: false, targets: ['organization', 'warehouse', 'distribution_point'] },
  { key: 'reports.financial',             module: 'reports',         action: 'financial',        dangerous: true,  targets: ['organization'] },
  { key: 'reports.export',                module: 'reports',         action: 'export',           dangerous: true,  targets: ['organization'] },
  { key: 'audit.view',                    module: 'audit',           action: 'view',             dangerous: false, targets: ['organization', 'warehouse', 'distribution_point'] },
];

export const SCOPED_PERMISSION_KEY_SET: ReadonlySet<string> = new Set(
  SCOPED_PERMISSION_KEYS.map(k => k.key),
);

export function isScopedPermissionKey(key: string): boolean {
  return SCOPED_PERMISSION_KEY_SET.has(key);
}

export function scopedPermissionDef(key: string): ScopedPermissionKeyDef | null {
  return SCOPED_PERMISSION_KEYS.find(k => k.key === key) ?? null;
}

/* ── Dispatch keys (migration 061) referenced by 062's role defaults ──────────
   Listed here ONLY so the separation-of-duty tests can name them. Migration 062
   explicitly denies warehouse_officer accept/reject and denies port_officer
   create/edit_draft/send/cancel. No dispatch UI exists yet and none is
   activated in this phase. */
export const DISPATCH_PERMISSION_KEYS = [
  'warehouse_dispatch.create',
  'warehouse_dispatch.edit_draft',
  'warehouse_dispatch.send',
  'warehouse_dispatch.cancel',
  'warehouse_dispatch.accept',
  'warehouse_dispatch.reject',
] as const;

/* ── Trigger-only functions (migrations 062/063) ──────────────────────────────
   These are trigger bodies. They take no application-callable argument list and
   invoking them over PostgREST is always a bug. Named here so the static scan in
   __tests__/trigger-function-prohibition.test.ts has a single source of truth. */
export const TRIGGER_ONLY_FUNCTIONS = [
  'phoenix_protect_last_super_admin',
  'phoenix_validate_ppo_scope',
  'phoenix_validate_profile_scope_assignment',
] as const;

/* ── The application-callable helper RPCs (migration 062 section D) ───────────
   Exact names and signatures. Nothing else in this layer may name a DB function
   that is not in this list. */
export const SCOPED_RBAC_RPCS = {
  /** phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid) */
  scopedPermission: 'phoenix_profile_has_scoped_permission',
  /** phoenix_profile_has_warehouse_assignment(uuid, uuid) */
  warehouseAssignment: 'phoenix_profile_has_warehouse_assignment',
  /** phoenix_profile_has_point_assignment(uuid, uuid) */
  pointAssignment: 'phoenix_profile_has_point_assignment',
} as const;
