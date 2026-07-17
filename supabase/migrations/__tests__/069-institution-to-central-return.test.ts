/**
 * INSTITUTION-TO-CENTRAL-RETURN-069-A
 *
 * Static SQL-source tests for migration 069 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 052–068.
 *
 * 069 completes 068's own deferred scope: the return leg (institution ->
 * central), reusing 066's route in reverse. Pre-merge validation of this
 * migration did not include execution against a disposable PostgreSQL
 * database; validation used static analysis, tests, CI, and Supabase
 * dry-run. This phrasing is a permanent historical record of what pre-merge
 * validation covered, not a status to flip later.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour.
 *
 * NOTE ON SCOPE: like 060–068, this file carries NO global ceiling assertion.
 * The reviewed maximum belongs to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M069_NAME = '069_phoenix_institution_to_central_return.sql';
const P069 = join(MIGRATIONS_DIR, M069_NAME);
const m069 = readFileSync(P069, 'utf8');

const active069 = activeSql(m069);
const norm069 = normalizeSql(active069);

/** Executable SQL with string literals blanked, so RAISE prose cannot match. */
const exec069 = executableSql(m069);

/** The body of one CREATE FUNCTION, by name — for per-RPC assertions. */
function functionBody(name: string): string {
  const src = sqlFunctionSource(m069, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

/** The two stock-moving RPCs 069 introduces. Same contract as 068's SEND/
 *  RECEIVE: advisory lock, fingerprint, 69069 lock namespace. */
const WRITE_RPCS = [
  'phoenix_send_warehouse_return_shipment_line',
  'phoenix_receive_warehouse_return_shipment_line',
] as const;

/** The five return-request-lifecycle RPCs. None moves stock. */
const REQUEST_LIFECYCLE_RPCS = [
  'phoenix_request_warehouse_return',
  'phoenix_recall_warehouse_transfer',
  'phoenix_submit_warehouse_return_request',
  'phoenix_cancel_warehouse_return_request',
  'phoenix_review_warehouse_return_request',
] as const;

/** The two dual-initiation entry points — both insert into the same table,
 *  under a different requested_by_side. */
const DUAL_INITIATION_RPCS = [
  'phoenix_request_warehouse_return',
  'phoenix_recall_warehouse_transfer',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================

describe('1. migration 069 exists exactly once and is registered', () => {
  it('069_phoenix_institution_to_central_return.sql exists', () => {
    expect(existsSync(P069)).toBe(true);
  });

  it('is the only file named 069_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('069_'))).toEqual([M069_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M069_NAME);
    expect(isReviewedMigrationFile(M069_NAME)).toBe(true);
  });

  it('is a single atomic transaction — begin ... commit', () => {
    expect(active069.trimStart().startsWith('begin;')).toBe(true);
    expect(active069.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('is marked manual-apply-only', () => {
    expect(m069).toMatch(/MANUAL APPLY ONLY/);
  });

  it('documents that pre-merge validation excluded execution against a disposable Postgres', () => {
    expect(m069.replace(/^--\s?/gm, '').replace(/\s+/g, ' ')).toMatch(
      /pre-merge validation did not include execution against a disposable postgresql database; validation used static analysis, tests, ci, and supabase dry-run/i,
    );
  });

  it('has preconditions requiring 062 and 068', () => {
    expect(m069).toContain('ABORT 069: 062 scope helper is absent');
    expect(m069).toContain('ABORT 069: 068 SEND/RECEIVE RPCs are absent');
  });
});

// ============================================================================
// 2. Rollback on failure — the whole migration, or none of it
// ============================================================================

describe('2. the migration rolls back completely on failure', () => {
  it('has no COMMIT before the final one', () => {
    const commits = [...active069.matchAll(/\bcommit\s*;/gi)];
    expect(commits.length).toBe(1);
  });

  it('has no explicit transaction control other than begin/commit', () => {
    expect(exec069).not.toMatch(/\bROLLBACK\b/i);
    expect(exec069).not.toMatch(/\bSAVEPOINT\b/i);
  });
});

// ============================================================================
// 3. returned_quantity — additive column on an ALREADY-APPLIED 068 table
// ============================================================================

describe('3. warehouse_transfer_lines gains returned_quantity additively', () => {
  it('adds the column via ADD COLUMN IF NOT EXISTS pattern (duplicate_column guard)', () => {
    expect(norm069).toMatch(
      /ALTER TABLE public\.warehouse_transfer_lines ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0/,
    );
    expect(norm069).toMatch(/EXCEPTION WHEN duplicate_column THEN NULL/);
  });

  it('bounds returned_quantity by received_quantity, never negative', () => {
    expect(norm069).toContain('wtl_returned_qty_chk');
    expect(norm069).toMatch(
      /CHECK \(returned_quantity >= 0 AND returned_quantity <= COALESCE\(received_quantity, 0\)\)/,
    );
  });

  it('never touches any other column of an already-applied 068 table', () => {
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_transfer_requests\b/);
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_transfer_request_lines\b/);
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_transfers\b/);
  });
});

// ============================================================================
// 4. Reuses 066's route, in reverse — no new route table
// ============================================================================

describe('4. return endpoints are pinned to 066/068\'s EXISTING route composite key, reversed', () => {
  it('creates no new route or pairing table', () => {
    expect(exec069).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?public\.\w*route\w*/i);
  });

  it('warehouse_return_requests FK reverses the column order relative to 068\'s wtr_route_endpoints_fk', () => {
    expect(norm069).toMatch(
      /CONSTRAINT wrr_route_endpoints_fk FOREIGN KEY \(route_id, destination_warehouse_id, source_warehouse_id\) REFERENCES public\.warehouse_supply_routes \(id, source_warehouse_id, target_warehouse_id\)/,
    );
  });

  it('warehouse_return_shipments FK reverses the column order the same way', () => {
    expect(norm069).toMatch(
      /CONSTRAINT wrs_route_endpoints_fk FOREIGN KEY \(route_id, destination_warehouse_id, source_warehouse_id\) REFERENCES public\.warehouse_supply_routes \(id, source_warehouse_id, target_warehouse_id\)/,
    );
  });

  it('never widens or redefines warehouse_supply_routes\' own CHECK constraints', () => {
    expect(exec069).not.toMatch(/warehouse_supply_routes_source_is_central/);
    expect(exec069).not.toMatch(/warehouse_supply_routes_target_is_institution/);
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_supply_routes\b/);
  });
});

// ============================================================================
// 5. Return lines name a SPECIFIC prior receipt, never a freeform material
// ============================================================================

