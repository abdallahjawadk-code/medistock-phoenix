/**
 * 181 · HEALTH-SECTOR TOPOLOGY RECONCILIATION + HARDENING (R1.1) — static proof.
 *
 * Source-level guards that need no database: registration, the exact object
 * inventory, and — heavily — the NON-GOALS. R1.1 owns topology and nothing
 * else, so the assertions here are weighted toward what must be ABSENT: no unit
 * domain, no Production identifier, no supply-route architecture, no change to
 * Migration 180's supply semantics, no reinterpretation of legacy central
 * supply.
 *
 * Behavioural proof (the A-L matrix, reconciliation, guards, Branch B) lives in
 * the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '181_phoenix_health_sector_topology_reconciliation.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');
/** Comments removed — absence claims must read code, not documentation. */
const bare = activeSql(code);
const applyBare = activeSql(applyTime);

const section = (from: string, to: string) => {
  const a = bare.indexOf(from);
  const b = to ? bare.indexOf(to, a) : bare.length;
  expect(a, `section start not found: ${from}`).toBeGreaterThan(-1);
  return bare.slice(a, b > a ? b : bare.length);
};

describe('181 registration and shape', () => {
  it('is registered exactly once, immediately after 180', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('180_phoenix_emergency_initial_provisioning_boundary.sql');
  });

  it('is the LAST registered migration — no 182 exists', () => {
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NAME);
    expect(REVIEWED_MIGRATION_FILES.some(f => /^18[2-9]_|^19\d_|^[2-9]\d\d_/.test(f))).toBe(false);
  });

  it('is a single transaction, manual-apply only, through Supabase.apply_migration', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
    expect(sql).toContain('Supabase.apply_migration');
    expect(sql).toMatch(/`supabase db push` remains forbidden outright/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(code).toContain('181_precondition_failed');
    expect(code).toContain('VERIFY FAILED (181)');
  });
});

describe('181 carries no Production identity', () => {
  it('hard-codes no UUID at all', () => {
    // Any 8-4-4-4-12 literal would be a Production or fixture identifier.
    const uuids = bare.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi) ?? [];
    expect(uuids).toEqual([]);
  });

  it('selects health sectors structurally, never by name', () => {
    expect(bare).toContain("institution_class = 'health_sector'");
    // No Arabic organization/facility/warehouse name is used as a selector.
    expect(bare).not.toMatch(/قطاع الحلة/);
    expect(bare).not.toMatch(/مركز شهيد/);
    expect(bare).not.toMatch(/وحدة المذخر/);
    expect(bare).not.toMatch(/صيدلية المركز/);
    expect(bare).not.toMatch(/organizations[\s\S]{0,60}\bname\s*=/);
  });

  it('the only business-visible literal it writes is the canonical sector-main label', () => {
    expect(bare).toContain("'Sector Main Depot', 'مذخر القطاع الرئيسي'");
  });
});

