/* ─── Test fixture: an in-memory model of migration 062's helper functions ────
   WHAT THIS IS, PRECISELY: a test double that implements the decision rules
   transcribed from 062 section D, so the tests can drive the AUTHORIZATION
   ENGINE (its shadow comparison, caching, fail-closed paths and reason
   classification) across the full role matrix without a live database.

   WHAT THIS IS NOT: proof that the database behaves this way. That proof lives
   in supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts
   (44/44 canonical) and runs against the real SQL. This file must never become
   the reason someone believes a rule holds — if the two ever disagree, the SQL
   is right and this fixture is wrong.

   It is deliberately NOT imported by any production module: nothing in the
   application duplicates 062's logic, which is the whole point of routing every
   scoped decision through the RPC.
   ──────────────────────────────────────────────────────────────────────────── */

import type { RbacRpcResult, RbacTransport } from '../rbac.service';

export interface FakeProfile {
  id: string;
  role: string;
  status: 'active' | 'suspended' | 'archived';
  organization_id: string | null;
}

export interface FakeResource {
  id: string;
  organization_id: string;
  status: 'active' | 'archived' | 'inactive';
}

export interface FakeAssignment {
  profile_id: string;
  scope_type: 'warehouse' | 'distribution_point';
  organization_id: string;
  warehouse_id?: string;
  distribution_point_id?: string;
  is_active: boolean;
}

export interface FakeDbState {
  profiles: FakeProfile[];
  warehouses: FakeResource[];
  points: FakeResource[];
  assignments: FakeAssignment[];
  /** role → key → allowed. Mirrors role_permission_defaults. */
  roleDefaults: Record<string, Record<string, boolean>>;
  /** profileId → key → true(allow) | false(deny) | null(inherit). */
  overrides: Record<string, Record<string, boolean | null>>;
}

/** 062's v_org_wide_roles, verbatim. */
export const ORG_WIDE_ROLES = [
  'institution_admin', 'hospital_admin', 'monthly_status_officer', 'viewer',
] as const;

export function createFakeDb(state: Partial<FakeDbState> = {}) {
  const db: FakeDbState = {
    profiles: [], warehouses: [], points: [], assignments: [],
    roleDefaults: {}, overrides: {},
    ...state,
  };

  const profile = (id: string | null) => db.profiles.find(p => p.id === id) ?? null;

  /** Migration 017's phoenix_profile_has_permission: override, then default, then false. */
  function hasGlobalPermission(profileId: string, key: string): boolean {
    const p = profile(profileId);
    if (!p) return false;
    const ov = db.overrides[profileId]?.[key];
    if (ov === true)  return true;
    if (ov === false) return false;
    return db.roleDefaults[p.role]?.[key] ?? false;
  }

  /** 062 D1 — phoenix_profile_has_warehouse_assignment. */
  function hasWarehouseAssignment(profileId: string, warehouseId: string): boolean {
    const p = profile(profileId);
    const w = db.warehouses.find(x => x.id === warehouseId);
    if (!p || !w) return false;
    return db.assignments.some(a =>
      a.profile_id === profileId &&
      a.warehouse_id === warehouseId &&
      a.scope_type === 'warehouse' &&
      a.is_active &&
      p.status === 'active' &&
      w.status === 'active' &&
      a.organization_id === p.organization_id &&
      a.organization_id === w.organization_id,
    );
  }

  /** 062 D1 — phoenix_profile_has_point_assignment. */
  function hasPointAssignment(profileId: string, pointId: string): boolean {
    const p = profile(profileId);
    const d = db.points.find(x => x.id === pointId);
    if (!p || !d) return false;
    return db.assignments.some(a =>
      a.profile_id === profileId &&
      a.distribution_point_id === pointId &&
      a.scope_type === 'distribution_point' &&
      a.is_active &&
      p.status === 'active' &&
      d.status === 'active' &&
      a.organization_id === p.organization_id &&
      a.organization_id === d.organization_id,
    );
  }

  /** 062 D2 — phoenix_profile_has_scoped_permission. Rule order preserved. */
  function hasScopedPermission(
    profileId: string | null,
    key: string | null,
    orgId: string | null,
    warehouseId: string | null,
    pointId: string | null,
  ): boolean {
    // Rule 1
    if (!profileId || !key || key.trim() === '') return false;
    const p = profile(profileId);
    if (!p) return false;
    // Rule 2 — before the super_admin branch: a disabled super_admin is disabled.
    if (p.status !== 'active') return false;
    // Rule 3
    if (p.role === 'super_admin') return true;
    // Rule 7 — both targets is a caller bug; the only safe answer is false.
    if (warehouseId && pointId) return false;
    // Rule 4 — organization isolation, before the permission check.
    if (!p.organization_id) return false;
    if (!orgId || orgId !== p.organization_id) return false;
    if (!hasGlobalPermission(profileId, key)) return false;

    const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(p.role);

    // Rule 5
    if (warehouseId) {
      const w = db.warehouses.find(x =>
        x.id === warehouseId && x.organization_id === orgId && x.status === 'active');
      if (!w) return false;
      if (orgWide) return true;
      return hasWarehouseAssignment(profileId, warehouseId);
    }

    // Rule 6
    if (pointId) {
      const d = db.points.find(x =>
        x.id === pointId && x.organization_id === orgId && x.status === 'active');
      if (!d) return false;
      if (orgWide) return true;
      return hasPointAssignment(profileId, pointId);
    }

    // Rule 8 — omitting the resource is never more permissive than naming one.
    return orgWide;
  }

  return { db, hasGlobalPermission, hasWarehouseAssignment, hasPointAssignment, hasScopedPermission };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

export interface FakeTransportOptions {
  /** Force every call to fail, to exercise the fail-closed paths. */
  failWith?: 'MISSING_FUNCTION' | 'NETWORK_ERROR' | 'RPC_ERROR' | 'NOT_CONFIGURED';
  /** Counts every RPC issued — used by the cache/dedup tests. */
  onCall?: (fn: string) => void;
}

export function createFakeTransport(fake: FakeDb, opts: FakeTransportOptions = {}): RbacTransport {
  const guard = (fn: string): RbacRpcResult | null => {
    opts.onCall?.(fn);
    return opts.failWith ? { ok: false, error: opts.failWith } : null;
  };

  return {
    async hasScopedPermission({ profileId, permissionKey, organizationId, warehouseId, distributionPointId }) {
      const failed = guard('scoped');
      if (failed) return failed;
      return {
        ok: true,
        allowed: fake.hasScopedPermission(
          profileId, permissionKey, organizationId, warehouseId, distributionPointId,
        ),
      };
    },
    async hasWarehouseAssignment(profileId, warehouseId) {
      const failed = guard('warehouse_assignment');
      if (failed) return failed;
      return { ok: true, allowed: fake.hasWarehouseAssignment(profileId, warehouseId) };
    },
    async hasPointAssignment(profileId, pointId) {
      const failed = guard('point_assignment');
      if (failed) return failed;
      return { ok: true, allowed: fake.hasPointAssignment(profileId, pointId) };
    },
  };
}