describe('5. return request lines are pinned to original_transfer_line_id', () => {
  it('warehouse_return_request_lines requires original_transfer_line_id NOT NULL', () => {
    const body = norm069.slice(
      norm069.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_return_request_lines'),
      norm069.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS wrrl_request_original_line_uniq'),
    );
    expect(body).toMatch(
      /original_transfer_line_id uuid NOT NULL REFERENCES public\.warehouse_transfer_lines\(id\) ON DELETE RESTRICT/,
    );
  });

  it('a given original line can be named at most once per return request', () => {
    expect(norm069).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wrrl_request_original_line_uniq ON public\.warehouse_return_request_lines \(return_request_id, original_transfer_line_id\)/,
    );
  });

  it('has a reason_code CHECK constraint', () => {
    expect(norm069).toContain('wrrl_reason_code_chk');
    expect(norm069).toMatch(
      /CHECK \(reason_code IN \(\s*'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*'recalled', 'quality_issue', 'temperature_excursion', 'other'\s*\)\)/,
    );
  });
});

// ============================================================================
// 6. Quantities cannot lie: requested/approved/fulfilled/returned
// ============================================================================

describe('6. quantity ceilings are structural, not just RPC promises', () => {
  it('approved_quantity is bounded by requested_quantity', () => {
    expect(norm069).toContain('wrrl_approved_qty_chk');
  });

  it('fulfilled_quantity is bounded by approved_quantity, and requires approval to be nonzero', () => {
    expect(norm069).toContain('wrrl_fulfilled_le_approved_chk');
    expect(norm069).toContain('wrrl_fulfilled_requires_approval_chk');
  });

  it('the request-line status/quantity state machine is a single CHECK, mirroring 068\'s pattern', () => {
    expect(norm069).toContain('wrrl_status_qty_consistency_chk');
  });

  it('the shipment-line decision CHECK mirrors 068\'s wtl_decision_chk exactly', () => {
    expect(norm069).toContain('wrsl_decision_chk');
    expect(norm069).toMatch(/received_quantity = sent_quantity AND received_at IS NOT NULL/);
  });

  it('a literal conservation equation is a structural CHECK, not just implied', () => {
    expect(norm069).toContain('wrsl_conservation_eq_chk');
    expect(norm069).toMatch(
      /CONSTRAINT wrsl_conservation_eq_chk\s+CHECK \(\s*status = 'in_transit'\s+OR sent_quantity =/,
    );
    // Every resolved-status term appears exactly once in the sum, so no
    // quantity can be counted twice or dropped: restockable, quarantined,
    // rejected (the WHOLE sent amount), and the documented difference.
    expect(norm069).toMatch(/disposition = 'restockable'\s*\n?\s*THEN received_quantity ELSE 0 END\)/);
    expect(norm069).toMatch(/disposition = 'quarantined'\s*\n?\s*THEN received_quantity ELSE 0 END\)/);
    expect(norm069).toMatch(/WHEN status = 'rejected' THEN sent_quantity ELSE 0 END/);
    expect(norm069).toMatch(
      /WHEN status = 'received_with_difference'\s*\n?\s*THEN sent_quantity - received_quantity ELSE 0 END/,
    );
  });

  it('warehouse_transfer_lines materializes a third, unresolved counter as a generated column', () => {
    expect(norm069).toContain('return_unresolved_quantity');
    expect(norm069).toMatch(
      /ADD COLUMN return_unresolved_quantity integer\s+GENERATED ALWAYS AS \(returned_quantity - return_received_quantity\) STORED/,
    );
  });

  it('the conservation CHECK is a proven post-condition, not just present in source', () => {
    expect(m069).toContain("'wrsl_conservation_eq_chk'");
  });
});

// ============================================================================
// 7. Bidirectional initiation: receiver OR sender may open a return
// ============================================================================

describe('7. either side may open a return request, but physical roles never change', () => {
  it('requested_by_side is a structural CHECK, not a free string', () => {
    expect(norm069).toContain('wrr_requested_by_side_chk');
    expect(norm069).toMatch(/CHECK \(requested_by_side IN \('receiver', 'sender'\)\)/);
  });

  it('two distinct RPCs create the SAME row shape with a different requested_by_side', () => {
    const receiverBody = functionBody('phoenix_request_warehouse_return');
    const senderBody = functionBody('phoenix_recall_warehouse_transfer');
    expect(receiverBody).toMatch(/'draft', 'receiver', v_notes, v_actor/);
    expect(senderBody).toMatch(/'draft', 'sender', v_notes, v_actor/);
  });

  it('REQUEST (receiver) authorizes against .return_request scoped to the institution (source)', () => {
    const body = functionBody('phoenix_request_warehouse_return');
    expect(body).toContain("'warehouse_transfer.return_request'");
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'warehouse_transfer\.return_request', v_src_org, p_source_warehouse_id, NULL/,
    );
  });

  it('RECALL (sender) authorizes against .recall scoped to central\'s OWN (destination) warehouse — never the institution\'s', () => {
    const body = functionBody('phoenix_recall_warehouse_transfer');
    expect(body).toContain("'warehouse_transfer.recall'");
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'warehouse_transfer\.recall', v_dest_org, v_route\.source_warehouse_id, NULL/,
    );
  });

  it('SUBMIT and CANCEL branch their permission check on requested_by_side — never a role literal', () => {
    for (const rpc of ['phoenix_submit_warehouse_return_request', 'phoenix_cancel_warehouse_return_request'] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/IF v_request\.requested_by_side = 'receiver' THEN/);
      expect(body, rpc).toContain("'warehouse_transfer.return_request'");
      expect(body, rpc).toContain("'warehouse_transfer.recall'");
    }
  });

  it('REVIEW is ALWAYS scoped to the destination (central) warehouse, regardless of requested_by_side', () => {
    const body = functionBody('phoenix_review_warehouse_return_request');
    expect(body).not.toContain('requested_by_side');
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'warehouse_transfer\.review_return',\s*v_request\.destination_organization_id, v_request\.destination_warehouse_id, NULL/,
    );
  });

  it('SEND is always scoped to the institution (source) warehouse, regardless of who opened the request', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).not.toContain('requested_by_side');
    expect(body).toContain("'warehouse_transfer.return_send'");
  });

  it('RECEIVE is always scoped to central (destination), regardless of who opened the request', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).not.toContain('requested_by_side');
    expect(body).toContain("'warehouse_transfer.return_receive'");
  });
});

// ============================================================================
// 8. Route-active TOCTOU fix applied from the start (068's live-apply lesson)
// ============================================================================