describe('181 object inventory is exactly the topology set', () => {
  it('creates exactly the topology guards and the one centre-depot writer', () => {
    const created = [...bare.matchAll(/CREATE FUNCTION (public\.[a-z_0-9]+)/g)].map(m => m[1]).sort();
    expect(created).toEqual([
      'public._phoenix_health_center_facility_shape_guard_v1',
      'public._phoenix_health_sector_main_presence_guard_v1',
      'public._phoenix_health_sector_organization_activation_guard_v1',
      'public._phoenix_health_sector_outlet_reassignment_guard_v1',
      'public._phoenix_health_sector_outlet_topology_guard_v1',
      'public._phoenix_health_sector_warehouse_shape_guard_v1',
      'public.phoenix_create_health_center_warehouse',
    ]);
  });

  it('replaces NO existing function', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });

  it('creates exactly one index, and it is the per-facility depot rule', () => {
    const idx = [...bare.matchAll(/CREATE (UNIQUE )?INDEX ([a-z_]+)/g)];
    expect(idx.length).toBe(1);
    expect(idx[0][1]).toBe('UNIQUE ');
    expect(idx[0][2]).toBe('warehouses_one_active_depot_per_facility_uniq');
    expect(code).toMatch(/WHERE facility_id IS NOT NULL AND status = 'active'/);
  });

  it('creates no table, column, constraint, policy, type or sequence', () => {
    expect(applyBare).not.toMatch(/\bCREATE\s+(TABLE|SEQUENCE|TYPE|POLICY|VIEW|MATERIALIZED)\b/i);
    expect(applyBare).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(applyBare).not.toMatch(/\bADD\s+(COLUMN|CONSTRAINT)\b/i);
  });

  it('drops nothing', () => {
    expect(bare).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION|POLICY|TRIGGER)\b/i);
  });

  it('attaches exactly the topology triggers, one of them a DEFERRED constraint trigger', () => {
    const trg = [...bare.matchAll(/CREATE (CONSTRAINT )?TRIGGER ([a-z_]+)/g)].map(m => ({ c: Boolean(m[1]), n: m[2] }));
    expect(trg.map(x => x.n).sort()).toEqual([
      'distribution_points_health_sector_topology_trg',
      'distribution_points_reassignment_guard_trg',
      'organization_facilities_health_center_shape_guard_trg',
      'organizations_health_sector_activation_guard_trg',
      'warehouses_health_sector_main_presence_trg',
      'warehouses_health_sector_shape_guard_trg',
    ]);
    expect(trg.filter(x => x.c).map(x => x.n)).toEqual(['warehouses_health_sector_main_presence_trg']);
    expect(code).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
  });
});

describe('181 the warehouse hard boundary', () => {
  const guard = () => section(
    'CREATE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1',
    'CREATE TRIGGER warehouses_health_sector_shape_guard_trg');

  it('applies only inside a health sector', () => {
    expect(guard()).toMatch(/IF v_class IS DISTINCT FROM 'health_sector' THEN\s*RETURN NEW;/);
  });

  it('A · forbids any non-institution kind', () => {
    expect(guard()).toContain('health_sector_warehouse_must_be_institution');
  });

  it('B · a facility-less active warehouse must be the sector main', () => {
    expect(guard()).toContain('health_sector_facility_less_warehouse_must_be_main');
  });

  it('C · a centre depot must never be main', () => {
    expect(guard()).toContain('health_center_depot_must_not_be_main');
  });

  it('D · the facility must be an active health centre of the same organization', () => {
    for (const e of [
      'health_center_facility_not_found',
      'health_center_facility_organization_mismatch',
      'invalid_health_center_facility_class',
      'health_center_facility_not_active',
    ]) expect(guard(), e).toContain(e);
    expect(guard()).toContain("'primary_health_center', 'subordinate_health_center'");
  });

  it('covers the WHOLE mutation surface, not just facility_id', () => {
    expect(code).toMatch(
      /BEFORE INSERT OR UPDATE OF organization_id, warehouse_kind, facility_id, is_main, status\s*\n\s*ON public\.warehouses/,
    );
  });

  it('cannot deactivate a centre depot underneath an active outlet', () => {
    expect(guard()).toContain('health_center_depot_deactivation_blocked_by_active_outlet');
    expect(guard()).toContain('FROM public.distribution_points dp');
  });

  it('I · the organization-level rule keeps a sector from losing its only main', () => {
    const presence = section(
      'CREATE FUNCTION public._phoenix_health_sector_main_presence_guard_v1',
      'CREATE CONSTRAINT TRIGGER');
    expect(presence).toContain('health_sector_must_retain_a_sector_main');
    expect(presence).toContain('health_sector_has_multiple_sector_mains');
    expect(presence).toContain('ARRAY[OLD.organization_id, NEW.organization_id]');
    // DELETE is a loss route too.
    expect(code).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.warehouses/);
  });

  it('H · preserves the pre-existing one-active-main-per-org index', () => {
    expect(bare).not.toMatch(/DROP INDEX[\s\S]{0,80}warehouses_one_active_main_per_org_uniq/);
    expect(code).toContain('warehouses_one_active_main_per_org_uniq was dropped');
  });
});

