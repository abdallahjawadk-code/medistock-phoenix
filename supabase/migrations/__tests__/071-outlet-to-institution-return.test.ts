/**
 * OUTLET-TO-INSTITUTION-RETURN-071-A
 *
 * Static SQL-source tests for migration 071 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 044-070.
 *
 * 071 completes the outlet leg of the return domain 069 deferred: outlet ->
 * institution returns/recalls, reusing distribution_points.warehouse_id as the
 * structural pairing (no new route table). Authored AFTER 070 shipped the
 * forward dispatch SEND/RECEIVE path, so provenance is now a SINGLE PROVEN
 * chain — a real 070 warehouse_dispatch_line, its matching 'dispatch_receive'
 * outlet_stock_movement, and the shared outlet_stock row, pinned together by
 * composite FKs. No XOR, no 'add', no unproven legacy origin. RECEIVE keeps the
 * SAME fail-closed disposition policy 069 uses.
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

const M071_NAME = '071_phoenix_outlet_to_institution_return.sql';
const P071 = join(MIGRATIONS_DIR, M071_NAME);
const m071 = readFileSync(P071, 'utf8');

const active071 = activeSql(m071);
const norm071 = normalizeSql(active071);
const exec071 = executableSql(m071);

function functionBody(name: string): string {
  const src = sqlFunctionSource(m071, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

const REQUEST_LIFECYCLE_RPCS = [
  'phoenix_request_outlet_return',
  'phoenix_recall_outlet_stock',
  'phoenix_add_outlet_return_request_line',
  'phoenix_delete_outlet_return_request_line',
  'phoenix_submit_outlet_return_request',
  'phoenix_cancel_outlet_return_request',
  'phoenix_review_outlet_return_request',
] as const;

const WRITE_RPCS = [
  'phoenix_send_outlet_return_shipment_line',
  'phoenix_receive_outlet_return_shipment_line',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================
describe('1. migration 071 exists exactly once and is registered', () => {
  it('the file exists on disk with the exact expected name', () => {
    expect(m071.length).toBeGreaterThan(0);
  });

  it('is wrapped in a single begin/commit transaction', () => {
    expect(active071.trimStart().startsWith('begin;')).toBe(true);
    expect(active071.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('states manual-apply-only and NOT APPLIED, matching 060-070 convention', () => {
    expect(m071).toContain('MANUAL APPLY ONLY');
    expect(m071).toContain('NOT APPLIED');
  });

  it('runs preconditions that abort on missing 060/061/067/069 schema', () => {
    expect(m071).toContain('ABORT 071: expected 060/061/067/069 schema is absent');
  });

  it('requires 070 forward-dispatch to be applied — provenance depends on it', () => {
    expect(m071).toContain('ABORT 071: 070 forward-dispatch SEND/RECEIVE RPCs are absent. Apply 070 first.');
    expect(m071).toContain("to_regprocedure('public.phoenix_send_warehouse_dispatch(uuid,uuid)') IS NULL");
    expect(m071).toContain("to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL");
  });
});

// ============================================================================
// 2. distribution_points.warehouse_id is the structural pairing — no route table
// ============================================================================
describe('2. distribution_points.warehouse_id is load-bearing, no new route table', () => {
  it('adds a composite unique index on (id, warehouse_id) as an FK target', () => {
    expect(norm071).toContain('distribution_points_id_warehouse_uniq');
    expect(norm071).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS distribution_points_id_warehouse_uniq\s+ON public\.distribution_points \(id, warehouse_id\)/,
    );
  });

  it('creates no new route/pairing table', () => {
    expect(exec071).not.toMatch(/CREATE TABLE[^;]*route/i);
  });

  it('outlet_return_requests and outlet_return_shipments pin their endpoints via distribution_points(id, warehouse_id)', () => {
    for (const table of ['outlet_return_requests', 'outlet_return_shipments']) {
      const idx = norm071.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(idx, table).toBeGreaterThan(-1);
    }
    expect(norm071).toContain('orr_point_warehouse_fk');
    expect(norm071).toContain('ors_point_warehouse_fk');
    expect(norm071).toMatch(
      /FOREIGN KEY \(distribution_point_id, destination_warehouse_id\)\s+REFERENCES public\.distribution_points \(id, warehouse_id\)/,
    );
  });

  it('a NULL warehouse_id blocks REQUEST/RECALL with a named error, never a silent bypass', () => {
    const reqBody = functionBody('phoenix_request_outlet_return');
    const recallBody = functionBody('phoenix_recall_outlet_stock');
    expect(reqBody).toContain('distribution_point_has_no_return_warehouse');
    expect(recallBody).toContain('distribution_point_has_no_return_warehouse');
  });

  it('outlet and institution warehouse must share one organization (unlike 069\'s cross-org design)', () => {
    expect(norm071).toContain('orr_same_org_chk');
    expect(norm071).toContain('ors_same_org_chk');
    expect(norm071).toMatch(/CHECK \(source_organization_id = destination_organization_id\)/);
  });
});

// ============================================================================
// 3. SINGLE PROVEN PROVENANCE — real 070 dispatch line + its dispatch_receive
//    movement + the shared outlet_stock, pinned by composite FKs. No XOR, no
//    'add', no legacy origin.
// ============================================================================
describe('3. return-line provenance is a single proven chain, never XOR or an unproven origin', () => {
  it('both provenance ids AND the shared stock id are MANDATORY (NOT NULL) on the request line', () => {
    expect(norm071).toMatch(/original_dispatch_line_id\s+uuid NOT NULL REFERENCES public\.warehouse_dispatch_lines\(id\)/);
    expect(norm071).toMatch(/original_inbound_movement_id\s+uuid NOT NULL REFERENCES public\.outlet_stock_movements\(id\)/);
    expect(norm071).toMatch(/source_outlet_stock_id\s+uuid NOT NULL/);
  });

  it('the movement type is pinned to EXACTLY dispatch_receive — never add/dispense/correction', () => {
    expect(norm071).toContain('orrl_inbound_movement_type_chk');
    expect(norm071).toMatch(/CHECK \(original_inbound_movement_type = 'dispatch_receive'\)/);
    expect(norm071).toContain('orrl_inbound_movement_type_fk');
    expect(norm071).toMatch(
      /FOREIGN KEY \(original_inbound_movement_id, original_inbound_movement_type\)\s+REFERENCES public\.outlet_stock_movements \(id, movement_type\)/,
    );
  });

  it('the XOR/legacy provenance model is completely gone — no XOR check, no add-eligibility', () => {
    // The names may still appear inside the §14 post-condition that FORBIDS them;
    // what must be gone is the actual CONSTRAINT ... definition.
    expect(norm071).not.toMatch(/CONSTRAINT orrl_provenance_xor_chk/);
    expect(norm071).not.toMatch(/CONSTRAINT orsl_provenance_xor_chk/);
    expect(norm071).not.toMatch(/CONSTRAINT orrl_inbound_movement_type_eligible_chk/);
    // 'add' may only appear as the warehouse credit leg / narrative, never as an
    // eligible provenance movement_type in any CHECK/IN list.
    expect(norm071).not.toMatch(/movement_type IN \([^)]*'add'[^)]*\)/);
    expect(norm071).not.toMatch(/original_inbound_movement_type IN \([^)]*'add'/);
    // and the post-condition must actively forbid the stale guards' return.
    expect(m071).toContain('stale XOR/legacy provenance guard still present');
  });

  it('three composite FKs pin movement<->dispatch-line<->stock on the REQUEST line', () => {
    expect(norm071).toMatch(
      /orrl_movement_from_dispatch_line_fk\s+FOREIGN KEY \(original_inbound_movement_id, original_dispatch_line_id\)\s+REFERENCES public\.outlet_stock_movements \(id, dispatch_line_id\)/,
    );
    expect(norm071).toMatch(
      /orrl_movement_stock_fk\s+FOREIGN KEY \(original_inbound_movement_id, source_outlet_stock_id\)\s+REFERENCES public\.outlet_stock_movements \(id, outlet_stock_id\)/,
    );
    expect(norm071).toMatch(
      /orrl_dispatch_line_stock_fk\s+FOREIGN KEY \(original_dispatch_line_id, source_outlet_stock_id\)\s+REFERENCES public\.warehouse_dispatch_lines \(id, resulting_outlet_stock_id\)/,
    );
  });

  it('the SAME three composite FKs pin the SHIPMENT line too (defense in depth, not merely carried)', () => {
    expect(norm071).toContain('orsl_movement_from_dispatch_line_fk');
    expect(norm071).toContain('orsl_movement_stock_fk');
    expect(norm071).toContain('orsl_dispatch_line_stock_fk');
    expect(norm071).toMatch(/original_dispatch_line_id\s+uuid NOT NULL REFERENCES public\.warehouse_dispatch_lines\(id\)/);
  });

  it('a composite unique index (id, dispatch_line_id) exists so the movement<->dispatch-line FK has a target', () => {
    expect(norm071).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_id_dispatch_line_uniq\s+ON public\.outlet_stock_movements \(id, dispatch_line_id\)/,
    );
  });

  it('ADD-LINE takes ONLY the dispatch line (no movement-provenance parameter) and derives the movement itself', () => {
    const src = sqlFunctionSource(m071, 'phoenix_add_outlet_return_request_line')!;
    // signature: (uuid, uuid, integer, text, text) — no second uuid provenance param
    expect(src).toMatch(/phoenix_add_outlet_return_request_line\(\s*p_return_request_id\s+uuid,\s*p_original_dispatch_line_id\s+uuid[^)]*p_requested_quantity\s+integer/);
    expect(src).not.toContain('p_original_inbound_movement_id');
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('original_dispatch_line_id_required');
    // derives the matching dispatch_receive movement from the dispatch line
    expect(body).toMatch(/WHERE dispatch_line_id = v_dispatch\.id\s+AND movement_type = 'dispatch_receive'/);
    expect(body).toContain('dispatch_receive_movement_not_found_for_line');
  });

  it('ADD-LINE requires the dispatch line to be a completed, accepted receipt at this outlet', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toMatch(/v_dispatch\.status NOT IN \('accepted', 'accepted_with_difference'\)\s+OR v_dispatch\.resulting_outlet_stock_id IS NULL/);
    expect(body).toContain('original_dispatch_line_not_a_completed_receipt');
    expect(body).toContain('original_dispatch_line_not_at_this_outlet');
  });

  it('ADD-LINE asserts material/batch/expiry match across the dispatch line and the outlet_stock row', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('provenance_material_batch_expiry_mismatch');
    expect(body).toMatch(/v_dispatch\.scientific_name IS DISTINCT FROM v_stock\.scientific_name/);
    expect(body).toMatch(/v_dispatch\.expiry_date IS DISTINCT FROM v_stock\.expiry_date/);
  });
});

// ============================================================================
// 4. Cap: the accepted-but-not-yet-returned quantity on the dispatch line
// ============================================================================
describe('4. the returnable cap is the dispatch line\'s (received - returned), and only that', () => {
  it('warehouse_dispatch_lines gains returned_quantity/return_received_quantity/return_unresolved_quantity', () => {
    expect(norm071).toContain('wdl_returned_qty_chk');
    expect(norm071).toContain('wdl_return_received_qty_chk');
    expect(norm071).toMatch(
      /ADD COLUMN return_unresolved_quantity integer\s+GENERATED ALWAYS AS \(returned_quantity - return_received_quantity\) STORED/,
    );
  });

  it('ADD LINE computes the cap from the dispatch line and rejects an over-ask (no movement-cap branch)', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('requested_quantity_exceeds_returnable_cap');
    expect(body).toMatch(/v_cap := COALESCE\(v_dispatch\.received_quantity, 0\) - v_dispatch\.returned_quantity/);
    // the old movement-based cap must be gone
    expect(body).not.toMatch(/v_cap := v_movement\.on_hand_delta - v_movement\.returned_quantity/);
  });

  it('SEND consumes the cap on the dispatch line ONLY — never a movement returned_quantity', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).toMatch(
      /UPDATE public\.warehouse_dispatch_lines\s+SET returned_quantity = returned_quantity \+ p_quantity\s+WHERE id = v_line\.original_dispatch_line_id/,
    );
    expect(body).not.toMatch(/UPDATE public\.outlet_stock_movements\s+SET returned_quantity = returned_quantity \+ p_quantity/);
  });

  it('RECEIVE ticks the dispatch line\'s return_received_quantity, bounded by wdl_return_received_qty_chk', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toMatch(
      /UPDATE public\.warehouse_dispatch_lines\s+SET return_received_quantity = return_received_quantity \+ p_received_quantity/,
    );
  });

  it('no dead/no-op UPDATE statements were left behind from drafting', () => {
    expect(exec071).not.toMatch(/WHERE false/);
  });
});

// ============================================================================
// 5. Conservation equation, custody states, rejection handling
// ============================================================================
describe('5. literal conservation equation and custody-state machine, identical shape to 069', () => {
  it('has the literal conservation CHECK', () => {
    expect(norm071).toContain('orsl_conservation_eq_chk');
    expect(norm071).toMatch(
      /CONSTRAINT orsl_conservation_eq_chk\s+CHECK \(\s*status = 'in_transit'\s+OR sent_quantity =/,
    );
  });

  it('custody_state covers in_transit/destination_stock/destination_quarantine/exception_pending', () => {
    expect(norm071).toContain('orsl_custody_state_chk');
    expect(norm071).toMatch(
      /CHECK \(custody_state IN \(\s*'in_transit', 'destination_stock', 'destination_quarantine', 'exception_pending'\s*\)\)/,
    );
  });

  it('a rejection touches neither balance and is tracked exception_pending', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    const rejectIdx = body.indexOf('IF p_received_quantity = 0 THEN');
    const rejectReturnIdx = body.indexOf('RETURN jsonb_build_object', rejectIdx);
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(body.slice(rejectIdx, rejectReturnIdx)).toContain("custody_state = 'exception_pending'");
    expect(body.slice(rejectIdx, rejectReturnIdx)).not.toContain('warehouse_stock');
    expect(body.slice(rejectIdx, rejectReturnIdx)).not.toContain('warehouse_quarantine_stock');
  });
});

// ============================================================================
// 6. RECEIVE disposition is fail-closed — identical policy to 069
// ============================================================================
describe('6. RECEIVE classifies every accepted quantity fail-closed, same policy as 069', () => {
  const MANDATORY_QUARANTINE_REASONS = [
    'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other',
  ] as const;
  const DECISION_REQUIRED_REASONS = ['near_expiry', 'excess', 'shipment_error'] as const;

  it('mandatory-quarantine reasons, including other and a NULL reason_code, are named explicitly', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toMatch(/v_mandatory_quarantine := v_objectively_expired\s+OR v_reason_code IS NULL\s+OR v_reason_code IN/);
    for (const reason of MANDATORY_QUARANTINE_REASONS) {
      expect(body, reason).toMatch(new RegExp(`v_reason_code IN \\([^)]*'${reason}'`));
    }
  });

  it('the client cannot override a mandatory-quarantine reason via p_disposition_decision', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    const mandatoryBranch = body.slice(
      body.indexOf('IF v_mandatory_quarantine THEN'),
      body.indexOf('ELSIF v_reason_code'),
    );
    expect(mandatoryBranch).not.toContain('p_disposition_decision');
    expect(mandatoryBranch).toContain("v_disposition := 'quarantined'");
  });

  it('near_expiry/excess/shipment_error all require an explicit decision, no default in either direction', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toContain('return_receive_requires_explicit_disposition_decision');
    for (const reason of DECISION_REQUIRED_REASONS) {
      expect(body, reason).toMatch(new RegExp(`ELSIF v_reason_code IN \\([^)]*'${reason}'[^)]*\\) THEN\\s+IF p_disposition_decision IS NULL THEN`));
    }
  });

  it('restockable is never a hardcoded default — only ever from p_disposition_decision', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).not.toContain("v_disposition := 'restockable';");
    expect(body).toMatch(/v_disposition := p_disposition_decision;/);
  });

  it('an unreachable fail-closed backstop exists for any unclassified reason_code', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toContain('return_receive_unclassified_reason_code');
  });

  it('a decision failure raises BEFORE any stock mutation', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    const decisionRaiseIdx = body.indexOf("RAISE EXCEPTION 'return_receive_requires_explicit_disposition_decision'");
    const stockInsertIdx = body.indexOf('INSERT INTO public.warehouse_stock (');
    const quarantineInsertIdx = body.indexOf('INSERT INTO public.warehouse_quarantine_stock (');
    expect(decisionRaiseIdx).toBeGreaterThan(-1);
    expect(decisionRaiseIdx).toBeLessThan(stockInsertIdx);
    expect(decisionRaiseIdx).toBeLessThan(quarantineInsertIdx);
  });

  it('an unauthorized receiver never reaches disposition classification', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    const permIdx = body.indexOf('forbidden_outlet_return_receive');
    const classifyIdx = body.indexOf('v_mandatory_quarantine := v_objectively_expired');
    expect(permIdx).toBeGreaterThan(-1);
    expect(permIdx).toBeLessThan(classifyIdx);
  });

  it('RECEIVE reuses warehouse_quarantine_stock (069) verbatim — no new quarantine table', () => {
    expect(exec071).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.\w*quarantine\w*/i);
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toContain('INSERT INTO public.warehouse_quarantine_stock');
  });

  it('restockable credit reuses \'add\' on warehouse_stock_movements (credit leg only) — no widened CHECK', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toMatch(/v_stock\.warehouse_id, 'add',/);
    expect(exec071).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+warehouse_stock_movements_type_chk/i);
  });

  it('SEND reuses \'return_send\' on outlet_stock_movements — no widened CHECK', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).toContain("'return_send'");
    expect(exec071).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+outlet_stock_movements_type_chk/i);
  });
});