describe('8. route-active checks fetch-and-lock the route row FOR SHARE, from day one', () => {
  const ROUTE_LOCKING_RPCS = [
    'phoenix_request_warehouse_return',
    'phoenix_recall_warehouse_transfer',
    'phoenix_submit_warehouse_return_request',
    'phoenix_send_warehouse_return_shipment_line',
  ] as const;

  it('each fetches AND locks warehouse_supply_routes with FOR SHARE in the same statement', () => {
    for (const rpc of ROUTE_LOCKING_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/FROM public\.warehouse_supply_routes WHERE id = \S+ FOR SHARE/);
    }
  });

  it('none uses FOR UPDATE on warehouse_supply_routes', () => {
    for (const rpc of ROUTE_LOCKING_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toMatch(/FROM public\.warehouse_supply_routes WHERE id = \S+ FOR UPDATE/);
    }
  });

  it('RECEIVE never references warehouse_supply_routes at all', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).not.toContain('warehouse_supply_routes');
    expect(body).not.toContain('supply_route_inactive');
  });
});

// ============================================================================
// 9. Return-send deliberately allows expired batches (unlike 068's forward SEND)
// ============================================================================

describe('9. return-send has NO expiry-refusal — a named divergence from 068', () => {
  it('phoenix_send_warehouse_return_shipment_line contains no expiry check', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).not.toMatch(/expiry_date < current_date/);
    expect(body).not.toContain('expired_batch_cannot_be_sent');
  });

  it('the file header documents this as deliberate, not an oversight', () => {
    expect(m069).toMatch(/therefore has NO expiry/);
    expect(m069.toLowerCase()).toContain('deliberately has no expiry-refusal check');
  });
});

// ============================================================================
// 10. Reused, not widened: 'dispatch_return' and 'add' movement types
// ============================================================================

describe('10. reuses 060/065/068 movement_type vocabulary instead of widening the CHECK', () => {
  it('never issues ALTER on warehouse_stock_movements_type_chk', () => {
    expect(exec069).not.toMatch(/warehouse_stock_movements_type_chk/);
  });

  it('return-send uses the already-existing dispatch_return movement_type', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toMatch(/v_stock\.warehouse_id, 'dispatch_return'/);
  });

  it('return-receive reuses the already-existing add movement_type', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/v_stock\.warehouse_id, 'add'/);
  });
});

// ============================================================================
// 11. Idempotency — same contract as 068, new reference types
// ============================================================================

describe('11. one request produces at most one movement, everywhere', () => {
  it('adds a unique idempotency index for the two new reference types', () => {
    expect(norm069).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_return_once_uniq/,
    );
    const idx = norm069.slice(
      norm069.indexOf('warehouse_stock_movements_return_once_uniq'),
    );
    expect(idx).toContain('warehouse_return_send');
    expect(idx).toContain('warehouse_return_receive');
  });

  it('one return shipment line can be received at most once, independent of request id', () => {
    expect(norm069).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_return_line_once_uniq/,
    );
  });

  it('adds a fingerprint CHECK for the new reference types, additively', () => {
    expect(norm069).toContain('warehouse_stock_movements_return_fingerprint_chk');
    expect(norm069).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('068\'s own idempotency contract (transfer_once_uniq) is left untouched', () => {
    expect(exec069).not.toMatch(/DROP.*warehouse_stock_movements_transfer_once_uniq/i);
  });

  it('both write RPCs compute a fingerprint and fail closed on replay conflict', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('encode(sha256(convert_to(jsonb_build_object(');
      expect(body, rpc).toContain('request_fingerprint');
      expect(body, rpc).toContain('request_id_conflict');
    }
  });

  it('both write RPCs take the advisory lock BEFORE any row lock', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body.indexOf('pg_advisory_xact_lock'), rpc).toBeGreaterThan(-1);
      expect(body.indexOf('FOR UPDATE'), rpc).toBeGreaterThan(-1);
      expect(body.indexOf('pg_advisory_xact_lock'), rpc).toBeLessThan(body.indexOf('FOR UPDATE'));
    }
  });

  it('uses the SAME advisory-lock namespace convention (69069), distinct from 065/067/068', () => {
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS]) {
      expect(functionBody(rpc), rpc).toContain('69069');
    }
  });
});

// ============================================================================
// 12. The original receipt cannot be over-returned
// ============================================================================

describe('12. a specific prior receipt cannot be returned more than it received', () => {
  it('ADD LINE bounds requested_quantity by (received_quantity - returned_quantity)', () => {
    const body = functionBody('phoenix_add_warehouse_return_request_line');
    expect(body).toMatch(
      /v_remaining := COALESCE\(v_orig\.received_quantity, 0\) - v_orig\.returned_quantity/,
    );
    expect(body).toContain('requested_quantity_exceeds_returnable');
  });

  it('ADD LINE proves the original receipt belongs to THIS institution before trusting it (IDOR)', () => {
    const body = functionBody('phoenix_add_warehouse_return_request_line');
    expect(body).toContain('original_line_not_at_this_institution');
    expect(body).toContain('original_line_not_received');
  });

  it('SEND re-checks the same ceiling against the LIVE original line under its own row lock', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toContain('original_line_would_be_over_returned');
    expect(body).toMatch(
      /IF v_orig\.returned_quantity \+ p_quantity > COALESCE\(v_orig\.received_quantity, 0\) THEN/,
    );
  });

  it('SEND increments returned_quantity on the ORIGINAL line, exactly once per send', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toMatch(
      /UPDATE public\.warehouse_transfer_lines\s+SET returned_quantity = returned_quantity \+ p_quantity/,
    );
  });
});

// ============================================================================
// 13. The send RPC refuses to over-fulfil a RETURN request line
// ============================================================================

describe('13. the return-send RPC refuses to over-fulfil a return request line', () => {
  it('bounds fulfilled_quantity by approved_quantity, never requested_quantity', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toContain('return_line_would_be_over_fulfilled');
    expect(body).toMatch(
      /IF v_reqline\.fulfilled_quantity \+ p_quantity > v_reqline\.approved_quantity THEN/,
    );
  });

  it('requires the return request line to be approved or partially_fulfilled first', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toContain('return_request_line_not_approved');
    expect(body).toMatch(/IF v_reqline\.status NOT IN \('approved', 'partially_fulfilled'\) THEN/);
  });

  it('pins the return-send to the SAME route as the return request line', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toMatch(/JOIN public\.warehouse_return_requests r ON r\.id = l\.return_request_id/);
    expect(body).toMatch(/WHERE l\.id = p_return_request_line_id AND r\.route_id = p_route_id/);
  });

  it('proves the stock sits in the route TARGET (institution) warehouse before shipping — reversed IDOR gate', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toContain('stock_not_in_route_target_warehouse');
    expect(body).toMatch(/IF v_stock\.warehouse_id IS DISTINCT FROM v_route\.target_warehouse_id THEN/);
  });
});

