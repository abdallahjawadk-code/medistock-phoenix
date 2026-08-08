/**
 * 168 · ATOMIC EMERGENCY OUTLET REPLENISHMENT (Stage E · E-5) — static proof.
 *
 * Source-level guards: registration, exact object inventory, Addendum-F
 * movement-time revalidation presence, lock-order structure, fingerprint
 * contract, and NON-GOALS (no E-6 execution, no E-7 UI, no E-4/167 edits,
 * no new tables/columns/permission keys/RLS, no withdrawn warehouse-equality).
 *
 * Behavioural proof lives in the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '168_phoenix_atomic_emergency_outlet_replenishment.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));
const active = activeSql(code);
const exec = executableSql(code);

const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');
const bare = code.replace(/--[^\n]*/g, '');

const rpcBody = (() => {
  const start = code.indexOf('CREATE FUNCTION public.phoenix_replenish_emergency_outlet');
  expect(start).toBeGreaterThan(-1);
  const bodyStart = code.indexOf('AS $$', start);
  const bodyEnd = code.indexOf('$$;', bodyStart);
  return code.slice(bodyStart, bodyEnd);
})();

describe('1. 168 registration and shape', () => {
  it('is registered exactly once, immediately after 167', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('167_phoenix_dispatch_line_full_rejection_reconciliation.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(active).toContain('PREFLIGHT FAILED (168)');
    expect(active).toContain('VERIFY FAILED (168)');
  });

  it('documents a manual rollback', () => {
    expect(sql).toMatch(/ROLLBACK \(manual\)/);
  });
});

