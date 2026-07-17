/**
 * INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A
 *
 * Static SQL-source tests for migration 070 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 044-069.
 *
 * 070 closes a gap discovered while designing the outlet<->institution return
 * migration (drafted as 070 in PR #14, to be renumbered 071): 061 shipped
 * warehouse_dispatches/warehouse_dispatch_lines as SCHEMA ONLY, and no
 * migration through 069 ever built the CREATE/SEND path. A return cannot be
 * built on top of a forward supply path that cannot itself create or send
 * anything, so this migration builds that forward path FIRST.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour. This migration has not
 * yet been applied to a disposable database — see the file's own header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M070_NAME = '070_phoenix_institution_warehouse_outlet_dispatch.sql';
const P070 = join(MIGRATIONS_DIR, M070_NAME);
const m070 = readFileSync(P070, 'utf8');

const active070 = activeSql(m070);
const norm070 = normalizeSql(active070);
const exec070 = executableSql(m070);

function functionBody(name: string): string {
  const src = sqlFunctionSource(m070, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

const LIFECYCLE_RPCS = [
  'phoenix_create_warehouse_dispatch',
  'phoenix_add_dispatch_line',
  'phoenix_update_dispatch_line_quantity',
  'phoenix_delete_dispatch_line',
  'phoenix_cancel_warehouse_dispatch',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================
describe('1. migration 070 (forward dispatch) exists and is registered', () => {
  it('the file exists on disk', () => {
    expect(m070.length).toBeGreaterThan(0);
  });

  it('is wrapped in a single begin/commit transaction', () => {
    expect(active070.trimStart().startsWith('begin;')).toBe(true);
    expect(active070.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('states manual-apply-only and NOT APPLIED', () => {
    expect(m070).toContain('MANUAL APPLY ONLY');
    expect(m070).toContain('NOT APPLIED');
  });

  it('is registered in REVIEWED_MIGRATION_FILES', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M070_NAME);
  });

  it('runs preconditions that abort on missing 001/060/061/067 schema', () => {
    expect(m070).toContain('ABORT 070: expected 001/060/061/067 schema is absent');
  });

  it('aborts if 067\'s RECEIVE RPC is absent', () => {
    expect(m070).toContain("to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL");
  });
});

// ============================================================================
// 2. The audit finding: 'add' on outlet_stock_movements is not trusted
// ============================================================================
describe('2. movement_type=\'add\' on outlet_stock_movements is documented as unwritten, never treated as provenance', () => {
  it('the file header documents the audit finding', () => {
    expect(m070).toContain("'add'");
    expect(m070.toLowerCase()).toContain('reserved-but-unwritten');
  });

  it('the only movement_type literal ever written to outlet_stock_movements in this file is dispatch_receive', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toMatch(/'dispatch_receive',/);
    expect(body).not.toMatch(/'add',/);
  });
});

// ============================================================================
// 3. Structural pairing: an outlet may only be dispatched to by its own
//    warehouse_id's warehouse
// ============================================================================
describe('3. forward structural pairing mirrors the return domain', () => {
  it('adds distribution_points_id_warehouse_uniq (idempotent, additive)', () => {
    expect(norm070).toContain('distribution_points_id_warehouse_uniq');
  });

  it('adds a composite FK pinning (destination_distribution_point_id, warehouse_id) to distribution_points(id, warehouse_id)', () => {
    expect(norm070).toContain('warehouse_dispatches_dest_warehouse_fk');
    expect(norm070).toMatch(
      /FOREIGN KEY \(destination_distribution_point_id, warehouse_id\)\s+REFERENCES public\.distribution_points \(id, warehouse_id\)/,
    );
  });

  it('CREATE validates the pairing live with a named error, not just relying on the FK', () => {
    const body = functionBody('phoenix_create_warehouse_dispatch');
    expect(body).toContain('destination_outlet_not_paired_with_this_warehouse');
  });

  it('CREATE requires the outlet to be an approved network type', () => {
    const body = functionBody('phoenix_create_warehouse_dispatch');
    expect(body).toMatch(/point_type NOT IN \('pharmacy', 'crash_cabinet', 'rescue_cart'\)/);
  });
});

// ============================================================================
// 4. No widened CHECK, no new permission key
// ============================================================================
describe('4. reuses reserved vocabulary and pre-existing permission keys — mints nothing new', () => {
  it('does not ALTER either movement_type CHECK', () => {
    expect(exec070).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+warehouse_stock_movements_type_chk/i);
    expect(exec070).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+outlet_stock_movements_type_chk/i);
  });

  it('SEND writes movement_type \'dispatch_send\', reference_type \'warehouse_dispatch_send\' (distinct from 068\'s warehouse_transfer_send)', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/'dispatch_send',/);
    expect(body).toContain("'warehouse_dispatch_send', 'warehouse_dispatch_send'");
  });

  it('inserts no new row into permission_keys', () => {
    expect(exec070).not.toMatch(/INSERT INTO public\.permission_keys/);
  });

  it('every RPC checks a permission key that already existed before this migration (061/066/067)', () => {
    for (const [rpc, key] of [
      ['phoenix_create_warehouse_dispatch', 'warehouse_dispatch.create'],
      ['phoenix_add_dispatch_line', 'warehouse_dispatch.edit_draft'],
      ['phoenix_update_dispatch_line_quantity', 'warehouse_dispatch.edit_draft'],
      ['phoenix_delete_dispatch_line', 'warehouse_dispatch.edit_draft'],
      ['phoenix_cancel_warehouse_dispatch', 'warehouse_dispatch.cancel'],
      ['phoenix_send_warehouse_dispatch', 'warehouse_dispatch.send'],
    ] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain(`'${key}'`);
    }
  });
});

// ============================================================================
// 5. Draft lifecycle: no balance change until SEND
// ============================================================================
describe('5. draft/add-line/update/delete never touch warehouse_stock or outlet_stock balances', () => {
  it('ADD LINE does not UPDATE warehouse_stock', () => {
    const body = functionBody('phoenix_add_dispatch_line');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });

  it('UPDATE LINE QUANTITY only touches warehouse_dispatch_lines', () => {
    const body = functionBody('phoenix_update_dispatch_line_quantity');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
    expect(body).toMatch(/UPDATE public\.warehouse_dispatch_lines SET sent_quantity/);
  });

  it('CANCEL never touches warehouse_stock — draft has moved no stock yet', () => {
    const body = functionBody('phoenix_cancel_warehouse_dispatch');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });

  it('CANCEL is blocked outside draft', () => {
    const body = functionBody('phoenix_cancel_warehouse_dispatch');
    expect(body).toMatch(/IF v_dispatch\.status <> 'draft' THEN/);
    expect(body).toContain('dispatch_not_cancellable');
  });

  it('ADD/UPDATE/DELETE line are all blocked outside draft', () => {
    for (const rpc of ['phoenix_add_dispatch_line', 'phoenix_update_dispatch_line_quantity', 'phoenix_delete_dispatch_line'] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('dispatch_not_editable');
    }
  });

  it('CANCEL never hard-deletes a line — soft status transition to \'cancelled\' only', () => {
    const body = functionBody('phoenix_cancel_warehouse_dispatch');
    expect(body).not.toMatch(/DELETE FROM public\.warehouse_dispatch_lines/);
    expect(body).toMatch(/UPDATE public\.warehouse_dispatch_lines\s+SET status = 'cancelled'/);
  });
});

// ============================================================================
// 5b. Header status closes only per line completion — a gap 067 itself
//     leaves, closed here via an independent trigger
// ============================================================================
describe('5b. header status closes only per line completion — recomputed explicitly by RECEIVE, trigger is defense-in-depth only', () => {
  it('a shared recompute function exists and never touches draft or an already-terminal header', () => {
    const body = functionBody('phoenix_recompute_warehouse_dispatch_header_status');
    expect(body).toMatch(/WHERE id = p_dispatch_id\s+AND status IN \('sent', 'partially_accepted'\)/);
  });

  it('RECEIVE calls the shared recompute function explicitly, under its own header lock', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toContain('phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id)');
  });

  it('the trigger delegates to the SAME shared function — no duplicated logic', () => {
    const body = functionBody('phoenix_sync_warehouse_dispatch_header_status');
    expect(body).toContain('phoenix_recompute_warehouse_dispatch_header_status(NEW.dispatch_id)');
    expect(body).not.toMatch(/WHERE dispatch_id = NEW\.dispatch_id/); // no re-implemented count logic
  });

  it('the sync trigger exists and only fires on an actual status change', () => {
    expect(norm070).toContain('trg_sync_warehouse_dispatch_header_status');
    expect(norm070).toMatch(/AFTER UPDATE OF status ON public\.warehouse_dispatch_lines/);
    expect(norm070).toMatch(/WHEN \(NEW\.status IS DISTINCT FROM OLD\.status\)/);
  });

  it('the post-condition proves the trigger exists on the live catalog, not just in source', () => {
    expect(m070).toContain('ABORT 070: header-status-sync trigger missing');
  });
});

// ============================================================================
// 6. No automatic lot/FEFO selection — explicit stock id only
// ============================================================================
describe('6. no automatic lot selection anywhere — FEFO auto-allocation is 072\'s job', () => {
  it('ADD LINE takes an explicit p_warehouse_stock_id parameter, never picks one', () => {
    const body = functionBody('phoenix_add_dispatch_line');
    expect(body).toMatch(/p_warehouse_stock_id\s+uuid/);
    expect(body).not.toMatch(/ORDER BY expiry_date\s+LIMIT 1/i);
  });

  it('no query anywhere in this file auto-selects a warehouse_stock row by expiry ordering', () => {
    expect(exec070).not.toMatch(/ORDER BY\s+expiry_date[^;]*LIMIT/i);
  });
});

// ============================================================================
// 7. SEND: atomic, refuses expired batches, refuses insufficient quantity,
//    idempotent per line, aggregates same-lot demand across multiple lines
// ============================================================================
describe('7a. SEND aggregates demand across multiple lines naming the SAME warehouse_stock_id', () => {
  it('locks DISTINCT stock rows, not one row per line', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/SELECT DISTINCT warehouse_stock_id FROM public\.warehouse_dispatch_lines/);
  });

  it('validates the SUM of sent_quantity per stock row, never a single line in isolation', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/coalesce\(sum\(l\.sent_quantity\), 0\) INTO v_total_for_stock/);
    expect(body).toContain('insufficient_available_quantity_for_stock');
    // The old per-line-only check must be gone, not merely supplemented.
    expect(body).not.toContain('insufficient_available_quantity_for_line');
  });

  it('locks distinct stock rows in a fixed, deterministic order (ORDER BY s.id) to prevent deadlocks', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/ORDER BY s\.id\s+FOR UPDATE/);
  });
});

describe('7. SEND is atomic (validate-then-mutate), refuses expired stock, idempotent per line', () => {
  it('refuses an expired batch — forward direction, unlike the return domain\'s deliberate exception', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/expiry_date < current_date/);
    expect(body).toContain('expired_batch_cannot_be_dispatched');
  });

  it('validates every line (FOR UPDATE + availability + expiry) in a first pass, before any UPDATE public.warehouse_stock', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    const firstForUpdateIdx = body.indexOf('FOR UPDATE');
    const firstStockUpdateIdx = body.indexOf('UPDATE public.warehouse_stock');
    expect(firstForUpdateIdx).toBeGreaterThan(-1);
    expect(firstStockUpdateIdx).toBeGreaterThan(-1);
    expect(firstForUpdateIdx).toBeLessThan(firstStockUpdateIdx);
  });

  it('refuses insufficient available quantity per (aggregated) stock row', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toContain('insufficient_available_quantity_for_stock');
  });

  it('idempotency is keyed per LINE (reference_id = dispatch_line.id), not per shared request id', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/reference_type = 'warehouse_dispatch_send' AND reference_id = v_line\.id/);
    expect(body).toMatch(/'warehouse_dispatch_send', 'warehouse_dispatch_send', v_line\.id,/);
  });

  it('an idempotency index exists for the new SEND leg', () => {
    expect(norm070).toContain('warehouse_stock_movements_dispatch_line_once_uniq');
  });

  it('an already-sent/terminal dispatch replays idempotently rather than erroring or re-debiting', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/idempotent_replay.*true/);
  });

  it('has advisory lock, row locks, IDOR gate, fingerprint, and audit', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/pg_advisory_xact_lock/);
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/phoenix_profile_has_scoped_permission/);
    expect(body).toMatch(/request_fingerprint/);
    expect(body).toMatch(/INSERT INTO public\.audit_logs/);
  });
});

// ============================================================================
// 8. RECEIVE is recreated for concurrency safety — SAME signature/ACL/contract
// ============================================================================
describe('8. RECEIVE keeps 067\'s exact signature, ACL, and return contract — only lock order and one explicit call changed', () => {
  it('this file DOES recreate phoenix_receive_outlet_dispatch_line (per the review\'s own instruction)', () => {
    expect(exec070).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_outlet_dispatch_line/);
  });

  it('the signature is character-for-character identical to 067\'s original', () => {
    expect(m070).toContain(
      'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)',
    );
  });

  it('post-condition proves the signature is unchanged', () => {
    expect(m070).toContain("ABORT 070: RECEIVE RPC signature changed — must match 067''s original exactly");
  });

  it('the ACL is restated identically: REVOKE ALL then GRANT EXECUTE to authenticated only', () => {
    const idx = active070.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line');
    const tail = active070.slice(idx, idx + 12000);
    expect(tail).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_receive_outlet_dispatch_line\(uuid, uuid, integer, text, text\)\s+FROM PUBLIC, anon;/);
    expect(tail).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_receive_outlet_dispatch_line\(uuid, uuid, integer, text, text\)\s+TO authenticated;/);
  });

  it('the return shape (ok/idempotent_replay/line_status/outlet_stock_id/movement_id/item_availability_id/quantities) is unchanged', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    for (const key of ['line_status', 'outlet_stock_id', 'movement_id', 'item_availability_id', 'quantity_before', 'quantity_delta', 'quantity_after']) {
      expect(body, key).toContain(`'${key}'`);
    }
  });

  it('idempotent replay still returns the same shape 067 always did', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toMatch(/'ok', true, 'idempotent_replay', true,\s*'outlet_stock_id', v_existing\.outlet_stock_id/);
  });

  it('a replayed request never inserts outlet_stock twice — the idempotency check returns before any INSERT', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    const replayReturnIdx = body.indexOf("'idempotent_replay', true");
    const outletStockInsertIdx = body.indexOf('INSERT INTO public.outlet_stock (');
    expect(replayReturnIdx).toBeGreaterThan(-1);
    expect(outletStockInsertIdx).toBeGreaterThan(-1);
    expect(replayReturnIdx).toBeLessThan(outletStockInsertIdx);
  });
});

// ============================================================================
// 9. Compatibility: no DROP/RENAME/REVOKE of pre-existing objects
// ============================================================================
describe('9. additive only — no DROP, RENAME, or REVOKE of a pre-existing object', () => {
  it('contains no DROP TABLE, DROP FUNCTION, or ALTER ... RENAME', () => {
    expect(exec070).not.toMatch(/DROP TABLE/i);
    expect(exec070).not.toMatch(/DROP FUNCTION/i);
    expect(exec070).not.toMatch(/RENAME/i);
  });

  it('every REVOKE targets only functions this file itself creates', () => {
    const revokedFns = [...active070.matchAll(/REVOKE ALL ON FUNCTION public\.(\w+)/g)].map(m => m[1]);
    const createdFns = LIFECYCLE_RPCS.concat([
      'phoenix_send_warehouse_dispatch',
      'phoenix_sync_warehouse_dispatch_header_status',
      'phoenix_recompute_warehouse_dispatch_header_status',
      'phoenix_receive_outlet_dispatch_line',
      'phoenix_can_read_warehouse_dispatch',
    ] as const);
    for (const fn of revokedFns) {
      expect(createdFns as readonly string[], fn).toContain(fn);
    }
  });
});

// ============================================================================
// 10. Every RPC named in this file actually exists
// ============================================================================
describe('10. every lifecycle + send RPC exists as a CREATE FUNCTION', () => {
  it('all five lifecycle RPCs exist', () => {
    for (const name of LIFECYCLE_RPCS) {
      expect(sqlFunctionSource(m070, name), name).not.toBeNull();
    }
  });

  it('the SEND RPC exists', () => {
    expect(sqlFunctionSource(m070, 'phoenix_send_warehouse_dispatch')).not.toBeNull();
  });
});

// ============================================================================
// 11. Scoped read: RESTRICTIVE policies, additive to 061, plus explicit deny
// ============================================================================
describe('11. RESTRICTIVE scoped-read policies narrow 061\'s unscoped visibility, without touching 061', () => {
  it('declares both new policies AS RESTRICTIVE (never PERMISSIVE — that would widen access instead of narrowing it)', () => {
    expect(norm070).toMatch(/CREATE POLICY warehouse_dispatches_scope_restrict\s+ON public\.warehouse_dispatches\s+AS RESTRICTIVE\s+FOR SELECT/);
    expect(norm070).toMatch(/CREATE POLICY warehouse_dispatch_lines_scope_restrict\s+ON public\.warehouse_dispatch_lines\s+AS RESTRICTIVE\s+FOR SELECT/);
  });

  it('the scope function checks warehouse_dispatch.view scoped to the SPECIFIC warehouse, and outlet_stock.receive scoped to the SPECIFIC outlet', () => {
    const body = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(body).toMatch(/phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'warehouse_dispatch\.view', p_organization_id, p_warehouse_id, NULL/);
    expect(body).toMatch(/phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'outlet_stock\.receive', p_organization_id, NULL, p_destination_distribution_point_id/);
  });

  it('super_admin bypasses the scope function', () => {
    const body = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(body).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
  });

  it('lines are readable only via their parent dispatch\'s own scope check (no separate, weaker rule)', () => {
    expect(norm070).toMatch(
      /EXISTS \(\s*SELECT 1 FROM public\.warehouse_dispatches d\s+WHERE d\.id = warehouse_dispatch_lines\.dispatch_id\s+AND public\.phoenix_can_read_warehouse_dispatch/,
    );
  });

  it('061\'s own permissive policies are neither dropped nor redefined by this file', () => {
    expect(exec070).not.toMatch(/DROP POLICY[^;]*warehouse_dispatches_select_perm/);
    expect(exec070).not.toMatch(/DROP POLICY[^;]*warehouse_dispatch_lines_select_perm/);
    expect(exec070).not.toMatch(/CREATE POLICY "?warehouse_dispatches_select_perm"?/);
  });

  it('post-conditions prove the new policies are RESTRICTIVE and 061\'s originals are still PERMISSIVE, on the live catalog', () => {
    expect(m070).toContain('polpermissive = false');
    expect(m070).toContain('polpermissive = true');
    expect(m070).toContain('warehouse_dispatches_select_perm');
  });

  it('outlet_officer is explicitly denied create/edit_draft/cancel/send — not merely absent', () => {
    expect(norm070).toMatch(/\('outlet_officer', 'warehouse_dispatch\.create',\s+false\)/);
    expect(norm070).toMatch(/\('outlet_officer', 'warehouse_dispatch\.edit_draft',\s+false\)/);
    expect(norm070).toMatch(/\('outlet_officer', 'warehouse_dispatch\.cancel',\s+false\)/);
    expect(norm070).toMatch(/\('outlet_officer', 'warehouse_dispatch\.send',\s+false\)/);
  });

  it('post-condition proves each explicit outlet_officer denial on the live catalog', () => {
    expect(m070).toContain('ABORT 070: outlet_officer is not explicitly denied');
  });
});

// ============================================================================
// 12. SEND: fail-closed status handling, per real dispatch status
// ============================================================================
describe('12. SEND handles every dispatch status explicitly — cancelled is a hard error, only real post-send states replay', () => {
  it('cancelled raises a SPECIFIC error, never treated as an idempotent replay', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/IF v_dispatch\.status = 'cancelled' THEN\s+RAISE EXCEPTION 'dispatch_cancelled'/);
  });

  it('sent/partially_accepted/accepted/rejected are the ONLY statuses that replay idempotently', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(
      /ELSIF v_dispatch\.status IN \('sent', 'partially_accepted', 'accepted', 'rejected'\) THEN\s+RETURN jsonb_build_object\('ok', true, 'idempotent_replay', true/,
    );
  });

  it('any other status raises a fail-closed, unreachable-by-construction error', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/ELSIF v_dispatch\.status <> 'draft' THEN\s+RAISE EXCEPTION 'dispatch_unexpected_status/);
  });

  it('every one of 061\'s status values is explicitly accounted for', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    for (const s of ['cancelled', 'sent', 'partially_accepted', 'accepted', 'rejected']) {
      expect(body, s).toContain(`'${s}'`);
    }
  });
});

// ============================================================================
// 13. SEND re-validates warehouse and destination outlet liveness
// ============================================================================
describe('13. SEND re-checks the warehouse and destination outlet LIVE, not just at CREATE time', () => {
  it('re-locks and re-reads the warehouse row, refusing if inactive', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/FROM public\.warehouses WHERE id = v_dispatch\.warehouse_id FOR SHARE/);
    expect(body).toContain('warehouse_not_found_or_inactive');
  });

  it('re-locks and re-reads the destination outlet, refusing if inactive, wrong type, or re-paired to a different warehouse', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/FROM public\.distribution_points WHERE id = v_dispatch\.destination_distribution_point_id FOR SHARE/);
    expect(body).toContain('destination_outlet_not_found_or_inactive');
    expect(body).toContain('destination_outlet_not_paired_with_this_warehouse');
  });

  it('this re-validation happens BEFORE the aggregation pass (fail fast, before any stock lock)', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    const warehouseCheckIdx = body.indexOf('warehouse_not_found_or_inactive');
    const aggregationIdx = body.indexOf('DISTINCT warehouse_stock_id');
    expect(warehouseCheckIdx).toBeGreaterThan(-1);
    expect(aggregationIdx).toBeGreaterThan(-1);
    expect(warehouseCheckIdx).toBeLessThan(aggregationIdx);
  });
});

// ============================================================================
// 14. Aggregation: reserved_quantity untouched, no partial mutation on failure
// ============================================================================
describe('14. aggregation fix leaves reserved_quantity alone and never partially debits', () => {
  it('the availability check reads on_hand_quantity - reserved_quantity, never mutating reserved_quantity itself', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/v_stock\.on_hand_quantity - v_stock\.reserved_quantity < v_total_for_stock/);
    expect(body).not.toMatch(/SET reserved_quantity/);
  });

  it('the aggregation validation pass (pass 1) contains no UPDATE — a failure there leaves every row completely untouched', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    const pass1Start = body.indexOf('DISTINCT warehouse_stock_id');
    const pass1End = body.indexOf('END LOOP;', pass1Start); // closes the FOR v_stock IN ... LOOP
    const pass1Text = body.slice(Math.max(0, pass1Start - 50), pass1End);
    expect(pass1End).toBeGreaterThan(pass1Start);
    expect(pass1Text).not.toMatch(/UPDATE public\.warehouse_stock/);
  });
});

// ============================================================================
// 15. RLS composition fix (round 3): a RESTRICTIVE policy can only NARROW, so a
//     NARROW second PERMISSIVE policy is required for the outlet_officer to be
//     able to READ the dispatch it is allowed to RECEIVE.
//
//     Final SELECT composition PostgreSQL evaluates on both tables:
//       ( super_admin                                      [061 permissive]
//         OR org member w/ unscoped warehouse_dispatch.view [061 permissive]
//         OR scoped outlet_stock.receive on destination     [9d permissive] )
//       AND phoenix_can_read_warehouse_dispatch(...)        [9c restrictive]
// ============================================================================
describe('15. the outlet_officer read path: a narrow permissive policy ORs in the one principal 061 omits, the restrictive layer bounds everyone to exact scope', () => {
  it('adds a SECOND permissive SELECT policy on warehouse_dispatches, AS PERMISSIVE, keyed to scoped outlet_stock.receive on the destination outlet', () => {
    expect(norm070).toMatch(
      /CREATE POLICY warehouse_dispatches_outlet_receive_perm\s+ON public\.warehouse_dispatches\s+AS PERMISSIVE\s+FOR SELECT\s+TO authenticated/,
    );
    expect(norm070).toMatch(
      /warehouse_dispatches_outlet_receive_perm[\s\S]*?phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'outlet_stock\.receive', organization_id, NULL, destination_distribution_point_id/,
    );
  });

  it('the outlet-receive permissive predicate is NARROWER than 9c\'s restrictive one — it names ONLY outlet_stock.receive, never super_admin or warehouse_dispatch.view (so it can never widen past the scope bound)', () => {
    const start = norm070.indexOf('CREATE POLICY warehouse_dispatches_outlet_receive_perm');
    const end = norm070.indexOf('CREATE POLICY warehouse_dispatch_lines_outlet_receive_perm', start);
    const policy = norm070.slice(start, end);
    expect(policy).toContain("'outlet_stock.receive'");
    expect(policy).not.toContain("'warehouse_dispatch.view'");
    expect(policy).not.toContain("super_admin");
  });

  it('adds the mirrored permissive policy on warehouse_dispatch_lines, gated ONLY through the parent dispatch\'s destination (no separate, weaker rule)', () => {
    expect(norm070).toMatch(
      /CREATE POLICY warehouse_dispatch_lines_outlet_receive_perm\s+ON public\.warehouse_dispatch_lines\s+AS PERMISSIVE\s+FOR SELECT/,
    );
    expect(norm070).toMatch(
      /warehouse_dispatch_lines_outlet_receive_perm[\s\S]*?EXISTS \(\s*SELECT 1 FROM public\.warehouse_dispatches d\s+WHERE d\.id = warehouse_dispatch_lines\.dispatch_id\s+AND public\.phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'outlet_stock\.receive', d\.organization_id, NULL,\s*d\.destination_distribution_point_id/,
    );
  });

  it('does NOT drop or redefine 061\'s permissive policies — 070 only adds its own policies alongside them (its own new policies are idempotently DROP-IF-EXISTS + CREATE, which is fine)', () => {
    expect(exec070).not.toMatch(/DROP POLICY[^;]*warehouse_dispatches_select_perm/);
    expect(exec070).not.toMatch(/DROP POLICY[^;]*warehouse_dispatch_lines_select_perm/);
    expect(exec070).not.toMatch(/CREATE POLICY "?warehouse_dispatches_select_perm"?/);
    expect(exec070).not.toMatch(/CREATE POLICY "?warehouse_dispatch_lines_select_perm"?/);
    // every DROP POLICY in this file targets only a policy this file itself
    // (re)creates — never a pre-existing 061 one.
    const dropped = [...exec070.matchAll(/DROP POLICY IF EXISTS (\w+)/g)].map((m) => m[1]);
    for (const name of dropped) {
      expect(name).toMatch(/_scope_restrict$|_outlet_receive_perm$/);
    }
  });

  // The six behavioural scenarios, each pinned to the exact predicate that
  // decides it under (P061 OR P9d) AND R9c.
  it('SCENARIO super_admin sees everything: 061 permissive admits via super_admin, 9c restrictive bypasses via super_admin', () => {
    // 061 permissive branch (unchanged) + can_read super_admin bypass.
    const canRead = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(canRead).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
  });

  it('SCENARIO warehouse_officer sees ONLY its own warehouse: 061 permissive admits (holds view key org-wide) but 9c restrictive bounds to the SPECIFIC warehouse via scoped view (assignment required)', () => {
    const canRead = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(canRead).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'warehouse_dispatch\.view', p_organization_id, p_warehouse_id, NULL/,
    );
  });

  it('SCENARIO warehouse_officer does NOT see another warehouse in the same org: the broad org-level view key passes 061 permissive, but the wrong warehouse scope fails 9c restrictive — a restrictive policy is never bypassed by a permissive one', () => {
    // Proven by the restrictive policy being declared AS RESTRICTIVE (10k) and
    // keyed to p_warehouse_id, so a wrong warehouse can only ever AND to false.
    expect(norm070).toMatch(/CREATE POLICY warehouse_dispatches_scope_restrict\s+ON public\.warehouse_dispatches\s+AS RESTRICTIVE/);
    expect(m070).toContain('polpermissive = false');
  });

  it('SCENARIO outlet_officer sees ONLY dispatches to its own outlet: 9d permissive admits (061 does not, it holds no dispatch key) via scoped receive on THIS destination, and 9c restrictive agrees on the same predicate', () => {
    const canRead = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(canRead).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'outlet_stock\.receive', p_organization_id, NULL, p_destination_distribution_point_id/,
    );
    // and the permissive half exists to admit it in the first place
    expect(norm070).toContain('warehouse_dispatches_outlet_receive_perm');
  });

  it('SCENARIO outlet_officer does NOT see another outlet in the same org: the scoped receive predicate names the SPECIFIC destination, so a different outlet fails BOTH the 9d permissive and the 9c restrictive checks (no assignment there)', () => {
    // Both halves key on destination_distribution_point_id — a mismatched
    // outlet can satisfy neither, so the row is OR-false at the permissive layer.
    const start = norm070.indexOf('CREATE POLICY warehouse_dispatches_outlet_receive_perm');
    const policy = norm070.slice(start, start + 600);
    expect(policy).toContain('destination_distribution_point_id');
  });

  it('SCENARIO same-org user with NO assignment sees nothing: an unassigned outlet_officer fails 9d (needs point assignment) and is absent from 061 (no view key); an unassigned warehouse_officer passes 061 but fails 9c restrictive (needs warehouse assignment)', () => {
    // The scope helper requires an active resource assignment for operational
    // roles — proven by 062's own contract, exercised identically by both the
    // 9d permissive and the 9c restrictive predicates here.
    expect(norm070).toMatch(/phoenix_profile_has_scoped_permission/);
  });

  it('SCENARIO a broad role-default with the WRONG scope never bypasses the restrictive policy: this is exactly why 9d is deliberately NARROW and 9c is RESTRICTIVE (AND, never OR-around)', () => {
    // The permissive addition (9d) is strictly narrower than the restrictive
    // bound (9c); the census (10q) forbids a third, broader permissive policy.
    expect(m070).toContain('EXACTLY two permissive SELECT policies');
    expect(m070).toContain('EXACTLY one restrictive SELECT policy');
  });

  // Catalog-level post-conditions (polpermissive/polrestrictive + census).
  it('post-condition proves the new outlet-receive policies are PERMISSIVE on the live catalog (not accidentally restrictive)', () => {
    expect(m070).toContain('is missing its PERMISSIVE outlet-receive policy (9d)');
  });

  it('post-condition proves the EXACT policy census: two permissive + one restrictive SELECT policy per table', () => {
    expect(m070).toContain('EXACTLY two permissive SELECT policies (061 view + 9d outlet-receive)');
    expect(m070).toContain('EXACTLY one restrictive SELECT policy (9c scope boundary)');
  });

  it('the census counts SELECT policies specifically (polcmd = \'r\'), by polpermissive', () => {
    expect(m070).toMatch(/polcmd = 'r' AND pol\.polpermissive = true/);
    expect(m070).toMatch(/polcmd = 'r' AND pol\.polpermissive = false/);
  });
});

// ============================================================================
// 16. Internal-function ACL + recompute double-call safety
// ============================================================================
describe('16. internal functions are not callable by clients, and the shared recompute is safe to call twice', () => {
  it('phoenix_recompute_warehouse_dispatch_header_status is REVOKEd from PUBLIC, anon AND authenticated — no client can call it directly (only the definer RPCs/trigger, as owner)', () => {
    expect(norm070).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_recompute_warehouse_dispatch_header_status\(uuid\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    // and it is never granted back to any client role
    expect(norm070).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_recompute_warehouse_dispatch_header_status/);
  });

  it('the trigger function phoenix_sync_warehouse_dispatch_header_status is likewise REVOKEd from PUBLIC, anon AND authenticated', () => {
    expect(norm070).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_sync_warehouse_dispatch_header_status\(\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(norm070).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_sync_warehouse_dispatch_header_status/);
  });

  it('phoenix_can_read_warehouse_dispatch grants EXECUTE to authenticated ONLY (RLS needs it), revoked from PUBLIC/anon, and never to a broader principal', () => {
    expect(norm070).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_can_read_warehouse_dispatch\(uuid, uuid, uuid\) FROM PUBLIC, anon;/,
    );
    expect(norm070).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_can_read_warehouse_dispatch\(uuid, uuid, uuid\) TO authenticated;/,
    );
  });

  it('phoenix_can_read_warehouse_dispatch performs NO write — it is a STABLE, read-only SELECT function', () => {
    const body = functionBody('phoenix_can_read_warehouse_dispatch');
    expect(body).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/i);
    const src = sqlFunctionSource(m070, 'phoenix_can_read_warehouse_dispatch')!;
    expect(src).toMatch(/LANGUAGE sql\s+STABLE/);
  });

  it('every SECURITY DEFINER function in this file pins search_path (no unpinned definer)', () => {
    // 10 real definer functions; the only other 'SECURITY DEFINER' occurrences
    // are the two assertion string literals in section 10r.
    const definerCount = (exec070.match(/SECURITY DEFINER/g) ?? []).length;
    const searchPathCount = (exec070.match(/SET search_path = public, pg_temp/g) ?? []).length;
    expect(definerCount).toBe(searchPathCount);
  });

  it('the shared recompute writes NOTHING but warehouse_dispatches.status — no INSERT (audit/movement), no stock table — so a redundant second call is a guaranteed no-op', () => {
    const body = functionBody('phoenix_recompute_warehouse_dispatch_header_status');
    expect(body).not.toMatch(/INSERT INTO/i);
    expect(body).not.toMatch(/warehouse_stock|outlet_stock/);
    expect(body).toMatch(/UPDATE public\.warehouse_dispatches\s+SET status = v_new_status/);
  });

  it('the recompute UPDATE is guarded by status IS DISTINCT FROM v_new_status — the second call changes no row', () => {
    const body = functionBody('phoenix_recompute_warehouse_dispatch_header_status');
    expect(body).toMatch(/status IS DISTINCT FROM v_new_status/);
  });

  it('post-conditions prove the recompute\'s double-call safety structurally (no INSERT, no stock, idempotent guard)', () => {
    expect(m070).toContain('double-invocation must stay side-effect free');
    expect(m070).toContain('header recompute must never touch a stock balance');
    expect(m070).toContain('idempotent double-call');
  });

  it('RECEIVE\'s explicit recompute call and the 8b trigger both target the SAME dispatch on the SAME line-status UPDATE — double invocation is expected and proven harmless', () => {
    const receive = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(receive).toContain('phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id)');
    const trigger = functionBody('phoenix_sync_warehouse_dispatch_header_status');
    expect(trigger).toContain('phoenix_recompute_warehouse_dispatch_header_status(NEW.dispatch_id)');
  });
});
