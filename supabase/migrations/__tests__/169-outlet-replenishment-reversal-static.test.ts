/**
 * 169 · OUTLET REPLENISHMENT REVERSAL (Stage E · E-6) — static proof.
 *
 * Source-level guards: registration, exact object inventory (3 new objects
 * only), authorization-before-replay structure, canonical material identity,
 * lock order, E-5 fingerprint helper untouched, 071 generic-return isolation
 * preserved, and NON-GOALS (no E-7 UI, no Stage F, no Availability change, no
 * new table/column/permission key/RLS policy).
 *
 * Behavioural proof lives in the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '169_phoenix_outlet_replenishment_reversal.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));
const active = activeSql(code);
const exec = executableSql(code);
// Dollar-quoted function/DO bodies removed — for negative assertions where a
// PREFLIGHT/VERIFY block legitimately REFERENCES an object (to check it still
// exists/is unchanged) and a blunt substring check on `active` would produce
// a false failure. Same technique as 168's static test.
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

const rbBody = (() => {
  const src = sqlFunctionSource(code, 'phoenix_outlet_replenishment_reversible_batches');
  expect(src).not.toBeNull();
  return src as string;
})();

const rpcBody = (() => {
  const src = sqlFunctionSource(code, 'phoenix_reverse_outlet_replenishment');
  expect(src).not.toBeNull();
  return src as string;
})();

describe('1. 169 registration and shape', () => {
  it('is registered exactly once, immediately after 168', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('168_phoenix_atomic_emergency_outlet_replenishment.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(active).toContain('PREFLIGHT FAILED (169)');
    expect(active).toContain('VERIFY FAILED (169)');
  });

  it('documents a manual rollback', () => {
    expect(sql).toMatch(/ROLLBACK \(manual\)/);
  });
});

describe('2. object inventory is EXACTLY the E-6 set (3 new objects)', () => {
  it('creates no table and adds no column', () => {
    expect(active).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(active).not.toMatch(/\bADD\s+COLUMN\b/i);
  });

  it('adds no permission key and no RLS policy change', () => {
    // PREFLIGHT legitimately READS permission_keys (asserting the 164-issued
    // outlet_stock.replenish_reverse key exists) — applyTime strips that
    // dollar-quoted DO block so this stays a genuine "never written" proof.
    expect(applyTime).not.toContain('permission_keys');
    expect(applyTime).not.toContain('role_permission_defaults');
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.role_permission_defaults/i);
    expect(active).not.toMatch(/CREATE POLICY/);
    expect(active).not.toMatch(/ALTER POLICY/);
    expect(active).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('creates exactly the reversal once-index with exact columns + predicate', () => {
    expect(active).toMatch(
      /CREATE UNIQUE INDEX outlet_stock_movements_replenishment_reversal_once_uniq/,
    );
    expect(active).toMatch(
      /ON public\.outlet_stock_movements \(reference_id, movement_type\)/,
    );
    expect(active).toMatch(
      /WHERE reference_type = 'outlet_replenishment_reversal' AND reference_id IS NOT NULL/,
    );
  });

  it('does not modify the E-5 forward once-index', () => {
    expect(active).not.toMatch(/DROP\s+INDEX\s+outlet_stock_movements_replenishment_once_uniq/i);
    expect(active).not.toMatch(/ALTER\s+INDEX\s+outlet_stock_movements_replenishment_once_uniq/i);
  });

  it('creates exactly two new functions with exact signatures', () => {
    expect(active).toContain(
      'CREATE FUNCTION public.phoenix_outlet_replenishment_reversible_batches(',
    );
    expect(active).toContain(
      'CREATE FUNCTION public.phoenix_reverse_outlet_replenishment(',
    );
    expect(active).toMatch(
      /phoenix_outlet_replenishment_reversible_batches\(\s*p_organization_id\s+uuid,\s*p_destination_point_id\s+uuid/,
    );
    expect(active).toMatch(
      /phoenix_reverse_outlet_replenishment\(\s*p_request_id\s+uuid,\s*p_route_id\s+uuid,\s*p_destination_outlet_stock_id\s+uuid,\s*p_quantity\s+integer,\s*p_reason\s+text(?:\s+DEFAULT\s+NULL)?,\s*p_notes\s+text(?:\s+DEFAULT\s+NULL)?/,
    );
  });

  it('creates no CREATE OR REPLACE of any existing function', () => {
    expect(active).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });

  it('does not create a fourth database object or any internal helper', () => {
    expect(active).not.toMatch(/CREATE\s+FUNCTION\s+public\._phoenix_/i);
    expect(active).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
  });

  it('marks both functions SECURITY DEFINER with pinned search_path', () => {
    expect(rbBody).toMatch(/SECURITY DEFINER/);
    expect(rbBody).toMatch(/SET search_path = public, pg_temp/);
    expect(rpcBody).toMatch(/SECURITY DEFINER/);
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
  });

  it('grants authenticated EXECUTE on both new functions, revokes PUBLIC/anon', () => {
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_outlet_replenishment_reversible_batches[\s\S]*?FROM PUBLIC, anon/,
    );
    expect(active).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_outlet_replenishment_reversible_batches[\s\S]*?TO authenticated/,
    );
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_reverse_outlet_replenishment[\s\S]*?FROM PUBLIC, anon/,
    );
    expect(active).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_reverse_outlet_replenishment[\s\S]*?TO authenticated/,
    );
  });
});

describe('3. reversible-batches read helper', () => {
  it('is read-only: no INSERT/UPDATE/DELETE into outlet_stock or outlet_stock_movements', () => {
    expect(rbBody).not.toMatch(/INSERT\s+INTO\s+public\.outlet_stock\b/i);
    expect(rbBody).not.toMatch(/UPDATE\s+public\.outlet_stock\b/i);
    expect(rbBody).not.toMatch(/INSERT\s+INTO\s+public\.outlet_stock_movements/i);
    expect(rbBody).not.toMatch(/UPDATE\s+public\.outlet_stock_movements/i);
  });

  it('requires authentication, active profile, and the scoped permission', () => {
    expect(rbBody).toContain('not_authenticated');
    expect(rbBody).toContain('active_profile_required');
    expect(rbBody).toContain('outlet_stock.replenish_reverse');
    expect(rbBody).toContain('phoenix_profile_has_scoped_permission');
  });

  it('derives from replenish_receive movements only, oldest-first, never dispatch provenance', () => {
    expect(rbBody).toContain("movement_type = 'replenish_receive'");
    expect(rbBody).toContain("reference_type = 'outlet_replenishment'");
    expect(rbBody).toMatch(/ORDER BY recv\.created_at ASC/);
    expect(rbBody).not.toContain('warehouse_dispatch_lines');
    expect(rbBody).not.toContain('dispatch_receive');
  });

  it('excludes fully reversed origins and exposes material_identity_key', () => {
    expect(rbBody).toMatch(/on_hand_delta\s*-\s*recv\.returned_quantity\)\s*>\s*0/);
    expect(rbBody).toContain('material_identity_key');
  });
});

describe('4. reversal RPC contract — provenance, cap, lock order, RBAC', () => {
  it('authorizes via existing outlet_stock.replenish_reverse only', () => {
    expect(rpcBody).toContain('outlet_stock.replenish_reverse');
    expect(rpcBody).not.toContain('permission_keys');
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
  });

  it('derives the origin movement server-side — no client-supplied movement id', () => {
    expect(rpcBody).toMatch(/reference_type\s*=\s*'outlet_replenishment'/);
    expect(rpcBody).toMatch(/movement_type\s*=\s*'replenish_receive'/);
    expect(rpcBody).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(rpcBody).toMatch(/LIMIT 1/);
    expect(rpcBody).not.toMatch(/p_origin_movement_id|p_original_movement_id/);
  });

  it('resolves the paired original replenish_send via the SAME reference_type + reference_id', () => {
    expect(rpcBody).toMatch(
      /reference_type\s*=\s*v_origin_recv\.reference_type[\s\S]{0,80}reference_id\s*=\s*v_origin_recv\.reference_id/,
    );
    expect(rpcBody).toContain("movement_type = 'replenish_send'");
  });

  it('caps reversal by returned_quantity on the origin receive leg, never a new column', () => {
    expect(rpcBody).toMatch(/returned_quantity/);
    expect(rpcBody).toMatch(/reversal_quantity_exceeds_remaining_cap/);
    expect(rpcBody).toMatch(
      /UPDATE public\.outlet_stock_movements\s*\n?\s*SET returned_quantity = returned_quantity \+ p_quantity\s*\n?\s*WHERE id = v_origin_recv\.id/,
    );
    // The original SEND leg's own returned_quantity must never be touched.
    expect(rpcBody).not.toMatch(
      /returned_quantity = returned_quantity \+ p_quantity\s*\n?\s*WHERE id = v_origin_send\.id/,
    );
  });

  it('does not modify or CREATE OR REPLACE the withdrawn generic-return provenance CHECK', () => {
    // VERIFY legitimately READS orrl_inbound_movement_type_chk (asserting 071
    // is unchanged) — applyTime strips that dollar-quoted DO block.
    expect(applyTime).not.toContain('orrl_inbound_movement_type_chk');
    expect(active).not.toMatch(/DROP\s+CONSTRAINT\s+orrl_inbound_movement_type_chk/i);
    expect(active).not.toMatch(/ADD\s+CONSTRAINT\s+orrl_inbound_movement_type_chk/i);
    expect(rpcBody).not.toContain('outlet_return_request_lines');
  });

  it('uses canonical material_identity_key, never the withdrawn partial predicate', () => {
    expect(rpcBody).toContain('material_identity_key');
    expect(rpcBody).not.toMatch(
      /v_dst_stock\.scientific_name\s*=\s*v_src_stock\.scientific_name/,
    );
  });

  it('acquires locks in the binding order: advisory → route SHARE → points SHARE → origin movement UPDATE → stock UPDATE', () => {
    const adv = rpcBody.indexOf('pg_advisory_xact_lock');
    const routeLock = rpcBody.search(
      /FROM public\.outlet_replenishment_routes[\s\S]{0,120}FOR SHARE/,
    );
    const pointLock = rpcBody.search(
      /FROM public\.distribution_points[\s\S]{0,80}FOR SHARE/,
    );
    const originLock = rpcBody.search(
      /FROM public\.outlet_stock_movements[\s\S]{0,400}FOR UPDATE/,
    );
    const stockLock = rpcBody.search(
      /FROM public\.outlet_stock WHERE id = v_stock_first FOR UPDATE/,
    );
    expect(adv).toBeGreaterThan(-1);
    expect(routeLock).toBeGreaterThan(adv);
    expect(pointLock).toBeGreaterThan(routeLock);
    expect(originLock).toBeGreaterThan(pointLock);
    expect(stockLock).toBeGreaterThan(originLock);
    expect(rpcBody).toContain('hashtextextended(p_request_id::text, 169169)');
  });

  it('does NOT gate fresh reversal on route.is_active (deliberate — see migration header)', () => {
    expect(rpcBody).not.toMatch(/route_not_active/);
    expect(rpcBody).not.toMatch(/v_route\.is_active/);
  });

  // Independent review finding, PR #110: stock conservation alone is
  // insufficient — the supplied route must be the EXACT historical route the
  // original forward pair moved through. Structural proof, scoped to the
  // actual assertion (not whitespace-fragile), and proven to run AFTER both
  // origin movements are resolved and BEFORE the historical is_active
  // exemption is undermined.
  it('binds the reversal to the exact historical route of the original forward pair', () => {
    expect(rpcBody).toContain('origin_forward_route_mismatch');
    // recv-side destination and send-side source, each checked against the
    // route — order-independent, tolerant of reformatting.
    expect(rpcBody).toMatch(
      /v_origin_recv\.distribution_point_id\s+IS\s+DISTINCT\s+FROM\s+v_route\.destination_point_id/,
    );
    expect(rpcBody).toMatch(
      /v_origin_send\.distribution_point_id\s+IS\s+DISTINCT\s+FROM\s+v_route\.source_point_id/,
    );
    // Organization consistency on both legs.
    expect(rpcBody).toMatch(
      /v_origin_recv\.organization_id\s+IS\s+DISTINCT\s+FROM\s+v_route\.organization_id/,
    );
    expect(rpcBody).toMatch(
      /v_origin_send\.organization_id\s+IS\s+DISTINCT\s+FROM\s+v_route\.organization_id/,
    );

    // Ordering: both origin movements must already be resolved (the send-side
    // check needs v_origin_send) before this assertion can run, and the
    // assertion itself must precede the cap check and the mutation.
    const pairedSendResolved = rpcBody.indexOf("movement_type = 'replenish_send'");
    const routeMismatchCheck = rpcBody.indexOf('origin_forward_route_mismatch');
    const capCheck = rpcBody.indexOf('reversal_quantity_exceeds_remaining_cap');
    const firstMutation = rpcBody.search(/UPDATE public\.outlet_stock\b/);
    expect(pairedSendResolved).toBeGreaterThan(-1);
    expect(routeMismatchCheck).toBeGreaterThan(pairedSendResolved);
    expect(capCheck).toBeGreaterThan(routeMismatchCheck);
    expect(firstMutation).toBeGreaterThan(routeMismatchCheck);

    // The original paired movements remain the stock-provenance authority —
    // this is an ADDITIONAL invariant, not a replacement: the pharmacy stock
    // row is still resolved from v_origin_send.outlet_stock_id, never from
    // v_route directly.
    expect(rpcBody).toMatch(/v_src_stock[\s\S]{0,120}v_origin_send\.outlet_stock_id/);

    // Still no route.is_active gate — historical reversibility of an
    // inactive OLD route is preserved even with this correction.
    expect(rpcBody).not.toMatch(/route_not_active/);
    expect(rpcBody).not.toMatch(/v_route\.is_active/);
  });

  it('enforces active-profile + outlet_stock.replenish_reverse BEFORE any idempotent replay return', () => {
    // Independent-review discipline established for 168 (PR #109), repeated
    // here from the first draft.
    const replayReturn = rpcBody.indexOf("'idempotent_replay', true");
    const permissionGate = rpcBody.indexOf('phoenix_profile_has_scoped_permission');
    const profileGate = rpcBody.indexOf('active_profile_required');
    expect(replayReturn).toBeGreaterThan(-1);
    expect(permissionGate).toBeGreaterThan(-1);
    expect(profileGate).toBeGreaterThan(-1);
    expect(permissionGate).toBeLessThan(replayReturn);
    expect(profileGate).toBeLessThan(replayReturn);
    const routeLock = rpcBody.search(
      /FROM public\.outlet_replenishment_routes[\s\S]{0,120}FOR SHARE/,
    );
    expect(routeLock).toBeGreaterThan(-1);
    expect(routeLock).toBeLessThan(replayReturn);
  });

  it('implements fingerprint idempotency without a dedup table', () => {
    expect(rpcBody).toContain('request_id_conflict');
    expect(rpcBody).toContain('idempotent_replay');
    expect(active).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('computes an inline canonical fingerprint and does not touch the E-5 helper', () => {
    expect(rpcBody).toMatch(/sha256\(convert_to\(jsonb_build_object\(/);
    expect(rpcBody).toContain("'operation', 'reverse_outlet_replenishment'");
    expect(rpcBody).not.toContain('_phoenix_replenishment_fingerprint_v1');
    expect(active).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\._phoenix_replenishment_fingerprint_v1/i);
  });

  it('produces exactly a two-leg conserved reversal ledger', () => {
    expect(rpcBody).toContain("'replenish_send'");
    expect(rpcBody).toContain("'replenish_receive'");
    expect(rpcBody).toContain("'outlet_replenishment_reversal'");
    expect(rpcBody).toContain("'transferred'");
    expect(rpcBody).not.toContain('warehouse_stock_movements');
  });

  it('projects availability on both sides and writes exactly one audit row per fresh call', () => {
    expect(rpcBody).toContain('phoenix_project_outlet_availability');
    expect(rpcBody).toMatch(/INSERT INTO public\.audit_logs/);
    expect(rpcBody).toContain("'outlet_stock.replenish_reverse'");
  });

  it('audit payload traces the original forward provenance', () => {
    expect(rpcBody).toContain('original_forward_reference_id');
    expect(rpcBody).toContain('original_receive_movement_id');
    expect(rpcBody).toContain('original_send_movement_id');
  });
});

describe('5. non-goals — nothing outside E-6', () => {
  it('does not implement E-7 UI / client services', () => {
    expect(sql).not.toMatch(/ReversalDialog|ReversalComposer|useReversal/i);
    expect(active).not.toMatch(/\bsrc\//);
  });

  it('does not touch E-4 initial-provisioning state or the 167 decision CHECK', () => {
    expect(rpcBody).not.toContain('is_initial_provisioning');
    expect(rpcBody).not.toContain('initial_provisioning_consumed_at');
    expect(rpcBody).not.toContain('phoenix_create_initial_provisioning_dispatch');
    expect(applyTime).not.toContain('warehouse_dispatch_lines_decision_chk');
    // VERIFY must still assert 167 semantics remain.
    expect(active).toContain('warehouse_dispatch_lines_decision_chk');
    expect(active).toContain('received_quantity = 0');
  });

  it('does not alter Availability vocabulary or Stage-F patient dispensing', () => {
    expect(active).not.toMatch(/ALTER TABLE public\.item_availability\b/);
    expect(sql).not.toMatch(/near_stockout/);
    expect(sql).not.toMatch(/visit_card|patient_chart|dispense_to_patient/i);
  });

  it('does not modify phoenix_inventory_fefo_batches', () => {
    expect(active).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_inventory_fefo_batches/i,
    );
  });

  it('does not edit migrations 001-168', () => {
    const sql167 = read('167_phoenix_dispatch_line_full_rejection_reconciliation.sql');
    const sql168 = read('168_phoenix_atomic_emergency_outlet_replenishment.sql');
    expect(active).not.toMatch(/167_phoenix_dispatch_line/);
    expect(active).not.toMatch(/168_phoenix_atomic_emergency/);
    expect(active).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_replenish_emergency_outlet');
    expect(active).not.toContain('CREATE OR REPLACE FUNCTION public._phoenix_replenishment_fingerprint_v1');
    // Predecessor files remain independently readable (immutability smoke).
    expect(sql167).toContain('DISPATCH-LINE-FULL-REJECTION');
    expect(sql168).toContain('ATOMIC-EMERGENCY-OUTLET-REPLENISHMENT-168');
  });
});