// ============================================================================
// 14. The receive RPC enforces separation of duty and bounds by sent quantity
// ============================================================================

describe('14. the receive RPC enforces separation of duty and cannot exceed sent quantity', () => {
  it('a return shipment line leaves in_transit exactly once', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toContain('return_shipment_line_already_received');
    expect(body).toMatch(/IF v_line\.status <> '.*?' THEN/);
  });

  it('received_quantity cannot exceed sent_quantity', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toContain('received_quantity_exceeds_sent');
  });

  it('a difference from sent_quantity requires a reason', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toContain('difference_reason_required');
  });

  it('is scoped to the DESTINATION (central) warehouse taken from the shipment, never a client parameter', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/v_shipment\.destination_organization_id,\s*v_shipment\.destination_warehouse_id/);
  });
});

// ============================================================================
// 15. RLS/ACL/RPC — no anon, no direct authenticated write, no PUBLIC EXECUTE
// ============================================================================

describe('15. RLS and grants match 068\'s contract exactly', () => {
  it('RLS is enabled on all four new tables', () => {
    for (const t of [
      'warehouse_return_requests', 'warehouse_return_request_lines',
      'warehouse_return_shipments', 'warehouse_return_shipment_lines',
    ]) {
      expect(norm069).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
  });

  it('authenticated is granted SELECT only, and explicitly denied write, on all four tables', () => {
    for (const t of [
      'warehouse_return_requests', 'warehouse_return_request_lines',
      'warehouse_return_shipments', 'warehouse_return_shipment_lines',
    ]) {
      expect(norm069).toMatch(new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated`));
      expect(norm069).toMatch(
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`),
      );
    }
  });

  it('anon is revoked ALL on all four tables', () => {
    for (const t of [
      'warehouse_return_requests', 'warehouse_return_request_lines',
      'warehouse_return_shipments', 'warehouse_return_shipment_lines',
    ]) {
      expect(norm069).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });

  it('every RPC is REVOKEd from PUBLIC/anon and GRANTed to authenticated only', () => {
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS, 'phoenix_add_warehouse_return_request_line', 'phoenix_delete_warehouse_return_request_line']) {
      const revokeIdx = active069.indexOf(`REVOKE ALL ON FUNCTION public.${rpc}(`);
      const grantIdx = active069.indexOf(`GRANT EXECUTE ON FUNCTION public.${rpc}(`);
      expect(revokeIdx, rpc).toBeGreaterThan(-1);
      expect(grantIdx, rpc).toBeGreaterThan(-1);
      expect(active069.slice(revokeIdx, revokeIdx + 400)).toContain('FROM PUBLIC, anon');
      expect(active069.slice(grantIdx, grantIdx + 400)).toContain('TO authenticated');
    }
  });

  it('phoenix_can_read_warehouse_return checks FIVE scoped permission keys, two-sided by side', () => {
    const body = functionBody('phoenix_can_read_warehouse_return');
    for (const key of [
      'warehouse_transfer.return_request', 'warehouse_transfer.return_send',
      'warehouse_transfer.recall', 'warehouse_transfer.review_return',
      'warehouse_transfer.return_receive',
    ]) {
      expect(body, key).toContain(`'${key}'`);
    }
    expect(body).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('every RPC is SECURITY DEFINER with a pinned search_path, actor via auth.uid()', () => {
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS]) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('SECURITY DEFINER');
      expect(body, rpc).toContain('SET search_path = public, pg_temp');
      expect(body, rpc).toContain('auth.uid()');
    }
  });

  it('no RPC uses dynamic SQL', () => {
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS]) {
      expect(functionBody(rpc), rpc).not.toMatch(/EXECUTE\s+format|EXECUTE\s+'/);
    }
  });
});

// ============================================================================
// 16. Separation of duty is a role default, not just an RPC check
// ============================================================================

describe('16. separation of duty is proven at apply time, per role', () => {
  it('adds five new permission keys, distinct module=warehouse_transfer', () => {
    for (const key of [
      'warehouse_transfer.return_request', 'warehouse_transfer.recall',
      'warehouse_transfer.review_return', 'warehouse_transfer.return_send',
      'warehouse_transfer.return_receive',
    ]) {
      expect(norm069).toContain(`'${key}'`);
    }
  });

  it('warehouse_officer gets return_request/return_send only, never recall/review/receive', () => {
    expect(norm069).toMatch(/\('warehouse_officer', 'warehouse_transfer\.return_request', true\)/);
    expect(norm069).toMatch(/\('warehouse_officer', 'warehouse_transfer\.return_send', true\)/);
    expect(norm069).toMatch(/\('warehouse_officer', 'warehouse_transfer\.recall', false\)/);
    expect(norm069).toMatch(/\('warehouse_officer', 'warehouse_transfer\.review_return', false\)/);
    expect(norm069).toMatch(/\('warehouse_officer', 'warehouse_transfer\.return_receive', false\)/);
  });

  it('central_warehouse_manager gets recall/review/receive only, never return_request/return_send', () => {
    expect(norm069).toMatch(/\('central_warehouse_manager', 'warehouse_transfer\.recall', true\)/);
    expect(norm069).toMatch(/\('central_warehouse_manager', 'warehouse_transfer\.review_return', true\)/);
    expect(norm069).toMatch(/\('central_warehouse_manager', 'warehouse_transfer\.return_receive', true\)/);
    expect(norm069).toMatch(/\('central_warehouse_manager', 'warehouse_transfer\.return_request', false\)/);
    expect(norm069).toMatch(/\('central_warehouse_manager', 'warehouse_transfer\.return_send', false\)/);
  });

  it('every pre-existing legacy role is explicitly denied all five new keys', () => {
    expect(norm069).toMatch(
      /CROSS JOIN \(VALUES \('warehouse_transfer\.return_request'\),\('warehouse_transfer\.recall'\),\s+\('warehouse_transfer\.review_return'\),\('warehouse_transfer\.return_send'\),\s+\('warehouse_transfer\.return_receive'\)\) AS k\(key\)/,
    );
  });

  it('the post-conditions assert the requester side cannot recall/review/receive its own return', () => {
    expect(m069).toContain('ABORT 069: warehouse_officer must not recall its own institution');
    expect(m069).toContain('ABORT 069: warehouse_officer must not review its own return');
    expect(m069).toContain('ABORT 069: warehouse_officer must not receive its own return');
    expect(m069).toContain('ABORT 069: central_warehouse_manager must not open a receiver-side return request');
    expect(m069).toContain('ABORT 069: central_warehouse_manager must not physically send a return');
  });
});