// ============================================================================
// 7. SEND: no expiry refusal, public availability projection stays in sync
// ============================================================================
describe('7. return-send has no expiry-refusal and keeps item_availability in sync', () => {
  it('has NO expiry-refusal check', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).not.toMatch(/expiry_date < current_date/);
  });

  it('calls phoenix_project_outlet_availability after debiting outlet_stock', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    const debitIdx = body.indexOf('UPDATE public.outlet_stock');
    const projectIdx = body.indexOf('phoenix_project_outlet_availability');
    expect(debitIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(debitIdx);
  });

  it('resolves the source stock from the line\'s pinned source_outlet_stock_id, then IDOR-gates on the LOCKED row', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).toMatch(/WHERE s\.id = v_line\.source_outlet_stock_id\s+FOR UPDATE OF s/);
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'outlet_stock\.return', v_stock\.organization_id, NULL, v_stock\.distribution_point_id/,
    );
  });
});

// ============================================================================
// 8. Cancel window and separation of duty
// ============================================================================
describe('8. cancel is allowed only draft/submitted; separation of duty mirrors 069', () => {
  it('cancel is blocked outside draft/submitted', () => {
    const body = functionBody('phoenix_cancel_outlet_return_request');
    expect(body).toMatch(/IF v_request\.status NOT IN \('draft', 'submitted'\) THEN/);
    expect(body).toContain('return_request_not_cancellable');
  });

  it('outlet_officer gets return_request+send only; warehouse_officer gets recall+review+receive only', () => {
    expect(norm071).toMatch(/\('outlet_officer',\s+'outlet_stock\.return_request', true\)/);
    expect(norm071).toMatch(/\('outlet_officer',\s+'outlet_stock\.recall',\s+false\)/);
    expect(norm071).toMatch(/\('warehouse_officer',\s+'outlet_stock\.recall',\s+true\)/);
    expect(norm071).toMatch(/\('warehouse_officer',\s+'outlet_stock\.return_request', false\)/);
  });

  it('reuses the existing outlet_stock.return key for SEND rather than minting a duplicate', () => {
    expect(exec071).not.toMatch(/INSERT INTO public\.permission_keys[^;]*'outlet_stock\.return'/s);
    expect(norm071).toContain("'outlet_stock.return'");
  });

  it('REVIEW is always scoped to the institution warehouse, regardless of who opened the request', () => {
    const body = functionBody('phoenix_review_outlet_return_request');
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'outlet_stock\.review_return', v_request\.destination_organization_id,\s*v_request\.destination_warehouse_id, NULL/,
    );
  });
});

