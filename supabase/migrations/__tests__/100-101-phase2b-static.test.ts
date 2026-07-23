/**
 * PHASE-2B-STATIC — registration + discipline contract tests for 100-101.
 * The behavioral proof for both is
 * 100-101-phase2b-remaining-corridors.dynamic.test.ts (real Postgres, 001->101 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const FILES = [
  '100_phoenix_bulk_receive_remaining_corridors.sql',
  '101_phoenix_warehouse_second_person_correction_approval.sql',
];

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it.each(FILES)('%s is registered and manual-apply-only', (name) => {
    expect(REVIEWED_MIGRATION_FILES).toContain(name);
    const { sql } = load(name);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('100 — bulk receive remaining corridors', () => {
  const { code } = load('100_phoenix_bulk_receive_remaining_corridors.sql');

  it('each RPC delegates to the real single-line RPC (no reimplementation)', () => {
    expect(code).toMatch(/public\.phoenix_receive_warehouse_transfer_line\(/);
    expect(code).toMatch(/public\.phoenix_receive_warehouse_return_shipment_line\(/);
    expect(code).toMatch(/public\.phoenix_receive_outlet_return_shipment_line\(/);
  });

  it('each wraps its delegated call in its own exception block (implicit savepoint)', () => {
    // Three RPCs, each with its own BEGIN ... EXCEPTION WHEN OTHERS block.
    const occurrences = code.match(/EXCEPTION WHEN OTHERS THEN/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it('only auto-receives an EXACT count match; a mismatch is reported, never forced', () => {
    expect(code).toMatch(/v_counted <> v_line\.sent_quantity/g);
    expect(code).toMatch(/skipped_mismatch_requires_individual_review/);
  });

  it('an already-decided line (not in_transit) is reported, never re-attempted', () => {
    expect(code).toMatch(/v_line\.status <> 'in_transit'/);
    expect(code).toMatch(/skipped_already_decided/);
  });

  it('each derives its per-line request id deterministically from the bulk id + line id (idempotent, no self-deadlock)', () => {
    const occurrences = code.match(/md5\(p_bulk_request_id::text \|\| ':' \|\| v_line_id::text\)::uuid/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it('the warehouse transfer corridor checks header identity before line status', () => {
    expect(code).toMatch(/v_line\.transfer_id <> p_transfer_id/);
    expect(code).toMatch(/not_a_line_of_this_transfer/);
  });

  it('the two shipment corridors check header identity before line status', () => {
    const occurrences = code.match(/v_line\.shipment_id <> p_shipment_id/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(code).toMatch(/not_a_line_of_this_shipment/);
  });

  it('does not touch 087 (procurement) — confirmed no new RPC references phoenix_procurement_receive_order', () => {
    expect(code).not.toMatch(/phoenix_procurement_receive_order/);
  });

  it('an exact quantity match does NOT bypass a mandatory disposition decision for near_expiry/excess/shipment_error returns', () => {
    // 100-A-FIX: 088's single-line receive RPCs require an EXPLICIT
    // p_disposition_decision whenever the return-request line's reason_code
    // is near_expiry/excess/shipment_error — independent of whether the
    // counted quantity matches what was sent. Both return-corridor wrappers
    // must pre-check reason_code and SKIP (never auto-decide, never error)
    // such a line, exactly like a quantity mismatch.
    const reasonCodeChecks = code.match(/v_reason_code IN \('near_expiry', 'excess', 'shipment_error'\)/g) ?? [];
    expect(reasonCodeChecks.length).toBe(2); // once per return corridor (069 + 071)
    const skipStatuses = code.match(/skipped_requires_disposition_decision/g) ?? [];
    expect(skipStatuses.length).toBe(2);
    // The dispatch corridor (070/096, no disposition concept at all) and the
    // transfer corridor (068, same — no quarantine/disposition branch) must
    // NOT gain a spurious disposition check.
    const transferFn = code.slice(
      code.indexOf('FUNCTION public.phoenix_receive_all_matching_transfer_lines'),
      code.indexOf('FUNCTION public.phoenix_receive_all_matching_warehouse_return_lines'),
    );
    expect(transferFn).not.toMatch(/disposition/i);
  });
});

describe('101 — warehouse second-person correction approval', () => {
  const { code } = load('101_phoenix_warehouse_second_person_correction_approval.sql');

  it('reuses the SAME phoenix_variance_approval_policy table 098 created — no second policy table', () => {
    expect(code).toMatch(/phoenix_variance_approval_policy/);
    expect(code).not.toMatch(/CREATE TABLE public\.phoenix_variance_approval_policy/);
    expect(code).not.toMatch(/CREATE TABLE.*warehouse.*approval_policy/i);
  });

  it('creates its OWN pending-request table, distinct from 098s outlet-side table', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_warehouse_correction_requests/);
    expect(code).not.toMatch(/CREATE TABLE public\.phoenix_stock_correction_requests/);
  });

  it('the proposer can never approve their own request, checked by identity', () => {
    expect(code).toMatch(/v_req\.proposed_by = v_actor/);
    expect(code).toMatch(/proposer_cannot_approve_own_correction/);
  });

  it('grants warehouse_stock.approve_correction ONLY to central_warehouse_manager by default', () => {
    const grantSection = code.slice(0, code.indexOf('CREATE TABLE public.phoenix_warehouse_correction_requests'));
    expect(grantSection).toMatch(/\('central_warehouse_manager', 'warehouse_stock\.approve_correction', true\)/);
    // No other role is granted this key anywhere in the migration body.
    const otherRoleGrant = /\('(?!central_warehouse_manager)\w+', 'warehouse_stock\.approve_correction', true\)/;
    expect(code).not.toMatch(otherRoleGrant);
  });

  it('fails closed: no policy row is seeded at migration time (absent row = threshold 0)', () => {
    const beforeFirstFunction = code.slice(0, code.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(beforeFirstFunction).not.toMatch(/INSERT INTO public\.phoenix_variance_approval_policy/);
  });

  it('the approve write applies inline rather than delegating to phoenix_apply_warehouse_stock_movement_guarded', () => {
    // Documented reasoning: coupling approval authority to warehouse_stock.correct
    // (the actor the guarded RPC authorizes against) would be an accident of
    // today's role defaults, not a designed invariant.
    const approveFn = code.slice(
      code.indexOf('FUNCTION public.phoenix_approve_warehouse_stock_correction'),
      code.indexOf('FUNCTION public.phoenix_reject_warehouse_stock_correction'),
    );
    expect(approveFn).not.toMatch(/phoenix_apply_warehouse_stock_movement_guarded/);
    expect(approveFn).toMatch(/UPDATE public\.warehouse_stock/);
    expect(approveFn).toMatch(/INSERT INTO public\.warehouse_stock_movements/);
  });

  it('reject never touches warehouse_stock or warehouse_stock_movements', () => {
    const rejectFn = code.slice(code.indexOf('FUNCTION public.phoenix_reject_warehouse_stock_correction'));
    expect(rejectFn).not.toMatch(/UPDATE public\.warehouse_stock\b/);
    expect(rejectFn).not.toMatch(/INSERT INTO public\.warehouse_stock_movements/);
  });
});