// ============================================================================
// 17. 069 breaks nothing that exists today
// ============================================================================

describe('17. 069 breaks nothing that exists today', () => {
  it('revokes nothing from an object it did not itself create', () => {
    const created = [
      'public.warehouse_return_requests',
      'public.warehouse_return_request_lines',
      'public.warehouse_return_shipments',
      'public.warehouse_return_shipment_lines',
      'public.warehouse_quarantine_stock',
      'public.warehouse_quarantine_stock_movements',
      'public.phoenix_request_warehouse_return',
      'public.phoenix_recall_warehouse_transfer',
      'public.phoenix_add_warehouse_return_request_line',
      'public.phoenix_delete_warehouse_return_request_line',
      'public.phoenix_submit_warehouse_return_request',
      'public.phoenix_cancel_warehouse_return_request',
      'public.phoenix_review_warehouse_return_request',
      'public.phoenix_send_warehouse_return_shipment_line',
      'public.phoenix_receive_warehouse_return_shipment_line',
      'public.phoenix_can_read_warehouse_return',
    ];
    const revokes = [...active069.matchAll(/REVOKE [^;]*? ON (?:TABLE |FUNCTION )?(public\.\w+)/g)].map(
      m => m[1],
    );
    expect(revokes.length).toBeGreaterThan(0);
    for (const target of revokes) {
      expect(created, `REVOKE touched a pre-existing object: ${target}`).toContain(target);
    }
  });

  it('no DROP or RENAME anywhere in the file', () => {
    expect(exec069).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|VIEW|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(exec069).not.toMatch(/\bRENAME\b/i);
  });

  it('does not touch outlet_stock, warehouse_dispatch, or their RPCs at all', () => {
    expect(exec069).not.toMatch(/ALTER TABLE public\.outlet_stock\b/);
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_dispatch\w*\b/);
    expect(exec069).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_\w*outlet\w*/);
    expect(exec069).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_\w*dispatch\w*/);
  });

  it('does not touch warehouse_stock via ALTER, only through RPC bodies', () => {
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_stock\b(?!_movements)/);
  });

  it('writes no application data and backfills no route', () => {
    let outsideFunctions = exec069;
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS, 'phoenix_add_warehouse_return_request_line', 'phoenix_delete_warehouse_return_request_line']) {
      const body = sqlFunctionSource(exec069, rpc);
      if (body) outsideFunctions = outsideFunctions.replace(body, '');
    }
    const inserts = [...outsideFunctions.matchAll(/INSERT INTO public\.(\w+)/g)].map(m => m[1]);
    expect(inserts).not.toContain('warehouse_supply_routes');
    expect(inserts).not.toContain('warehouse_return_requests');
    expect(inserts).not.toContain('warehouse_return_request_lines');
    expect(new Set(inserts)).toEqual(new Set(['permission_keys', 'role_permission_defaults']));
  });

  it('leaves RBAC enforcement OFF', () => {
    expect(exec069).not.toMatch(/rbac_enforcement|enforcement_enabled|SCOPED_RBAC_MODE/i);
    expect(m069).toMatch(/No RBAC enforcement change\. Enforcement stays OFF/);
  });

  it('the public QR path stays untouched and leaks nothing about returns', () => {
    expect(exec069).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/);
    expect(m069).toContain('VERIFY FAILED (069): return or quarantine data leaked into public QR');
  });

  it('068\'s SEND RPC retains authenticated EXECUTE (post-condition proves it, not just assumes it)', () => {
    expect(m069).toContain('ABORT 069: 068 phoenix_send_warehouse_transfer_line lost authenticated EXECUTE');
  });
});

// ============================================================================
// 18. Scope explicitly deferred — outlet return is NOT built here
// ============================================================================

describe('18. outlet -> institution return is explicitly out of scope for this file', () => {
  it('states the deferral in the file header', () => {
    expect(m069.toLowerCase()).toContain('outlet -> institution return');
    expect(m069.toLowerCase()).toContain('follow-up migration');
  });

  it('creates no outlet-side return RPC', () => {
    expect(exec069).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_\w*outlet\w*return\w*/i);
  });

  it('does not touch outlet_stock_movements or its already-reserved return_send movement_type', () => {
    expect(exec069).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\b/);
  });
});

// ============================================================================
// 19. 069 states its own contract at apply time (unexecuted)
// ============================================================================

describe('19. 069 states its own contract at apply time (unexecuted)', () => {
  it('runs a verification block inside the transaction', () => {
    expect(active069).toContain('$verify$');
    expect(active069.indexOf('$verify$')).toBeLessThan(active069.lastIndexOf('commit;'));
  });

  it('keeps every post-condition that guards a boundary in this file', () => {
    for (const assertion of [
      'ABORT 069: expected 060/066/068 schema is absent',
      'ABORT 069: missing per-side organization pin',
      'ABORT 069: return route enforcement is not a composite FK',
      'ABORT 069: return idempotency index missing',
      'ABORT 069: anon can read',
      'VERIFY FAILED (069): authenticated holds a direct return/quarantine write privilege',
    ]) {
      expect(m069, assertion).toContain(assertion);
    }
  });

  it('checks the exact RPC signatures, so an overload cannot satisfy it', () => {
    expect(m069).toContain(
      'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)',
    );
    expect(m069).toContain(
      'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)',
    );
  });
});

// ============================================================================
// 20. Route deactivation must NOT block a legitimate historical return
// ============================================================================
// A first draft of 069 mirrored 068's forward-supply rule of requiring an
// ACTIVE route — wrong for a return: deactivating a route stops NEW forward
// supply, it must never retroactively forbid returning/recalling material
// that already moved along it. Caught in review before merge; these tests
// pin the fix down so it cannot regress.

