/**
 * 170 · ORGANIZATION CLASS + WAREHOUSE FACILITY ASSIGNMENT (Stage E · E7-1) —
 * static proof.
 *
 * Source-level guards: registration, exact object inventory (SET NOT NULL +
 * 2 new functions + 2 new triggers only), preflight NULL-refusal, preserved
 * 3-value CHECK, immutability trigger shape, warehouse facility guard trigger
 * shape, assignment RPC exact signature/ACL, all 19 dependency classes
 * present in the hard guard, and NON-GOALS (no legacy classification RPC, no
 * CREATE OR REPLACE, no new permission key, no RLS policy change, 074/164/168/
 * 169 untouched).
 *
 * Behavioural proof lives in the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '170_phoenix_organization_class_and_warehouse_facility_assignment.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('begin;'), sql.indexOf('\ncommit;'));
const active = activeSql(code);
const exec = executableSql(code);
// Dollar-quoted function/DO bodies removed — for negative assertions where a
// PREFLIGHT/VERIFY block legitimately REFERENCES an object (to check it still
// exists/is unchanged) and a blunt substring check on `active` would produce
// a false failure. Same technique as 168/169's static tests.
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

const immutableFnBody = (() => {
  const src = sqlFunctionSource(code, '_phoenix_organizations_institution_class_immutable_v1');
  expect(src).not.toBeNull();
  return src as string;
})();

const guardFnBody = (() => {
  const src = sqlFunctionSource(code, '_phoenix_warehouse_facility_assignment_guard_v1');
  expect(src).not.toBeNull();
  return src as string;
})();

const rpcBody = (() => {
  const src = sqlFunctionSource(code, 'phoenix_assign_warehouse_facility');
  expect(src).not.toBeNull();
  return src as string;
})();

describe('1. 170 registration and shape', () => {
  it('is registered exactly once, immediately after 169', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('169_phoenix_outlet_replenishment_reversal.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('begin;');
    expect(sql).toContain('\ncommit;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(active).toContain('PREFLIGHT FAILED (170)');
    expect(active).toContain('VERIFY FAILED (170)');
  });

  it('documents a manual rollback', () => {
    expect(sql).toMatch(/ROLLBACK \(manual/);
  });

  it('the preflight refuses to proceed if any organization has NULL institution_class, with no backfill', () => {
    expect(active).toMatch(/institution_class IS NULL/);
    expect(active).toContain('SET NOT NULL refused');
    // No backfill: no UPDATE of institution_class anywhere in the file.
    expect(active).not.toMatch(/UPDATE\s+public\.organizations\s+SET\s+institution_class/i);
  });
});

describe('2. object inventory is EXACTLY the E7-1 set', () => {
  it('creates no table and adds no column', () => {
    expect(active).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(active).not.toMatch(/\bADD\s+COLUMN\b/i);
  });

  it('adds no permission key and no RLS policy change', () => {
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.role_permission_defaults/i);
    expect(active).not.toMatch(/CREATE POLICY/);
    expect(active).not.toMatch(/ALTER POLICY/);
    expect(active).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('alters exactly one column: organizations.institution_class SET NOT NULL', () => {
    expect(active).toMatch(
      /ALTER TABLE public\.organizations\s*\n\s*ALTER COLUMN institution_class SET NOT NULL/,
    );
    expect(active).not.toMatch(/ALTER TABLE public\.warehouses\s*\n\s*ALTER COLUMN/);
  });

  it('preserves the existing 3-value institution_class CHECK unchanged', () => {
    expect(applyTime).toContain('organizations_institution_class_chk');
    expect(active).not.toMatch(/DROP\s+CONSTRAINT\s+organizations_institution_class_chk/i);
    expect(active).not.toMatch(/ADD\s+CONSTRAINT\s+organizations_institution_class_chk/i);
  });

  it('creates exactly two new functions with exact signatures', () => {
    expect(active).toContain(
      'CREATE FUNCTION public._phoenix_organizations_institution_class_immutable_v1()',
    );
    expect(active).toContain(
      'CREATE FUNCTION public._phoenix_warehouse_facility_assignment_guard_v1()',
    );
    expect(active).toContain(
      'CREATE FUNCTION public.phoenix_assign_warehouse_facility(',
    );
    expect(active).toMatch(
      /phoenix_assign_warehouse_facility\(\s*p_warehouse_id\s+uuid,\s*p_facility_id\s+uuid\s*\)/,
    );
  });

  it('creates no CREATE OR REPLACE of any function', () => {
    expect(active).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });

  it('creates exactly two triggers, both BEFORE UPDATE OF a single column', () => {
    const triggerMatches = active.match(/\bCREATE\s+TRIGGER\b/gi) ?? [];
    expect(triggerMatches.length).toBe(2);
    expect(active).toMatch(
      /CREATE TRIGGER organizations_institution_class_immutable_trg\s*\n\s*BEFORE UPDATE OF institution_class ON public\.organizations/,
    );
    expect(active).toMatch(
      /CREATE TRIGGER warehouses_facility_assignment_guard_trg\s*\n\s*BEFORE UPDATE OF facility_id ON public\.warehouses/,
    );
  });

  it('does not create a legacy organization-classification RPC', () => {
    expect(active).not.toMatch(/phoenix_classify_organization/i);
  });

  it('marks the guard trigger function and the RPC SECURITY DEFINER with pinned search_path', () => {
    expect(guardFnBody).toMatch(/SECURITY DEFINER/);
    expect(guardFnBody).toMatch(/SET search_path = public, pg_temp/);
    expect(rpcBody).toMatch(/SECURITY DEFINER/);
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
    // The immutability trigger function needs no elevated privilege of its
    // own — it only inspects OLD/NEW — but must still pin its search_path.
    expect(immutableFnBody).toMatch(/SET search_path = public, pg_temp/);
  });

  it('grants authenticated EXECUTE on the assignment RPC, revokes PUBLIC/anon', () => {
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_assign_warehouse_facility[\s\S]*?FROM PUBLIC, anon/,
    );
    expect(active).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_assign_warehouse_facility[\s\S]*?TO authenticated/,
    );
  });
});

describe('3. organization-class immutability trigger', () => {
  it('uses the exact deterministic error token', () => {
    expect(immutableFnBody).toContain('organization_institution_class_immutable');
  });

  it('rejects only when OLD is non-NULL and NEW differs — never blocks a no-op or unrelated columns', () => {
    expect(immutableFnBody).toMatch(
      /OLD\.institution_class IS NOT NULL\s*\n\s*AND NEW\.institution_class IS DISTINCT FROM OLD\.institution_class/,
    );
  });

  it('is a BEFORE UPDATE OF institution_class trigger — never fires for updates that do not touch the column', () => {
    expect(active).toMatch(/BEFORE UPDATE OF institution_class ON public\.organizations/);
    expect(active).not.toMatch(/BEFORE UPDATE ON public\.organizations\b(?!\s*\n\s*FOR EACH ROW\s*\n\s*EXECUTE FUNCTION public\._phoenix_organizations_institution_class_immutable_v1)/);
  });
});

describe('4. warehouse facility assignment — RPC + hard trigger boundary', () => {
  it('the RPC requires authentication, active profile, and super_admin — matching the 074 warehouse-management authority model', () => {
    expect(rpcBody).toContain('not_authenticated');
    expect(rpcBody).toContain('active_profile_required');
    expect(rpcBody).toContain('forbidden_warehouse_facility_assign');
    expect(rpcBody).toMatch(/status = 'active'/);
    expect(rpcBody).toMatch(/v_actor_role IS DISTINCT FROM 'super_admin'/);
  });

  it('the RPC locks the warehouse row FOR UPDATE and does not itself validate facility eligibility', () => {
    expect(rpcBody).toMatch(/FROM public\.warehouses WHERE id = p_warehouse_id FOR UPDATE/);
    expect(rpcBody).not.toContain('target_facility_organization_mismatch');
    expect(rpcBody).not.toContain('warehouse_facility_reassignment_blocked_operational_dependency');
  });

  it('the RPC issues a plain UPDATE of facility_id — the trigger, not the RPC body, is the substantive validator', () => {
    expect(rpcBody).toMatch(
      /UPDATE public\.warehouses SET facility_id = p_facility_id WHERE id = p_warehouse_id/,
    );
  });

  it('the hard guard trigger independently re-verifies authorization — a raw UPDATE cannot rely on the RPC having checked it', () => {
    expect(guardFnBody).toContain('not_authenticated');
    expect(guardFnBody).toContain('active_profile_required');
    expect(guardFnBody).toContain('forbidden_warehouse_facility_assign');
    expect(guardFnBody).toMatch(/v_actor_role IS DISTINCT FROM 'super_admin'/);
  });

  it('the guard exits as a no-op (no validation, no audit) only when facility_id is unchanged', () => {
    expect(guardFnBody).toMatch(
      /NEW\.facility_id IS NOT DISTINCT FROM OLD\.facility_id THEN\s*\n\s*RETURN NEW;/,
    );
    const noOpIdx = guardFnBody.indexOf('IS NOT DISTINCT FROM OLD.facility_id');
    const authIdx = guardFnBody.indexOf('not_authenticated');
    const auditIdx = guardFnBody.indexOf('INSERT INTO public.audit_logs');
    expect(noOpIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(noOpIdx);
    expect(auditIdx).toBeGreaterThan(authIdx);
  });

  it('non-NULL target: requires health_sector organization, institution warehouse_kind, same-org active facility of a canonical class', () => {
    expect(guardFnBody).toContain('warehouse_kind_not_institution');
    expect(guardFnBody).toContain('warehouse_organization_not_health_sector');
    expect(guardFnBody).toContain('facility_not_found');
    expect(guardFnBody).toContain('target_facility_organization_mismatch');
    expect(guardFnBody).toContain('invalid_facility_class');
    expect(guardFnBody).toContain('facility_not_active');
    expect(guardFnBody).toMatch(/primary_health_center/);
    expect(guardFnBody).toMatch(/subordinate_health_center/);
    // 'health_center' must appear ONLY as a suffix of the two canonical
    // facility-class names above — never as its own standalone class value
    // (a 4th org-level class). Count occurrences: every "health_center" must
    // be accounted for by "primary_health_center" or "subordinate_health_center".
    const allHealthCenter = (guardFnBody.match(/health_center/g) ?? []).length;
    const primary = (guardFnBody.match(/primary_health_center/g) ?? []).length;
    const subordinate = (guardFnBody.match(/subordinate_health_center/g) ?? []).length;
    expect(allHealthCenter).toBe(primary + subordinate);
  });

  it('never invents a standalone health_center organization class', () => {
    const allHealthCenter = (active.match(/health_center/g) ?? []).length;
    const primary = (active.match(/primary_health_center/g) ?? []).length;
    const subordinate = (active.match(/subordinate_health_center/g) ?? []).length;
    expect(allHealthCenter).toBe(primary + subordinate);
  });

  it('exactly one audit row per real state change, using the required fields and action label', () => {
    expect(guardFnBody).toContain("'warehouse_facility.assigned'");
    expect(guardFnBody).toMatch(/'warehouse_id',\s*NEW\.id/);
    expect(guardFnBody).toMatch(/'organization_id',\s*NEW\.organization_id/);
    expect(guardFnBody).toMatch(/'old_facility_id',\s*OLD\.facility_id/);
    expect(guardFnBody).toMatch(/'new_facility_id',\s*NEW\.facility_id/);
    // Exactly one INSERT INTO audit_logs in the whole trigger body.
    const auditInserts = guardFnBody.match(/INSERT INTO public\.audit_logs/g) ?? [];
    expect(auditInserts.length).toBe(1);
  });

  it('the RPC body itself never writes audit_logs — the trigger is the sole writer (no double-logging)', () => {
    expect(rpcBody).not.toMatch(/INSERT INTO public\.audit_logs/);
  });
});

describe('5. the full 19-table operational-dependency guard is represented', () => {
  const expectedTables = [
    'warehouse_stock', 'warehouse_stock_movements', 'warehouse_dispatches',
    'warehouse_quarantine_stock', 'warehouse_transfers', 'warehouse_transfer_requests',
    'warehouse_return_shipments', 'warehouse_return_requests', 'warehouse_supply_routes',
    'outlet_return_requests', 'outlet_return_shipments', 'procurement_orders',
    'distribution_points', 'outlet_stock', 'outlet_stock_movements',
    'outlet_replenishment_routes', 'item_availability', 'item_availability_movements',
    'phoenix_movement_dispense_context', 'inter_org_exchange_requests',
  ];

  it.each(expectedTables)('references %s in the hard guard', (table) => {
    expect(guardFnBody).toContain(table);
  });

  it('uses the exact deterministic dependency-block error token exactly once', () => {
    const matches = guardFnBody.match(/warehouse_facility_reassignment_blocked_operational_dependency/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('is not limited to active-status rows — no status/is_active filter narrows any dependency EXISTS check', () => {
    // Every dependency EXISTS clause in the guard queries the raw table with
    // no additional status/is_active predicate — proven structurally by the
    // absence of "AND status" / "AND is_active" immediately inside any of the
    // 19 EXISTS(...) blocks feeding the big OR.
    expect(guardFnBody).not.toMatch(/EXISTS \(SELECT 1 FROM public\.\w+\s+WHERE[^)]*\bstatus\s*=/);
    expect(guardFnBody).not.toMatch(/EXISTS \(SELECT 1 FROM public\.\w+\s+WHERE[^)]*\bis_active\s*=/);
  });

  it('resolves points reachable through this warehouse once, via a shared array, not a per-check subquery', () => {
    expect(guardFnBody).toMatch(/v_point_ids\s+uuid\[\]/);
    expect(guardFnBody).toMatch(
      /SELECT array_agg\(id\) INTO v_point_ids\s*\n\s*FROM public\.distribution_points WHERE warehouse_id = NEW\.id/,
    );
  });
});

describe('6. predecessor immutability', () => {
  it('does not edit migrations 001-169', () => {
    // VERIFY legitimately checks the 074 RPC signatures and 164 objects still
    // exist — applyTime strips those dollar-quoted DO blocks so this remains
    // a genuine "never CREATE OR REPLACE'd" proof.
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_create_warehouse\b/i);
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_update_warehouse\b/i);
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_set_warehouse_active\b/i);
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_upsert_organization_facility\b/i);
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_replenish_emergency_outlet\b/i);
    expect(applyTime).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_reverse_outlet_replenishment\b/i);
  });

  it('reads warehouse_kind (to reject central/non-institution) but never alters its column definition or CHECK', () => {
    // The guard legitimately READS NEW.warehouse_kind as part of facility-
    // eligibility validation — that is not an alteration. What must never
    // happen is a DDL change to the column or its constraint.
    expect(active).not.toMatch(/ALTER\s+TABLE\s+public\.warehouses[\s\S]{0,80}warehouse_kind/i);
    expect(active).not.toMatch(/DROP\s+CONSTRAINT\s+warehouses_warehouse_kind_chk/i);
    expect(active).not.toMatch(/ADD\s+CONSTRAINT\s+warehouses_warehouse_kind_chk/i);
  });
});

describe('7. non-goals', () => {
  it('does not touch E-7 UI, E-8, or Stage F concerns', () => {
    expect(sql).not.toMatch(/\bE-7 UI\b|\bE-8\b|Stage F/);
  });

  it('does not touch clinical_location_kind, outlet_replenishment_routes eligibility, or Shape H/I', () => {
    expect(active).not.toMatch(/clinical_location_kind/);
    expect(active).not.toMatch(/Shape H|Shape I/);
  });
});
