/**
 * OUTLET-TO-INSTITUTION-RETURN-070-A
 *
 * Static SQL-source tests for migration 070 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 044-069.
 *
 * 070 completes the outlet leg of the return domain 069 explicitly deferred:
 * outlet -> institution returns/recalls, reusing distribution_points.warehouse_id
 * as the structural pairing (no new route table), with dual XOR provenance
 * (a warehouse_dispatch_lines row, or an eligible outlet_stock_movements row)
 * and the SAME fail-closed disposition policy 069 uses at RECEIVE.
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

const M070_NAME = '070_phoenix_outlet_to_institution_return.sql';
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
describe('1. migration 070 exists exactly once and is registered', () => {
  it('the file exists on disk with the exact expected name', () => {
    expect(m070.length).toBeGreaterThan(0);
  });

  it('is wrapped in a single begin/commit transaction', () => {
    expect(active070.trimStart().startsWith('begin;')).toBe(true);
    expect(active070.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('states manual-apply-only and NOT APPLIED, matching 060-069 convention', () => {
    expect(m070).toContain('MANUAL APPLY ONLY');
    expect(m070).toContain('NOT APPLIED');
  });

  it('runs preconditions that abort on missing 060/061/067/069 schema', () => {
    expect(m070).toContain('ABORT 070: expected 060/061/067/069 schema is absent');
  });
});

// ============================================================================
// 2. distribution_points.warehouse_id is the structural pairing — no route table
// ============================================================================
describe('2. distribution_points.warehouse_id is load-bearing, no new route table', () => {
  it('adds a composite unique index on (id, warehouse_id) as an FK target', () => {
    expect(norm070).toContain('distribution_points_id_warehouse_uniq');
    expect(norm070).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS distribution_points_id_warehouse_uniq\s+ON public\.distribution_points \(id, warehouse_id\)/,
    );
  });

  it('creates no new route/pairing table', () => {
    expect(exec070).not.toMatch(/CREATE TABLE[^;]*route/i);
  });

  it('outlet_return_requests and outlet_return_shipments pin their endpoints via distribution_points(id, warehouse_id)', () => {
    for (const table of ['outlet_return_requests', 'outlet_return_shipments']) {
      const idx = norm070.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(idx, table).toBeGreaterThan(-1);
    }
    expect(norm070).toContain('orr_point_warehouse_fk');
    expect(norm070).toContain('ors_point_warehouse_fk');
    expect(norm070).toMatch(
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
    expect(norm070).toContain('orr_same_org_chk');
    expect(norm070).toContain('ors_same_org_chk');
    expect(norm070).toMatch(/CHECK \(source_organization_id = destination_organization_id\)/);
  });
});

// ============================================================================
// 3. Dual provenance, XOR — dispatch line OR eligible inbound movement
// ============================================================================
describe('3. return-line provenance is XOR: a dispatch line or an eligible inbound movement, never both/neither', () => {
  it('outlet_return_request_lines has the XOR CHECK', () => {
    expect(norm070).toContain('orrl_provenance_xor_chk');
  });

  it('outlet_return_shipment_lines has the XOR CHECK', () => {
    expect(norm070).toContain('orsl_provenance_xor_chk');
    expect(norm070).toMatch(
      /CHECK \(\s*\(original_dispatch_line_id IS NOT NULL AND original_inbound_movement_id IS NULL\)\s+OR\s+\(original_dispatch_line_id IS NULL AND original_inbound_movement_id IS NOT NULL\)\s*\)/,
    );
  });

  it('movement provenance is restricted to dispatch_receive/add by a structural CHECK + composite FK, not a comment', () => {
    expect(norm070).toContain('orrl_inbound_movement_type_eligible_chk');
    expect(norm070).toMatch(
      /CHECK \(original_inbound_movement_type IS NULL\s+OR original_inbound_movement_type IN \('dispatch_receive', 'add'\)\)/,
    );
    expect(norm070).toContain('orrl_inbound_movement_type_fk');
    expect(norm070).toMatch(
      /FOREIGN KEY \(original_inbound_movement_id, original_inbound_movement_type\)\s+REFERENCES public\.outlet_stock_movements \(id, movement_type\)/,
    );
  });

  it('dispense/correction/subtract/reserve/release/set_exact can never be named as provenance', () => {
    const ineligible = ['dispense', 'correction', 'subtract', 'reserve', 'release', 'set_exact'];
    const eligibleListMatch = norm070.match(
      /original_inbound_movement_type IN \(([^)]*)\)/,
    );
    expect(eligibleListMatch).not.toBeNull();
    for (const t of ineligible) {
      expect(eligibleListMatch![1], t).not.toContain(`'${t}'`);
    }
  });

  it('phoenix_add_outlet_return_request_line requires exactly one provenance parameter', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('exactly_one_provenance_required');
    expect(body).toMatch(
      /IF \(p_original_dispatch_line_id IS NOT NULL\) = \(p_original_inbound_movement_id IS NOT NULL\) THEN/,
    );
  });

  it('the ADD-LINE RPC validates the movement-provenance eligibility live under a row lock, not just via the FK', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('original_inbound_movement_not_eligible');
    expect(body).toMatch(/FOR UPDATE;\s*IF NOT FOUND OR v_movement\.organization_id/);
  });

  it('the dispatch-line path requires the line to already have a resulting_outlet_stock_id — never resolves to a not-yet-existing stock row', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('original_dispatch_line_not_yet_resulted_in_outlet_stock');
  });
});

// ============================================================================
// 4. Caps: returned_quantity on BOTH possible provenance tables
// ============================================================================
describe('4. a returnable cap exists on whichever provenance table the line actually used', () => {
  it('warehouse_dispatch_lines gains returned_quantity/return_received_quantity/return_unresolved_quantity', () => {
    expect(norm070).toContain('wdl_returned_qty_chk');
    expect(norm070).toContain('wdl_return_received_qty_chk');
    expect(norm070).toMatch(
      /ADD COLUMN return_unresolved_quantity integer\s+GENERATED ALWAYS AS \(returned_quantity - return_received_quantity\) STORED/,
    );
  });

  it('outlet_stock_movements gains returned_quantity, bounded by on_hand_delta', () => {
    expect(norm070).toContain('osm_returned_qty_chk');
    expect(norm070).toMatch(
      /CHECK \(returned_quantity >= 0 AND returned_quantity <= GREATEST\(on_hand_delta, 0\)\)/,
    );
  });

  it('ADD LINE computes the cap from whichever provenance and rejects an over-ask', () => {
    const body = functionBody('phoenix_add_outlet_return_request_line');
    expect(body).toContain('requested_quantity_exceeds_returnable_cap');
    expect(body).toMatch(/v_cap := COALESCE\(v_dispatch\.received_quantity, 0\) - v_dispatch\.returned_quantity/);
    expect(body).toMatch(/v_cap := v_movement\.on_hand_delta - v_movement\.returned_quantity/);
  });

  it('SEND increments returned_quantity on whichever provenance table the line used, never both', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).toMatch(
      /IF v_line\.original_dispatch_line_id IS NOT NULL THEN\s+UPDATE public\.warehouse_dispatch_lines\s+SET returned_quantity = returned_quantity \+ p_quantity/,
    );
    expect(body).toMatch(
      /ELSE\s+UPDATE public\.outlet_stock_movements\s+SET returned_quantity = returned_quantity \+ p_quantity/,
    );
  });

  it('no dead/no-op UPDATE statements were left behind from drafting', () => {
    expect(exec070).not.toMatch(/WHERE false/);
  });
});

// ============================================================================
// 5. Conservation equation, custody states, rejection handling
// ============================================================================
describe('5. literal conservation equation and custody-state machine, identical shape to 069', () => {
  it('has the literal conservation CHECK', () => {
    expect(norm070).toContain('orsl_conservation_eq_chk');
    expect(norm070).toMatch(
      /CONSTRAINT orsl_conservation_eq_chk\s+CHECK \(\s*status = 'in_transit'\s+OR sent_quantity =/,
    );
  });

  it('custody_state covers in_transit/destination_stock/destination_quarantine/exception_pending', () => {
    expect(norm070).toContain('orsl_custody_state_chk');
    expect(norm070).toMatch(
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
    expect(exec070).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.\w*quarantine\w*/i);
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toContain('INSERT INTO public.warehouse_quarantine_stock');
  });

  it('restockable credit reuses \'add\' on warehouse_stock_movements — no widened CHECK', () => {
    const body = functionBody('phoenix_receive_outlet_return_shipment_line');
    expect(body).toMatch(/v_stock\.warehouse_id, 'add',/);
    expect(exec070).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+warehouse_stock_movements_type_chk/i);
  });

  it('SEND reuses \'return_send\' on outlet_stock_movements — no widened CHECK', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
    expect(body).toContain("'return_send'");
    expect(exec070).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+outlet_stock_movements_type_chk/i);
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

  it('the IDOR gate derives the outlet from the LOCKED stock row, never the caller', () => {
    const body = functionBody('phoenix_send_outlet_return_shipment_line');
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
    expect(norm070).toMatch(/\('outlet_officer',\s+'outlet_stock\.return_request', true\)/);
    expect(norm070).toMatch(/\('outlet_officer',\s+'outlet_stock\.recall',\s+false\)/);
    expect(norm070).toMatch(/\('warehouse_officer',\s+'outlet_stock\.recall',\s+true\)/);
    expect(norm070).toMatch(/\('warehouse_officer',\s+'outlet_stock\.return_request', false\)/);
  });

  it('reuses the existing outlet_stock.return key for SEND rather than minting a duplicate', () => {
    expect(exec070).not.toMatch(/INSERT INTO public\.permission_keys[^;]*'outlet_stock\.return'/s);
    expect(norm070).toContain("'outlet_stock.return'");
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
    expect(norm070).toContain('outlet_stock_movements_return_once_uniq');
    expect(norm070).toContain('warehouse_stock_movements_outlet_return_once_uniq');
    expect(norm070).toContain('wqsm_outlet_return_once_uniq');
  });

  it('every stock-moving RPC has advisory lock, row lock, IDOR gate, fingerprint, and audit', () => {
    for (const name of WRITE_RPCS) {
      const def = sqlFunctionSource(m070, name)!;
      expect(def, name).toMatch(/SECURITY DEFINER/);
      expect(def, name).toMatch(/pg_advisory_xact_lock/);
      expect(def, name).toMatch(/FOR UPDATE/);
      expect(def, name).toMatch(/phoenix_profile_has_scoped_permission/);
      expect(def, name).toMatch(/request_fingerprint/);
      expect(def, name).toMatch(/INSERT INTO public\.audit_logs/);
    }
  });

  it('RLS is enabled on all four new tables, authenticated is SELECT-only, anon has nothing', () => {
    for (const t of [
      'outlet_return_requests', 'outlet_return_request_lines',
      'outlet_return_shipments', 'outlet_return_shipment_lines',
    ]) {
      expect(norm070).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(norm070).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`));
      expect(norm070).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });

  it('no CASCADE beyond the intrinsic header->line relationship', () => {
    expect(m070).toContain('VERIFY FAILED (070): an unexpected CASCADE exists on a return line table');
  });

  it('keeps every post-condition that guards a boundary in this file', () => {
    for (const assertion of [
      'ABORT 070: expected 060/061/067/069 schema is absent',
      'ABORT 070: missing structural guard',
      'ABORT 070: outlet return-send idempotency index missing',
      'VERIFY FAILED (070): authenticated holds a direct return write privilege',
      'VERIFY FAILED (070): anon can read outlet return data',
    ]) {
      expect(m070, assertion).toContain(assertion);
    }
  });

  it('the public QR path post-condition checks BOTH outlet_return and quarantine substrings', () => {
    expect(m070).toMatch(
      /ASSERT v_qr_def NOT ILIKE '%outlet_return%' AND v_qr_def NOT ILIKE '%quarantine%'/,
    );
  });
});

// ============================================================================
// 10. Reason codes — same 9-value vocabulary as 069
// ============================================================================
describe('10. reason_code vocabulary matches 069 exactly, so the fail-closed policy stays identical', () => {
  it('outlet_return_request_lines.reason_code CHECK matches 069\'s exact list', () => {
    expect(norm070).toMatch(
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
      expect(sqlFunctionSource(m070, name), name).not.toBeNull();
    }
  });

  it('both stock-moving RPCs exist', () => {
    for (const name of WRITE_RPCS) {
      expect(sqlFunctionSource(m070, name), name).not.toBeNull();
    }
  });
});

// ============================================================================
// 12. Registered in the reviewed-migration manifest
// ============================================================================
describe('12. 070 is registered in the reviewed-migration manifest', () => {
  it('is present in REVIEWED_MIGRATION_FILES', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M070_NAME);
  });
});