describe('181 organization activation boundary', () => {
  const guard = () => section(
    'CREATE FUNCTION public._phoenix_health_sector_organization_activation_guard_v1',
    'CREATE TRIGGER organizations_health_sector_activation_guard_trg');

  it('cannot reactivate a health sector into an invalid live topology', () => {
    expect(guard()).toContain("NEW.status = 'active'");
    expect(guard()).toContain('health_sector_activation_requires_valid_topology');
    expect(code).toMatch(/BEFORE UPDATE OF status\s*\n\s*ON public\.organizations/);
  });
});

describe('181 the outlet hard boundary', () => {
  const guard = () => section(
    'CREATE FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1',
    'CREATE TRIGGER distribution_points_health_sector_topology_trg');

  it('an active outlet must hang off a facility-bound centre depot', () => {
    expect(guard()).toContain('health_sector_outlet_requires_health_center_depot');
    expect(guard()).toMatch(/IF v_wh\.facility_id IS NULL THEN/);
    expect(guard()).toMatch(/v_wh\.status IS DISTINCT FROM 'active'/);
    expect(guard()).toMatch(/v_wh\.warehouse_kind IS DISTINCT FROM 'institution'/);
    expect(guard()).toMatch(/v_wh\.is_main IS NOT FALSE/);
  });

  it('forbids a rescue cart, and any type outside pharmacy/crash_cabinet', () => {
    expect(guard()).toContain('health_center_rescue_cart_not_permitted');
    expect(guard()).toContain('health_center_outlet_type_not_permitted');
    expect(guard()).toContain("NEW.point_type NOT IN ('pharmacy', 'crash_cabinet')");
  });

  it('requires an emergency context for a crash cabinet ONLY', () => {
    expect(guard()).toContain('health_center_crash_cabinet_requires_emergency_context');
    // An ordinary centre pharmacy must NOT acquire a fabricated requirement:
    // the only clinical-context test is the crash-cabinet one.
    const clinical = [...guard().matchAll(/clinical_location_kind/g)];
    expect(clinical.length).toBe(1);
    expect(guard()).toMatch(/NEW\.point_type = 'crash_cabinet'\s*\n?\s*AND NEW\.clinical_location_kind IS DISTINCT FROM 'emergency'/);
  });

  it('covers the WHOLE mutation surface', () => {
    expect(code).toMatch(
      /BEFORE INSERT OR UPDATE OF warehouse_id, organization_id, point_type, clinical_location_kind, status\s*\n\s*ON public\.distribution_points/,
    );
  });
});

describe('181 the facility-side hard boundary', () => {
  const guard = () => section(
    'CREATE FUNCTION public._phoenix_health_center_facility_shape_guard_v1',
    'CREATE TRIGGER organization_facilities_health_center_shape_guard_trg');

  it('prevents a live centre depot being invalidated through its facility row', () => {
    expect(guard()).toContain("NEW.facility_class NOT IN ('primary_health_center', 'subordinate_health_center')");
    expect(guard()).toContain("NEW.status IS DISTINCT FROM 'active'");
    expect(guard()).toContain('health_center_facility_change_blocked_by_active_depot');
  });

  it('covers every parent-field mutation that can invalidate a depot', () => {
    expect(code).toMatch(
      /BEFORE UPDATE OF organization_id, facility_class, status\s*\n\s*ON public\.organization_facilities/,
    );
  });
});