describe('20. route deactivation does not block request/recall/submit/send of a historical return', () => {
  const ROUTE_TOUCHING_RETURN_RPCS = [
    'phoenix_request_warehouse_return',
    'phoenix_recall_warehouse_transfer',
    'phoenix_submit_warehouse_return_request',
    'phoenix_send_warehouse_return_shipment_line',
  ] as const;

  it('none of the four gates on route is_active', () => {
    for (const rpc of ROUTE_TOUCHING_RETURN_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toContain('supply_route_inactive');
      expect(body, rpc).not.toMatch(/IF NOT v_route\.is_active THEN/);
    }
  });

  it('each still fetches AND locks the route row FOR SHARE — the lock is kept for identity/consistency, only the is_active gate is removed', () => {
    for (const rpc of ROUTE_TOUCHING_RETURN_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/FROM public\.warehouse_supply_routes WHERE id = \S+ FOR SHARE/);
    }
  });

  it('CREATE/RECALL/SEND still refuse a route that does not exist at all (NOT FOUND), just not an inactive one', () => {
    // SUBMIT is excluded deliberately: it reads route_id off an already
    // FK-validated warehouse_return_requests row, so the route is
    // guaranteed to exist — a NOT FOUND check there would be dead code,
    // unlike CREATE/RECALL/SEND where p_route_id is a client-supplied,
    // untrusted uuid.
    for (const rpc of ['phoenix_request_warehouse_return', 'phoenix_recall_warehouse_transfer', 'phoenix_send_warehouse_return_shipment_line'] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('supply_route_not_found');
    }
  });

  it('RECALL still proves the source warehouse is the route\'s own target (IDOR-safe), independent of is_active', () => {
    const body = functionBody('phoenix_recall_warehouse_transfer');
    expect(body).toMatch(/IF p_source_warehouse_id IS DISTINCT FROM v_route\.target_warehouse_id THEN/);
  });

  it('the post-conditions assert this for all four RPCs, not just document it in a comment', () => {
    expect(m069).toContain(
      'VERIFY FAILED (069): gates a legitimate historical return on route is_active',
    );
  });
});

// ============================================================================
// 21. Quarantine-disposition guard — expired/quality-flagged returns cannot
//     become dispensable stock
// ============================================================================
// Return-SEND deliberately allows an expired or quality-flagged batch (see
// section 9) — but allowing it to be SENT is not the same as allowing it to
// be CREDITED into the same on_hand pool ordinary dispensable stock draws
// from. 069 carries no quarantine balance of its own (071's job); RECEIVE
// must refuse to accept such a batch into inventory rather than improvise a
// temporary representation that would have to be redesigned later.

// ============================================================================
// 21. RECEIVE classifies restockable vs quarantined — never a dead end
// ============================================================================
// An earlier revision simply REFUSED to complete receipt of an expired/
// quality-flagged return, which meant SEND could accept a batch RECEIVE
// could never resolve — stock stuck in_transit forever. Fixed in review:
// RECEIVE now classifies every accepted quantity into exactly one of two
// balances and credits the correct one, always.

describe('21. RECEIVE classifies every accepted quantity as restockable or quarantined', () => {
  const MANDATORY_QUARANTINE_REASONS = [
    'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion',
  ] as const;

  it('the old block-and-refuse guard is gone — no dead-end error text remains anywhere', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).not.toContain('return_receipt_of_expired_batch_requires_quarantine_disposition_deferred_to_071');
    expect(body).not.toContain('return_receipt_of_quality_flagged_batch_requires_quarantine_disposition_deferred_to_071');
    expect(body).not.toContain('requires_quarantine_disposition_deferred_to_071');
  });

  it('classifies objectively-expired-at-receipt as mandatory quarantine, independent of stated reason', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(
      /v_objectively_expired := v_line\.expiry_date IS NOT NULL AND v_line\.expiry_date < current_date/,
    );
    expect(body).toMatch(/v_mandatory_quarantine := v_objectively_expired\s+OR v_reason_code IN/);
  });

  it('every mandatory-quarantine reason is named explicitly — none can be missed silently', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    for (const reason of MANDATORY_QUARANTINE_REASONS) {
      expect(body, reason).toMatch(new RegExp(`v_reason_code IN \\([^)]*'${reason}'`));
    }
  });

  it('the client CANNOT override a mandatory-quarantine reason via p_disposition_decision', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    // p_disposition_decision is only read inside the near_expiry ELSIF
    // branch — never inside the v_mandatory_quarantine branch.
    const mandatoryBranch = body.slice(
      body.indexOf('IF v_mandatory_quarantine THEN'),
      body.indexOf('ELSIF v_reason_code'),
    );
    expect(mandatoryBranch).not.toContain('p_disposition_decision');
    expect(mandatoryBranch).toContain("v_disposition := 'quarantined'");
  });

  it('near_expiry requires an explicit p_disposition_decision — no silent default', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toContain('near_expiry_return_requires_explicit_disposition_decision');
    expect(body).toMatch(
      /ELSIF v_reason_code = 'near_expiry' THEN\s+IF p_disposition_decision IS NULL THEN/,
    );
  });

  it('excess/shipment_error/other default to restockable when not objectively expired', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/ELSE\s+v_disposition := 'restockable';\s+END IF;/);
  });

  it('classification happens BEFORE either credit branch — restockable and quarantine both', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const classifyIdx = body.indexOf('v_mandatory_quarantine := v_objectively_expired');
    const stockInsertIdx = body.indexOf('INSERT INTO public.warehouse_stock (');
    const quarantineInsertIdx = body.indexOf('INSERT INTO public.warehouse_quarantine_stock (');
    expect(classifyIdx).toBeGreaterThan(-1);
    expect(stockInsertIdx).toBeGreaterThan(-1);
    expect(quarantineInsertIdx).toBeGreaterThan(-1);
    expect(classifyIdx).toBeLessThan(stockInsertIdx);
    expect(classifyIdx).toBeLessThan(quarantineInsertIdx);
  });

  it('restockable credits warehouse_stock.on_hand_quantity; quarantined credits warehouse_quarantine_stock.quantity — never both, never neither', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/IF v_disposition = 'restockable' THEN[\s\S]*UPDATE public\.warehouse_stock/);
    expect(body).toMatch(/ELSE[\s\S]*UPDATE public\.warehouse_quarantine_stock/);
  });

  it('rejection (received_quantity = 0) touches NEITHER balance and is tracked exception_pending', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const rejectIdx = body.indexOf('IF p_received_quantity = 0 THEN');
    const rejectReturnIdx = body.indexOf('RETURN jsonb_build_object', rejectIdx);
    const classifyIdx = body.indexOf('v_mandatory_quarantine := v_objectively_expired');
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(rejectReturnIdx).toBeGreaterThan(rejectIdx);
    // The rejection branch RETURNs before classification is ever reached.
    expect(rejectReturnIdx).toBeLessThan(classifyIdx);
    expect(body.slice(rejectIdx, rejectReturnIdx)).toContain("custody_state = 'exception_pending'");
    expect(body.slice(rejectIdx, rejectReturnIdx)).not.toContain('warehouse_stock');
    expect(body.slice(rejectIdx, rejectReturnIdx)).not.toContain('warehouse_quarantine_stock');
  });

  it('a rejected return is never silently sent back to the institution\'s own warehouse_stock', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const rejectIdx = body.indexOf('IF p_received_quantity = 0 THEN');
    const rejectReturnIdx = body.indexOf('RETURN jsonb_build_object', rejectIdx);
    expect(body.slice(rejectIdx, rejectReturnIdx)).not.toMatch(/UPDATE public\.warehouse_stock/);
  });

  it('no code path anywhere in 069 credits warehouse_stock.on_hand_quantity except the restockable branch', () => {
    const creditSites = [...exec069.matchAll(/SET on_hand_quantity = v_after/g)];
    expect(creditSites.length).toBe(2); // one in SEND (debit), one in RECEIVE restockable (credit)
  });

  it('quarantine crediting happens exactly once in the whole file', () => {
    const creditSites = [...exec069.matchAll(/SET quantity = v_after, updated_by = v_actor/g)];
    expect(creditSites.length).toBe(1);
  });

  it('idempotency replay checks BOTH ledgers — a prior quarantine credit must not be re-creditable as restockable, or vice versa', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/FROM public\.warehouse_stock_movements m\s+WHERE m\.reference_type = 'warehouse_return_receive'/);
    expect(body).toMatch(
      /FROM public\.warehouse_quarantine_stock_movements m\s+WHERE m\.reference_type = 'warehouse_return_quarantine_receive'/,
    );
  });

  it('the quarantine ledger reuses the SAME fingerprint/idempotency discipline as every other movement', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toContain("'quarantine_receive'");
    expect(body).toMatch(/INSERT INTO public\.warehouse_quarantine_stock_movements[\s\S]*RETURNING id INTO v_movement_id/);
  });

  it('the file header documents this as the fixed design, not the old dead-end limitation', () => {
    expect(m069).toContain('An earlier revision of this file simply REFUSED');
    expect(m069.toLowerCase()).toContain('quarantine');
    expect(m069).not.toContain('This is a deliberate temporary limitation, not a workaround');
  });

  it('the post-conditions assert classification exists and precedes both credit branches', () => {
    expect(m069).toContain(
      'VERIFY FAILED (069): return-receive does not classify disposition at all',
    );
    expect(m069).toContain(
      'VERIFY FAILED (069): disposition is not classified before the stock credit',
    );
    expect(m069).toContain(
      'VERIFY FAILED (069): disposition is not classified before the quarantine credit',
    );
  });
});

