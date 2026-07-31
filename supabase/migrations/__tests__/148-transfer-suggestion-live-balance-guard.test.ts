/**
 * LIVE-BALANCE-FIX-148 — static source guard.
 *
 * Pins the exact shape of phoenix_create_transfer_draft_from_suggestion's
 * headroom/deficit computation so a future edit cannot silently reintroduce
 * inventory_alerts as an executional balance source: the previous version
 * derived both from inventory_alerts.observed_available/threshold_reorder_
 * point/threshold_target_max — a table only ever refreshed by a MANUAL
 * phoenix_recompute_inventory_alerts call (no trigger anywhere ties it to a
 * live warehouse_stock/outlet_stock change), and carrying no lock of its
 * own. The fix re-derives both live, under real row locks, via the new
 * _phoenix_live_suggestion_scope_position helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname, '..', '148_phoenix_transfer_suggestion_draft_bridge.sql',
);
const sql = readFileSync(MIGRATION_PATH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} must exist in ${MIGRATION_PATH}`).toBeGreaterThan(-1);
  const nextFn = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
  return sql.slice(start, nextFn > -1 ? nextFn : sql.length);
}

// Strips `-- ...` line comments so "must never appear in executable code"
// assertions can't be defeated (or falsely tripped) by explanatory prose that
// legitimately mentions the old, replaced pattern by name.
function stripLineComments(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

const bridgeBody = extractFunctionBody('phoenix_create_transfer_draft_from_suggestion');
const helperBody = extractFunctionBody('_phoenix_live_suggestion_scope_position');
const bridgeCode = stripLineComments(bridgeBody);
const helperCode = stripLineComments(helperBody);
const sqlCode = stripLineComments(sql);

describe('phoenix_create_transfer_draft_from_suggestion never uses inventory_alerts as an executional balance source (LIVE-BALANCE-FIX-148)', () => {
  it('never reads inventory_alerts inside the bridge function\'s executable code', () => {
    expect(bridgeCode).not.toMatch(/inventory_alerts/);
  });

  it('never reads observed_available, threshold_reorder_point, or threshold_target_max in any executable code in this migration', () => {
    expect(sqlCode).not.toMatch(/observed_available/);
    expect(sqlCode).not.toMatch(/threshold_reorder_point/);
    expect(sqlCode).not.toMatch(/threshold_target_max/);
  });

  it('headroom/deficit are derived from the live helper, not a cached snapshot', () => {
    expect(bridgeBody).toMatch(/_phoenix_live_suggestion_scope_position/);
    expect(bridgeBody).toMatch(/v_headroom\s*:=\s*GREATEST\(COALESCE\(v_src_pos\.live_available/);
    expect(bridgeBody).toMatch(/v_deficit\s*:=\s*GREATEST\(COALESCE\(v_tgt_pos\.reorder_point/);
  });

  it('deficit is never floored to a spurious 1-unit minimum (GREATEST(..., 0), not GREATEST(..., 1))', () => {
    expect(bridgeCode).not.toMatch(/GREATEST\([^)]*,\s*1\)/);
  });

  it('the live-position helper locks its contributing rows (FOR UPDATE), never an unlocked aggregate', () => {
    expect(helperCode).toMatch(/FOR UPDATE/);
    // Postgres forbids FOR UPDATE together with an aggregate function in the
    // same query — the helper must never attempt SUM(...) ... FOR UPDATE.
    expect(helperCode).not.toMatch(/SUM\([^)]*\)[\s\S]{0,120}FOR UPDATE/);
  });

  it('the live-position helper validates the scope actually belongs to the claimed organization', () => {
    expect(helperBody).toMatch(/phoenix_inventory_scope_org/);
    expect(helperBody).toMatch(/scope_not_in_organization/);
  });

  it('the live-position helper is internal only — not directly callable by anon or authenticated', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_live_suggestion_scope_position\(uuid, text, uuid, text, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\._phoenix_live_suggestion_scope_position/,
    );
  });

  it('the bridge still delegates to the three unchanged route RPCs, never touching stock/movement tables directly', () => {
    for (const forbidden of [
      /INSERT INTO public\.warehouse_stock\b/,
      /UPDATE public\.warehouse_stock\b/,
      /INSERT INTO public\.outlet_stock\b/,
      /UPDATE public\.outlet_stock\b/,
      /INSERT INTO public\.warehouse_stock_movements\b/,
      /INSERT INTO public\.outlet_stock_movements\b/,
      /INSERT INTO public\.phoenix_movement_events\b/,
    ]) {
      expect(bridgeBody).not.toMatch(forbidden);
    }
    expect(bridgeBody).toMatch(/phoenix_create_direct_warehouse_transfer_request/);
    expect(bridgeBody).toMatch(/phoenix_add_warehouse_transfer_request_line/);
    expect(bridgeBody).toMatch(/phoenix_create_warehouse_dispatch/);
    expect(bridgeBody).toMatch(/phoenix_add_dispatch_line_fefo_guarded/);
    expect(bridgeBody).toMatch(/phoenix_request_outlet_return/);
    expect(bridgeBody).toMatch(/phoenix_add_outlet_return_request_line/);
  });

  it('FEFO/provenance/idempotency mechanics are untouched: still the same batch FOR UPDATE, dispatch-line request_id, and provenance FOR SHARE', () => {
    expect(bridgeBody).toMatch(/FOR UPDATE/);
    expect(bridgeBody).toMatch(/p_suggestion_id\)/); // request_id passed to the FEFO-guarded add-line call
    expect(bridgeBody).toMatch(/FOR SHARE/);
    expect(bridgeBody).toMatch(/provenance_dispatch_line_id/);
  });
});