describe('181 the cross-centre reassignment guard', () => {
  const guard = () => section(
    'CREATE FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1',
    'CREATE TRIGGER distribution_points_reassignment_guard_trg');

  it('fires only on a genuine semantic change', () => {
    expect(guard()).toMatch(/IF NOT v_cross_centre AND NOT v_retyped THEN\s*RETURN NEW;/);
    // A move within the SAME facility is not a cross-centre move.
    expect(guard()).toContain('v_old_facility IS DISTINCT FROM v_new_facility');
  });

  it('reuses Migration 170s lock-upgrade technique against write skew', () => {
    expect(guard()).toContain('FOR UPDATE');
    // The citation itself is a comment, so it is asserted against `code`.
    expect(code).toMatch(/170:328-350/);
  });

  it('checks every dependency the catalogue actually has', () => {
    for (const table of [
      'outlet_stock',
      'outlet_stock_movements',
      'warehouse_dispatches',
      'outlet_replenishment_routes',
      'outlet_return_requests',
      'outlet_return_shipments',
      'item_availability',
      'item_availability_movements',
      'phoenix_movement_dispense_context',
      'inter_org_exchange_requests',
      'profile_scope_assignments',
      'profile_permission_overrides',
    ]) expect(guard(), table).toContain(table);
  });

  it('names which dependency blocked, and distinguishes the two reasons', () => {
    expect(guard()).toContain('outlet_cross_center_reassignment_blocked_operational_dependency');
    expect(guard()).toContain('outlet_point_type_change_blocked_operational_dependency');
    expect(guard()).toContain('array_to_string(v_blockers');
  });
});

describe('181 reconciliation is fail-closed', () => {
  it('recognises the three classifications', () => {
    expect(sql).toContain('TARGET_READY');
    expect(sql).toContain('SAFE_LEGACY_RECONCILABLE');
    expect(sql).toContain('AMBIGUOUS_STOP');
  });

  it('stops rather than guessing on every ambiguous shape', () => {
    for (const s of [
      'active central warehouse',
      'active sector-level warehouses',
      'active main warehouses',
      'more than one active depot',
      'invalid or inactive facility',
      'active sector-level outlet',
      'active rescue cart',
      'without an emergency clinical context',
      'unrecognised topology',
    ]) expect(code, s).toContain(s);
    expect([...code.matchAll(/181_ambiguous_stop/g)].length).toBeGreaterThanOrEqual(9);
  });

  it('demotes BEFORE inserting, with no commit boundary between', () => {
    const demote = code.indexOf('UPDATE public.warehouses SET is_main = false');
    const insert = code.indexOf('INSERT INTO public.warehouses (\n        organization_id, name, name_ar, warehouse_kind, facility_id, is_main, status');
    expect(demote).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(demote);
    // Exactly one BEGIN/COMMIT pair in the whole file.
    expect([...sql.matchAll(/^BEGIN;$/gm)].length).toBe(1);
    expect([...sql.matchAll(/^COMMIT;$/gm)].length).toBe(1);
  });

  it('locks the organization and its warehouses deterministically', () => {
    expect(code).toContain('FROM public.organizations WHERE id = v_org.id FOR SHARE');
    expect(code).toContain('FROM public.organization_facilities WHERE organization_id = v_org.id ORDER BY id FOR SHARE');
    expect(code).toContain('WHERE organization_id = v_org.id ORDER BY id FOR UPDATE');
  });

  it('moves no stock and creates no ledger row', () => {
    expect(bare).not.toMatch(/INSERT INTO public\.(warehouse|outlet)_stock/);
    expect(bare).not.toMatch(/UPDATE public\.(warehouse|outlet)_stock/);
    expect(bare).not.toMatch(/DELETE FROM public\./);
    // Apply-time DDL may NAME distribution_points (CREATE TRIGGER ... ON), but
    // must never write a row of it.
    expect(applyBare).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.distribution_points/);
  });
});

