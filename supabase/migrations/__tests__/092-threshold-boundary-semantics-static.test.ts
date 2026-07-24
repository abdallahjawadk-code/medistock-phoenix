/**
 * 092-THRESHOLD-BOUNDARY-SEMANTICS — reconciliation test for the
 * functional-closure task's Section 3.
 *
 * Reads 092's ACTUAL phoenix_status_prepare_report SQL text (never modified —
 * 092 is a historical migration) and asserts the EXACT classification
 * comparisons it performs, so the field-name and boundary-operator mapping
 * against the task brief's stated contract is proven by the real source, not
 * assumed.
 *
 * FINDINGS (documented here, not silently "fixed" — see 111's header comment
 * for why a live semantics change was judged out of scope for a single
 * "genuinely missing, easy to add" gap):
 *
 *   Brief says                          092's actual code (phoenix_status_prepare_report)
 *   -----------------------------------  --------------------------------------------------
 *   available = on_hand - reserved       v_available := v_on_hand - v_reserved;             — MATCHES.
 *   scarce = 0 < available <= scarce_th  v_available <= v_thr_reorder_point                  — the field is
 *                                        named reorder_point, not scarce_threshold (a
 *                                        documented rename, not a functional gap), BUT the
 *                                        brief's "0 <" lower bound is NOT enforced: at
 *                                        available = 0 the code still classifies 'scarce'
 *                                        (no distinct zero/"unavailable" branch exists) —
 *                                        a genuine boundary mismatch.
 *   surplus = available >= surplus_th    v_available > v_thr_target_max                      — STRICT
 *                                        greater-than, not >=: at available EXACTLY equal to
 *                                        target_max, the brief's contract says 'surplus',
 *                                        092's code says 'available' — a genuine boundary
 *                                        mismatch.
 *   unavailable at available = 0,        NOT PRESENT as a distinct classification value —
 *   distinct from scarce/missing         suggested_classification's CHECK constraint only
 *                                        allows ('available','scarce','surplus'); available=0
 *                                        falls into 'scarce' (or 'available' if no threshold
 *                                        row exists for that material).
 *
 * This is a real, precise discrepancy between the task brief's stated
 * contract and 092's already-live classification math — reported for an
 * explicit product decision, not silently patched into a historical
 * migration (which this task must never touch) or silently reinterpreted as
 * "already correct."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '092_phoenix_monthly_status_redesign.sql';

const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');

describe('092 phoenix_status_prepare_report — actual classification boundary math', () => {
  const fnIdx = sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report');
  const fnBlock = sql.slice(fnIdx, sql.indexOf('$$;', fnIdx) + 3);

  it('available is on_hand minus reserved, exactly as the brief specifies', () => {
    expect(fnBlock).toMatch(/v_available\s*:=\s*v_on_hand\s*-\s*v_reserved;/);
  });

  it('field names are reorder_point / target_max, NOT scarce_threshold / surplus_threshold (a naming difference only)', () => {
    expect(fnBlock).toMatch(/v_thr_reorder_point/);
    expect(fnBlock).toMatch(/v_thr_target_max/);
    expect(fnBlock).not.toMatch(/scarce_threshold|surplus_threshold/);
  });

  it('DISCREPANCY 1 — surplus uses strict ">" against target_max, not the brief\'s ">="', () => {
    expect(fnBlock).toMatch(/v_available > v_thr_target_max THEN 'surplus'/);
    expect(fnBlock).not.toMatch(/v_available >= v_thr_target_max/);
  });

  it('DISCREPANCY 2 — scarce has no explicit "available > 0" lower bound; available=0 still classifies scarce', () => {
    expect(fnBlock).toMatch(/v_available <= v_thr_reorder_point THEN 'scarce'/);
    // No branch anywhere in this function tests `v_available = 0` or `> 0`
    // before the scarce comparison — confirming the brief's "0 < available"
    // lower bound is genuinely absent from the live logic.
    expect(fnBlock).not.toMatch(/v_available\s*=\s*0/);
    expect(fnBlock).not.toMatch(/v_available\s*>\s*0/);
  });

  it('DISCREPANCY 3 — suggested_classification has no distinct "unavailable" value', () => {
    const colDefIdx = sql.indexOf('suggested_classification');
    const constraintLine = sql.slice(colDefIdx, sql.indexOf('\n', sql.indexOf('CHECK', colDefIdx)));
    expect(constraintLine).toMatch(/'available', 'scarce', 'surplus'/);
    expect(constraintLine).not.toMatch(/unavailable/);
  });

  it('the three-way suggested-classification CASE is exhaustive with ELSE available (no other branch)', () => {
    const caseIdx = fnBlock.indexOf('v_suggested := CASE');
    const caseBlock = fnBlock.slice(caseIdx, fnBlock.indexOf('END;', caseIdx));
    const whenCount = (caseBlock.match(/WHEN/g) ?? []).length;
    expect(whenCount).toBe(2); // surplus, scarce — ELSE 'available' covers everything else
    expect(caseBlock).toMatch(/ELSE\s+'available'/);
  });
});
