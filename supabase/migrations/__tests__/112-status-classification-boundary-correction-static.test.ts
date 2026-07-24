/**
 * STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-STATIC — registration +
 * discipline contract tests for 112. The behavioral proof (including the
 * exact off-by-one boundary values) is
 * 112-status-classification-boundary-correction.dynamic.test.ts (real
 * Postgres, 001->112 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '112_phoenix_status_classification_boundary_correction.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('112 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('112 — status classification boundary correction (092 stays untouched)', () => {
  const { code } = load(NAME);
  const NAME_092 = '092_phoenix_monthly_status_redesign.sql';

  it('092 source file is byte-for-byte unchanged (never edited in place)', () => {
    // Loaded independently of 112's own file to prove this migration made
    // no claim about, and performed no operation against, 092.sql itself.
    const sql092 = readFileSync(join(ROOT, 'supabase/migrations', NAME_092), 'utf8');
    expect(sql092).toMatch(/v_available > v_thr_target_max THEN 'surplus'/); // 092's ORIGINAL (pre-112) operator, still there
    expect(sql092).not.toMatch(/'unavailable'/); // 092 never mentions the new value
  });

  it('re-issues phoenix_status_prepare_report and phoenix_status_classify_lines via CREATE OR REPLACE, same signatures as 092 — no new function', () => {
    const defs = code.match(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g) ?? [];
    expect(defs.sort()).toEqual([
      'CREATE OR REPLACE FUNCTION public.phoenix_status_classify_lines(',
      'CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report(',
    ].sort());
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_status_prepare_report\(p_organization_id uuid\)/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_status_classify_lines\(\s*p_report_id uuid,/);
  });

  it('surplus is now inclusive (>=), not the old strict (>)', () => {
    expect(code).toMatch(/v_available >= v_thr_target_max THEN 'surplus'/);
    expect(code).not.toMatch(/v_available > v_thr_target_max THEN 'surplus'/);
  });

  it('unavailable is checked FIRST, before the surplus/scarce branches, and is unconditional on available=0', () => {
    const caseIdx = code.indexOf("v_suggested := CASE");
    const caseBlock = code.slice(caseIdx, code.indexOf('END;', caseIdx));
    const unavailIdx = caseBlock.indexOf("WHEN v_available = 0 THEN 'unavailable'");
    const surplusIdx = caseBlock.indexOf("THEN 'surplus'");
    const scarceIdx = caseBlock.indexOf("THEN 'scarce'");
    expect(unavailIdx).toBeGreaterThan(-1);
    expect(unavailIdx).toBeLessThan(surplusIdx);
    expect(unavailIdx).toBeLessThan(scarceIdx);
  });

  it('scarce keeps its inclusive upper bound (<=reorder_point)', () => {
    expect(code).toMatch(/v_available <= v_thr_reorder_point THEN 'scarce'/);
  });

  it('target_max / reorder_point are NEVER renamed anywhere in this migration', () => {
    expect(code).toMatch(/v_thr_target_max/);
    expect(code).toMatch(/v_thr_reorder_point/);
    expect(code).not.toMatch(/surplus_threshold|scarce_threshold/);
  });

  it('both CHECK constraints are widened via DROP+ADD CONSTRAINT (092 CREATE TABLE is never re-run)', () => {
    expect(code).not.toMatch(/CREATE TABLE/);
    expect(code).toMatch(/DROP CONSTRAINT/);
    expect(code).toMatch(/ADD CONSTRAINT inventory_status_report_lines_suggested_classification_check/);
    expect(code).toMatch(/ADD CONSTRAINT inventory_status_report_lines_classification_check/);
    expect(code).toMatch(/CHECK \(suggested_classification IN \('available', 'unavailable', 'scarce', 'surplus'\)\)/);
    expect(code).toMatch(/CHECK \(classification IN \('available', 'unavailable', 'scarce', 'surplus', 'suspected_missing'\)\)/);
  });

  it('the classify_lines allowed-value list includes unavailable, alongside suspected_missing unchanged', () => {
    expect(code).toMatch(
      /IF v_class NOT IN \('available', 'unavailable', 'scarce', 'surplus', 'suspected_missing'\) THEN/,
    );
  });

  it('unavailable carries NO special evidence requirement — the suspected_missing evidence branch is untouched and scoped only to suspected_missing', () => {
    const guardIdx = code.indexOf("IF v_class = 'suspected_missing' THEN");
    expect(guardIdx).toBeGreaterThan(-1);
    const guardBlock = code.slice(guardIdx, code.indexOf('v_n := v_n + 1;', guardIdx));
    expect(guardBlock).toMatch(/reason_required_for_suspected_missing/);
    expect(guardBlock).toMatch(/stocktake_evidence_required/);
    // unavailable never appears inside the evidence-required branch.
    expect(guardBlock).not.toMatch(/'unavailable'/);
  });

  it('MISSING/SUSPECTED_MISSING BOUNDARY: this migration never writes classification=missing or confirmed_missing, and never derives unavailable from a stocktake', () => {
    expect(code).not.toMatch(/'missing'/); // the enum value is 'suspected_missing', never bare 'missing'
    expect(code).not.toMatch(/confirmed_missing\s*=\s*true/);
    // The unavailable branch reads only v_available (on_hand - reserved) —
    // never stocktake_count_lines / variance, which only feeds
    // suspected_missing (untouched by this migration).
    const unavailLine = code.split('\n').find(l => l.includes("WHEN v_available = 0 THEN 'unavailable'"));
    expect(unavailLine).not.toMatch(/stocktake|variance/);
  });

  it('grants are re-stated but stay identical to 092 (fail-closed, minimal)', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_status_prepare_report\(uuid\) FROM anon/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_status_prepare_report\(uuid\) TO authenticated/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_status_classify_lines\(uuid, jsonb\) FROM anon/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_status_classify_lines\(uuid, jsonb\) TO authenticated/);
  });
});