describe('181 the centre-depot creation contract', () => {
  const rpc = () => section(
    'CREATE FUNCTION public.phoenix_create_health_center_warehouse',
    'REVOKE ALL ON FUNCTION public.phoenix_create_health_center_warehouse');

  it('keeps the historical super_admin warehouse-management authority', () => {
    expect(rpc()).toContain('not_authenticated');
    expect(rpc()).toContain('active_profile_required');
    expect(rpc()).toContain("v_role IS DISTINCT FROM 'super_admin'");
    expect(rpc()).toContain('NOT_AUTHORIZED_WAREHOUSE_MANAGE');
  });

  it('validates organization class, facility ownership, class, status and uniqueness', () => {
    for (const e of [
      'center_depot_requires_health_sector',
      'health_center_facility_not_found',
      'health_center_facility_organization_mismatch',
      'invalid_health_center_facility_class',
      'health_center_facility_not_active',
      'health_center_already_has_an_active_depot',
    ]) expect(rpc(), e).toContain(e);
  });

  it('creates exactly the canonical centre-depot shape', () => {
    expect(rpc()).toMatch(/'institution', p_facility_id, false, v_code, 'active'/);
  });

  it('is authenticated-callable and never anon', () => {
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_create_health_center_warehouse(uuid, uuid, text, text, text)\n  TO authenticated;');
    expect(code).toContain('FROM PUBLIC, anon;');
  });

  it('leaves phoenix_create_warehouse and phoenix_assign_warehouse_facility untouched', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_create_warehouse\b/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_assign_warehouse_facility/);
  });

  it('every internal guard is revoked from all client-presentable roles', () => {
    for (const fn of [
      '_phoenix_health_sector_warehouse_shape_guard_v1',
      '_phoenix_health_sector_main_presence_guard_v1',
      '_phoenix_health_sector_outlet_topology_guard_v1',
      '_phoenix_health_sector_outlet_reassignment_guard_v1',
      '_phoenix_health_center_facility_shape_guard_v1',
      '_phoenix_health_sector_organization_activation_guard_v1',
    ]) {
      expect(code, fn).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}()\n  FROM PUBLIC, anon, authenticated, service_role;`);
    }
  });
});

describe('181 sector-main presence guard', () => {
  it('does not force a main onto a sector with no active warehouses', () => {
    const guard = section(
      'CREATE FUNCTION public._phoenix_health_sector_main_presence_guard_v1',
      'CREATE CONSTRAINT TRIGGER health_sector_main_presence_guard_v1');
    expect(guard).toMatch(/IF v_active = 0 THEN\s+CONTINUE;/);
  });
});

describe('181 NON-GOALS', () => {
  it('creates no unit domain, in any spelling', () => {
    // Scoped to apply-time DDL: the verify block deliberately NAMES these
    // tables in order to assert they do not exist, so searching the whole file
    // would test the guard instead of the schema.
    for (const forbidden of ['health_center_unit', 'unit_stock', 'unit_routes', 'unit_scopes']) {
      expect(applyBare, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain('a unit domain was created');
  });

  it('creates no supply route and does not touch route architecture', () => {
    expect(bare).not.toMatch(/INSERT INTO public\.warehouse_supply_routes/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_supply_route_assert_endpoints/);
    expect(code).toContain('a warehouse_supply_route was created for a health sector');
  });

  it('does not modify Branch B or the legacy central corridor', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_assert_direct_supply_endpoints/);
    expect(code).toContain('Branch B was modified');
  });

  it('does not touch Migration 180 supply semantics', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\._phoenix_180_delegate/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_replenish_emergency_outlet/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_create_initial_provisioning_dispatch/);
    expect(code).toContain("Migration 180''s emergency boundary was disturbed");
    expect(code).toContain("Migration 180''s initial-first replenishment gate was disturbed");
  });

  it('keeps exactly two stock truths', () => {
    expect(code).toContain('a second balance ledger exists');
  });

  it('encodes no Production reset', () => {
    expect(bare).not.toMatch(/TRUNCATE/i);
    expect(bare).not.toMatch(/DELETE FROM/i);
  });
});