// ============================================================================
// 9. Idempotency, RLS, grants, no-CASCADE, RPC boundary hygiene
// ============================================================================
describe('9. idempotency, RLS, and grant hygiene', () => {
  it('has idempotency indexes for send/receive/quarantine-receive', () => {
    expect(norm071).toContain('outlet_stock_movements_return_once_uniq');
    expect(norm071).toContain('warehouse_stock_movements_outlet_return_once_uniq');
    expect(norm071).toContain('wqsm_outlet_return_once_uniq');
  });

  it('every stock-moving RPC has advisory lock, row lock, IDOR gate, fingerprint, and audit', () => {
    for (const name of WRITE_RPCS) {
      const def = sqlFunctionSource(m071, name)!;
      expect(def, name).toMatch(/SECURITY DEFINER/);
      expect(def, name).toMatch(/pg_advisory_xact_lock/);
      expect(def, name).toMatch(/FOR UPDATE/);
      expect(def, name).toMatch(/phoenix_profile_has_scoped_permission/);
      expect(def, name).toMatch(/request_fingerprint/);
      expect(def, name).toMatch(/INSERT INTO public\.audit_logs/);
    }
  });

  it('every SECURITY DEFINER function pins search_path = public, pg_temp', () => {
    const definer = (exec071.match(/SECURITY DEFINER/g) ?? []).length;
    const pinned = (exec071.match(/SET search_path = public, pg_temp/g) ?? []).length;
    expect(definer).toBeGreaterThan(0);
    expect(pinned).toBe(definer);
  });

  it('RLS is enabled on all four new tables, authenticated is SELECT-only, anon has nothing', () => {
    for (const t of [
      'outlet_return_requests', 'outlet_return_request_lines',
      'outlet_return_shipments', 'outlet_return_shipment_lines',
    ]) {
      expect(norm071).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(norm071).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`));
      expect(norm071).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });

  it('no CASCADE beyond the intrinsic header->line relationship', () => {
    expect(m071).toContain('VERIFY FAILED (071): an unexpected CASCADE exists on a return line table');
  });

  it('keeps every post-condition that guards a boundary in this file', () => {
    for (const assertion of [
      'ABORT 071: expected 060/061/067/069 schema is absent',
      'ABORT 071: missing structural guard',
      'ABORT 071: outlet return-send idempotency index missing',
      'VERIFY FAILED (071): authenticated holds a direct return write privilege',
      'VERIFY FAILED (071): anon can read outlet return data',
    ]) {
      expect(m071, assertion).toContain(assertion);
    }
  });

  it('post-conditions actively forbid the old XOR/legacy provenance guards from reappearing', () => {
    expect(m071).toContain('ABORT 071: stale XOR/legacy provenance guard still present');
    expect(m071).toContain('return provenance is not pinned to dispatch_receive-only (add must be impossible)');
  });

  it('the public QR path post-condition checks BOTH outlet_return and quarantine substrings', () => {
    expect(m071).toMatch(
      /ASSERT v_qr_def NOT ILIKE '%outlet_return%' AND v_qr_def NOT ILIKE '%quarantine%'/,
    );
  });

  it('§14i resolves get_public_qr_payload by its FULL (text) signature, never a bare name that ::regprocedure cannot cast', () => {
    // regprocedure input REQUIRES the argument-type list; a bare name aborts the
    // whole migration ("expected a left parenthesis"). The real signature is (text).
    expect(m071).toContain(
      "pg_get_functiondef('public.get_public_qr_payload(text)'::regprocedure)",
    );
    // Guard against the incomplete form ever coming back.
    expect(m071).not.toContain("'public.get_public_qr_payload'::regprocedure");
  });

  it('every ::regprocedure cast in 071 carries a parenthesised argument-type list', () => {
    const bareRegprocedure = m071.match(/'[a-z0-9_.]+'::regprocedure/gi) ?? [];
    expect(bareRegprocedure, `bare-name regprocedure casts: ${bareRegprocedure.join(', ')}`).toEqual([]);
  });
});

// ============================================================================
// 10. Reason codes — same 9-value vocabulary as 069
// ============================================================================
describe('10. reason_code vocabulary matches 069 exactly, so the fail-closed policy stays identical', () => {
  it('outlet_return_request_lines.reason_code CHECK matches 069\'s exact list', () => {
    expect(norm071).toMatch(
      /CHECK \(reason_code IN \(\s*'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',\s*'recalled', 'quality_issue', 'temperature_excursion', 'other'\s*\)\)/,
    );
  });

  it('ADD LINE validates reason_code against the same 9-value list before insert', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('invalid_reason_code');
  });
});

// ============================================================================
// 11. All lifecycle + write RPCs are present and registered
// ============================================================================
describe('11. every RPC named in this file actually exists as a CREATE FUNCTION', () => {
  it('all seven request-lifecycle RPCs exist', () => {
    for (const name of REQUEST_LIFECYCLE_RPCS) {
      expect(sqlFunctionSource(m071, name), name).not.toBeNull();
    }
  });

  it('both stock-moving RPCs exist', () => {
    for (const name of WRITE_RPCS) {
      expect(sqlFunctionSource(m071, name), name).not.toBeNull();
    }
  });
});

// ============================================================================
// 12. Registered in the reviewed-migration manifest
// ============================================================================
describe('12. 071 is registered in the reviewed-migration manifest', () => {
  it('is present in REVIEWED_MIGRATION_FILES', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M071_NAME);
  });
});