describe('2. object inventory is exactly the E-5 set', () => {
  it('creates no table and adds no column', () => {
    expect(applyTime).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(applyTime).not.toMatch(/\bADD\s+COLUMN\b/i);
  });

  it('widens outlet_stock_movements_type_chk preserving priors and adding exactly E-5 types', () => {
    expect(active).toContain('DROP CONSTRAINT outlet_stock_movements_type_chk');
    expect(active).toContain('ADD CONSTRAINT outlet_stock_movements_type_chk');
    for (const t of [
      'set_exact', 'add', 'subtract', 'correction',
      'reserve', 'release', 'dispatch_receive', 'dispense', 'return_send',
      'replenish_send', 'replenish_receive',
    ]) {
      expect(active).toContain(`'${t}'`);
    }
  });

  it('creates exactly the forward once-index with exact columns + predicate', () => {
    expect(active).toMatch(
      /CREATE UNIQUE INDEX outlet_stock_movements_replenishment_once_uniq/,
    );
    expect(active).toMatch(
      /ON public\.outlet_stock_movements \(reference_id, movement_type\)/,
    );
    expect(active).toMatch(
      /WHERE reference_type = 'outlet_replenishment' AND reference_id IS NOT NULL/,
    );
    // E-6 owns the reversal once-index.
    expect(applyTime).not.toContain('outlet_stock_movements_replenishment_reversal_once_uniq');
  });

  it('creates osm_replenishment_fingerprint_chk with the exact V4 §14 predicate', () => {
    expect(active).toContain('ADD CONSTRAINT osm_replenishment_fingerprint_chk');
    expect(active).toMatch(
      /reference_type NOT IN \('outlet_replenishment', 'outlet_replenishment_reversal'\)/,
    );
    expect(active).toMatch(
      /request_fingerprint IS NOT NULL AND request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/,
    );
  });

  it('creates fingerprint helper + public RPC with exact signatures', () => {
    expect(active).toContain(
      'CREATE FUNCTION public._phoenix_replenishment_fingerprint_v1(',
    );
    expect(active).toContain(
      'CREATE FUNCTION public.phoenix_replenish_emergency_outlet(',
    );
    expect(active).toMatch(
      /_phoenix_replenishment_fingerprint_v1\(\s*p_route_id\s+uuid,\s*p_source_outlet_stock_id\s+uuid,\s*p_quantity\s+integer,\s*p_fefo_override_reason\s+text,\s*p_notes\s+text/,
    );
    expect(active).toMatch(
      /phoenix_replenish_emergency_outlet\(\s*p_request_id\s+uuid,\s*p_route_id\s+uuid,\s*p_source_outlet_stock_id\s+uuid,\s*p_quantity\s+integer,\s*p_fefo_override_reason\s+text(?:\s+DEFAULT\s+NULL)?,\s*p_notes\s+text(?:\s+DEFAULT\s+NULL)?/,
    );
  });

  it('marks both functions SECURITY DEFINER with pinned search_path', () => {
    expect(active).toMatch(
      /_phoenix_replenishment_fingerprint_v1[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public, pg_temp/,
    );
    expect(active).toMatch(
      /phoenix_replenish_emergency_outlet[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public, pg_temp/,
    );
  });

  it('revokes authenticated EXECUTE on the helper and grants it on the public RPC', () => {
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_replenishment_fingerprint_v1[\s\S]*?FROM PUBLIC, anon, authenticated/,
    );
    expect(active).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_replenish_emergency_outlet[\s\S]*?TO authenticated/,
    );
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_replenish_emergency_outlet[\s\S]*?FROM PUBLIC, anon/,
    );
  });
});

describe('3. RPC contract — revalidation, locks, ledger, RBAC', () => {
  it('authorizes via existing outlet_stock.replenish only', () => {
    expect(rpcBody).toContain("outlet_stock.replenish");
    expect(rpcBody).not.toContain('permission_keys');
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
  });

  it('uses Addendum-F movement-time revalidation (not route.is_active alone)', () => {
    expect(rpcBody).toContain('_phoenix_outlet_facility_context_v1');
    expect(rpcBody).toContain('cross_facility_route_forbidden');
    expect(rpcBody).toContain('health_center_route_requires_facility');
    expect(rpcBody).toContain('health_center_rescue_cart_forbidden');
    expect(rpcBody).toContain('rescue_cart_requires_hospital');
    expect(rpcBody).toContain('crash_cabinet_requires_non_emergency_context');
    expect(rpcBody).toContain('facility_not_permitted_for_this_institution_class');
    expect(rpcBody).toContain('route_not_active');
    expect(rpcBody).toContain('source_outlet_inactive');
    expect(rpcBody).toContain('destination_outlet_inactive');
  });

  it('does NOT use the withdrawn warehouse-equality rule', () => {
    expect(rpcBody).not.toContain('warehouse_id_equality');
    expect(rpcBody).not.toContain('same_warehouse_required');
    expect(rpcBody).not.toMatch(/source\.warehouse_id\s*=\s*destination\.warehouse_id/);
  });

  it('acquires locks in the binding order: advisory → route SHARE → points SHARE → stocks UPDATE', () => {
    const adv = rpcBody.indexOf('pg_advisory_xact_lock');
    const routeLock = rpcBody.search(
      /FROM public\.outlet_replenishment_routes[\s\S]{0,120}FOR SHARE/,
    );
    const pointLock = rpcBody.search(
      /FROM public\.distribution_points[\s\S]{0,80}FOR SHARE/,
    );
    const stockLock = rpcBody.search(
      /FROM public\.outlet_stock[\s\S]{0,80}FOR UPDATE/,
    );
    expect(adv).toBeGreaterThan(-1);
    expect(routeLock).toBeGreaterThan(adv);
    expect(pointLock).toBeGreaterThan(routeLock);
    expect(stockLock).toBeGreaterThan(pointLock);
    expect(rpcBody).toContain('hashtextextended(p_request_id::text, 168168)');
  });

  it('creates exactly replenish_send + replenish_receive with forward reference/reason', () => {
    expect(rpcBody).toContain("'replenish_send'");
    expect(rpcBody).toContain("'replenish_receive'");
    expect(rpcBody).toContain("'outlet_replenishment'");
    expect(rpcBody).toContain("'transferred'");
    expect(rpcBody).not.toContain('phoenix_reverse_outlet_replenishment');
    expect(rpcBody).not.toContain("'outlet_replenishment_reversal'");
  });

  it('uses existing FEFO helper and projects availability on both sides', () => {
    expect(rpcBody).toContain('phoenix_inventory_fefo_batches');
    expect(rpcBody).toContain('phoenix_project_outlet_availability');
  });

  it('enforces active-profile + outlet_stock.replenish BEFORE any idempotent replay return', () => {
    // Independent review finding (PR #109): a SECURITY DEFINER replay must
    // never return success before current authorization. Structurally prove
    // the permission and active-profile gates precede the replay return.
    const replayReturn = rpcBody.indexOf("'idempotent_replay', true");
    const permissionGate = rpcBody.indexOf('phoenix_profile_has_scoped_permission');
    const profileGate = rpcBody.indexOf('active_profile_required');
    expect(replayReturn).toBeGreaterThan(-1);
    expect(permissionGate).toBeGreaterThan(-1);
    expect(profileGate).toBeGreaterThan(-1);
    expect(permissionGate).toBeLessThan(replayReturn);
    expect(profileGate).toBeLessThan(replayReturn);
    // The route share-lock (authorization scope source) also precedes it.
    const routeLock = rpcBody.search(
      /FROM public\.outlet_replenishment_routes[\s\S]{0,120}FOR SHARE/,
    );
    expect(routeLock).toBeGreaterThan(-1);
    expect(routeLock).toBeLessThan(replayReturn);
  });

  it('implements fingerprint idempotency without a dedup table', () => {
    expect(rpcBody).toContain('_phoenix_replenishment_fingerprint_v1');
    expect(rpcBody).toContain('request_id_conflict');
    expect(rpcBody).toContain('idempotent_replay');
    expect(applyTime).not.toMatch(/CREATE\s+TABLE/i);
  });
});

describe('4. non-goals — nothing outside E-5', () => {
  it('adds no permission key, role default, or RLS policy', () => {
    expect(applyTime).not.toContain('permission_keys');
    expect(applyTime).not.toContain('role_permission_defaults');
    expect(bare).not.toMatch(/CREATE POLICY/);
    expect(bare).not.toMatch(/ALTER POLICY/);
    expect(bare).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('does not implement E-6 reversal execution', () => {
    expect(applyTime).not.toContain('phoenix_reverse_outlet_replenishment');
    expect(applyTime).not.toContain('phoenix_outlet_replenishment_reversible_batches');
    expect(applyTime).not.toContain('outlet_stock_movements_replenishment_reversal_once_uniq');
  });

  it('does not implement E-7 UI / client services', () => {
    expect(sql).not.toMatch(/DispenseContext|ReplenishComposer|useReplenish/i);
    expect(applyTime).not.toMatch(/\bsrc\//);
  });

  it('does not touch E-4 initial-provisioning state or 167 decision CHECK', () => {
    expect(rpcBody).not.toContain('is_initial_provisioning');
    expect(rpcBody).not.toContain('initial_provisioning_consumed_at');
    expect(rpcBody).not.toContain('phoenix_create_initial_provisioning_dispatch');
    expect(applyTime).not.toContain('warehouse_dispatch_lines_decision_chk');
    // VERIFY must still assert 167 semantics remain.
    expect(active).toContain('warehouse_dispatch_lines_decision_chk');
    expect(active).toContain('received_quantity = 0');
  });

  it('does not alter Availability vocabulary or Stage-F patient dispensing', () => {
    expect(applyTime).not.toMatch(/ALTER TABLE public\.item_availability\b/);
    expect(sql).not.toMatch(/near_stockout/);
    expect(sql).not.toMatch(/visit_card|patient_chart|dispense_to_patient/i);
  });

  it('does not edit migrations 166 or 167', () => {
    const sql166 = read('166_phoenix_initial_provisioning_invariant.sql');
    const sql167 = read('167_phoenix_dispatch_line_full_rejection_reconciliation.sql');
    expect(applyTime).not.toMatch(/166_phoenix_initial_provisioning/);
    expect(applyTime).not.toMatch(/167_phoenix_dispatch_line/);
    expect(applyTime).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch');
    expect(applyTime).not.toContain('warehouse_dispatch_lines_decision_chk');
    // Predecessor files remain independently readable (immutability smoke).
    expect(sql166).toContain('INITIAL-PROVISIONING-INVARIANT-166');
    expect(sql167).toContain('DISPATCH-LINE-FULL-REJECTION');
  });
});