// ============================================================================
// 22. warehouse_quarantine_stock — non-dispensable, RLS-scoped, no client write
// ============================================================================

describe('22. warehouse_quarantine_stock is structurally isolated from ordinary stock', () => {
  it('is a SEPARATE table, never a flag/column on warehouse_stock', () => {
    expect(exec069).not.toMatch(/ALTER TABLE public\.warehouse_stock ADD COLUMN \w*quarantine\w*/i);
    expect(norm069).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_quarantine_stock/);
  });

  it('quantity can never go negative', () => {
    expect(norm069).toContain('wqs_quantity_nonneg_chk');
    expect(norm069).toMatch(/CHECK \(quantity >= 0\)/);
  });

  it('quarantine_reason is a closed, structural vocabulary', () => {
    expect(norm069).toContain('wqs_reason_chk');
    expect(norm069).toMatch(
      /CHECK \(quarantine_reason IN \(\s*'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'\s*\)\)/,
    );
  });

  it('identity includes quarantine_reason — two different reasons for the same batch never silently merge', () => {
    expect(norm069).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wqs_identity_uniq\s+ON public\.warehouse_quarantine_stock \([\s\S]*?quarantine_reason[\s\S]*?\);/,
    );
  });

  it('RLS is enabled, authenticated is SELECT-only, anon has nothing', () => {
    for (const t of ['warehouse_quarantine_stock', 'warehouse_quarantine_stock_movements']) {
      expect(norm069).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(norm069).toMatch(new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated`));
      expect(norm069).toMatch(
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`),
      );
      expect(norm069).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });

  it('the movement_type CHECK pre-seeds release/destroy/correction for 071, exactly like 060 pre-seeded dispatch_return for 069', () => {
    expect(norm069).toContain('wqsm_type_chk');
    expect(norm069).toMatch(
      /CHECK \(movement_type IN \(\s*'quarantine_receive', 'quarantine_release', 'quarantine_destroy', 'quarantine_correction'\s*\)\)/,
    );
  });

  it('only quarantine_receive is ever written by any RPC in this file', () => {
    expect(exec069).not.toContain("'quarantine_release'");
    expect(exec069).not.toContain("'quarantine_destroy'");
    expect(exec069).not.toContain("'quarantine_correction'");
  });

  it('the ledger enforces after = before + delta and never goes negative, same discipline as warehouse_stock_movements', () => {
    expect(norm069).toContain('wqsm_after_eq_before_plus_delta_chk');
    expect(norm069).toContain('wqsm_after_nonneg_chk');
  });

  it('has its own fingerprint CHECK and idempotency index, reusing the exact pattern from section 7', () => {
    expect(norm069).toContain('wqsm_fingerprint_chk');
    expect(norm069).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS wqsm_receive_once_uniq/);
  });
});

// ============================================================================
// 23. Conservation — separate counters, never one column for two meanings
// ============================================================================

describe('23. returned_quantity (committed) and return_received_quantity (actually received) are kept structurally separate', () => {
  it('return_received_quantity is its own additive column, distinct from returned_quantity', () => {
    expect(norm069).toMatch(
      /ALTER TABLE public\.warehouse_transfer_lines\s+ADD COLUMN return_received_quantity integer NOT NULL DEFAULT 0/,
    );
  });

  it('return_received_quantity can never exceed returned_quantity — received can never outrun committed', () => {
    expect(norm069).toContain('wtl_return_received_qty_chk');
    expect(norm069).toMatch(
      /CHECK \(return_received_quantity >= 0 AND return_received_quantity <= returned_quantity\)/,
    );
  });

  it('returned_quantity is incremented ONLY in SEND; return_received_quantity is incremented ONLY in RECEIVE', () => {
    const sendBody = functionBody('phoenix_send_warehouse_return_shipment_line');
    const receiveBody = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(sendBody).toMatch(/SET returned_quantity = returned_quantity \+ p_quantity/);
    expect(sendBody).not.toContain('return_received_quantity');
    expect(receiveBody).toMatch(
      /SET return_received_quantity = return_received_quantity \+ p_received_quantity/,
    );
    expect(receiveBody).not.toMatch(/SET returned_quantity = returned_quantity/);
  });

  it('the transitive cap holds structurally: returned <= received, and return_received <= returned <= received', () => {
    // wtl_returned_qty_chk:        returned_quantity        <= received_quantity
    // wtl_return_received_qty_chk: return_received_quantity <= returned_quantity
    // => return_received_quantity is transitively capped at received_quantity
    //    without needing a THIRD, redundant CHECK that could drift out of sync.
    expect(norm069).toContain('wtl_returned_qty_chk');
    expect(norm069).toContain('wtl_return_received_qty_chk');
  });

  it('RECEIVE locks the ORIGINAL line FOR UPDATE before incrementing return_received_quantity — same discipline as SEND', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(
      /FROM public\.warehouse_transfer_lines WHERE id = v_line\.original_transfer_line_id FOR UPDATE/,
    );
  });

  it('RECEIVE increments return_received_quantity for EITHER disposition (restockable or quarantined) — both mean central now has custody', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const updateIdx = body.indexOf('SET return_received_quantity = return_received_quantity');
    const restockableCreditIdx = body.indexOf("v_disposition := 'restockable'");
    // The increment happens in the SHARED TAIL, after both branches, not
    // duplicated inside each — so it fires exactly once regardless of which
    // branch executed.
    expect(updateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(restockableCreditIdx);
    const occurrences = [...body.matchAll(/SET return_received_quantity = return_received_quantity/g)];
    expect(occurrences.length).toBe(1);
  });
});

// ============================================================================
// 24. Custody — an explicit answer to "where does this quantity sit right now?"
// ============================================================================

describe('24. custody_state is explicit and exhaustive across the whole lifecycle', () => {
  it('the four custody states are structurally closed', () => {
    expect(norm069).toContain('wrsl_custody_state_chk');
    expect(norm069).toMatch(
      /CHECK \(custody_state IN \(\s*'in_transit', 'destination_stock', 'destination_quarantine', 'exception_pending'\s*\)\)/,
    );
  });

  it('the decision CHECK ties status, disposition and custody_state together — none can drift independently', () => {
    expect(norm069).toContain('wrsl_decision_chk');
    expect(norm069).toMatch(/disposition = 'restockable'\s+AND custody_state = 'destination_stock'/);
    expect(norm069).toMatch(/disposition = 'quarantined' AND custody_state = 'destination_quarantine'/);
  });

  it('in_transit is the DEFAULT custody_state — a shipment line is born in that state at SEND', () => {
    expect(norm069).toMatch(/custody_state\s+text NOT NULL DEFAULT 'in_transit'/);
  });

  it('SEND never sets custody_state directly — the row default IS the in_transit state', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).not.toContain('custody_state');
  });

  it('every terminal RECEIVE outcome sets custody_state explicitly — never left at its default', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/custody_state = 'exception_pending'/);
    expect(body).toMatch(/custody_state = 'destination_stock'/);
    expect(body).toMatch(/custody_state = 'destination_quarantine'/);
  });
});

// ============================================================================
// 25. Concurrency and double-return protection
// ============================================================================

describe('25. row locks prevent double-return and double-receive under concurrency', () => {
  it('ADD LINE locks the original line FOR UPDATE while computing remaining returnable quantity', () => {
    const body = functionBody('phoenix_add_warehouse_return_request_line');
    expect(body).toMatch(
      /FROM public\.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE/,
    );
  });

  it('SEND re-locks and re-validates the LIVE original line — a second concurrent send cannot both pass the same cap', () => {
    const body = functionBody('phoenix_send_warehouse_return_shipment_line');
    expect(body).toMatch(
      /FROM public\.warehouse_transfer_lines WHERE id = v_reqline\.original_transfer_line_id FOR UPDATE/,
    );
    expect(body).toContain('original_line_would_be_over_returned');
  });

  it('a return request line can only be named against a given original line ONCE per request — structural, not RPC discipline', () => {
    expect(norm069).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wrrl_request_original_line_uniq\s+ON public\.warehouse_return_request_lines \(return_request_id, original_transfer_line_id\)/,
    );
  });

  it('a shipment line can never leave in_transit twice — RECEIVE row-locks it and checks status before any credit', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(
      /FROM public\.warehouse_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE/,
    );
    expect(body).toContain('return_shipment_line_already_received');
    const lockIdx = body.indexOf('FROM public.warehouse_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE');
    const statusCheckIdx = body.indexOf('return_shipment_line_already_received');
    expect(lockIdx).toBeLessThan(statusCheckIdx);
  });

  it('both write RPCs take the advisory lock (69069 namespace) BEFORE any row lock, serializing retries of the same request', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body.indexOf('pg_advisory_xact_lock')).toBeGreaterThan(-1);
      expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('FOR UPDATE'));
    }
  });

  it('a duplicate request_id with a DIFFERENT payload is rejected (23505), never silently re-executed', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('request_id_conflict');
    }
  });
});

// ============================================================================
// 26. Reason-code vocabulary is exercised in full, not just quality_issue
// ============================================================================

describe('26. every reason_code has an explicit, testable quarantine rule', () => {
  it('the request-line reason_code CHECK covers the full vocabulary', () => {
    expect(norm069).toContain('wrrl_reason_code_chk');
    expect(norm069).toMatch(
      /CHECK \(reason_code IN \(\s*'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*'recalled', 'quality_issue', 'temperature_excursion', 'other'\s*\)\)/,
    );
  });

  it('mandatory-quarantine reasons (expired/damaged/recalled/quality_issue/temperature_excursion) all appear in the SAME IN-list in RECEIVE', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const match = body.match(/v_mandatory_quarantine := v_objectively_expired\s+OR v_reason_code IN \(([^)]*)\)/);
    expect(match, 'mandatory quarantine IN-list must exist').not.toBeNull();
    const list = match![1];
    for (const reason of ['expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion']) {
      expect(list, reason).toContain(`'${reason}'`);
    }
  });

  it('near_expiry is handled in its own explicit branch, distinct from the mandatory set and the default', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    expect(body).toMatch(/ELSIF v_reason_code = 'near_expiry' THEN/);
  });

  it('excess and shipment_error are NOT in the mandatory-quarantine list — they fall through to the restockable default', () => {
    const body = functionBody('phoenix_receive_warehouse_return_shipment_line');
    const match = body.match(/v_mandatory_quarantine := v_objectively_expired\s+OR v_reason_code IN \(([^)]*)\)/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("'excess'");
    expect(match![1]).not.toContain("'shipment_error'");
  });
});

// ============================================================================
// 27. QR stays silent on returns AND quarantine, explicitly
// ============================================================================

describe('27. public QR payload leaks nothing about returns or quarantine', () => {
  it('the post-condition checks BOTH warehouse_return and quarantine substrings, not just one', () => {
    expect(m069).toMatch(
      /ASSERT v_def NOT ILIKE '%warehouse_return%' AND v_def NOT ILIKE '%quarantine%'/,
    );
  });

  it('no RPC in this file writes to or reads from item_availability or the public QR path', () => {
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS]) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toContain('item_availability');
      expect(body, rpc).not.toContain('get_public_qr_payload');
    }
  });
});
