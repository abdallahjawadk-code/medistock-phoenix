/**
 * WAREHOUSE-GENERATION-FAIL-CLOSED-079-A + REVOKE-UNGUARDED-080-A
 * Static SQL contract tests. CRLF-normalized, DB-free.
 *
 * The DYNAMIC proof for these two lives in
 * docs/phoenix/migration-078-079-dynamic-validation.md — both were executed on a
 * disposable PostgreSQL 18.4 cluster with 001-080 applied in order. These static
 * tests pin the properties that must not silently regress in review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const N79 = '079_phoenix_warehouse_generation_fail_closed.sql';
const N80 = '080_phoenix_revoke_unguarded_warehouse_writers.sql';
const read = (n: string) => readFileSync(join(ROOT, 'supabase/migrations', n), 'utf8').replace(/\r\n?/g, '\n');
const sql79 = read(N79);
const sql80 = read(N80);
const stripComments = (s: string) => s.replace(/^[ \t]*--.*$/gm, '');
const code79 = stripComments(sql79.slice(sql79.indexOf('BEGIN;'), sql79.indexOf('\nCOMMIT;')));
const code80 = stripComments(sql80.slice(sql80.indexOf('BEGIN;'), sql80.indexOf('\nCOMMIT;')));

describe('both are registered and manual-apply only', () => {
  it.each([N79, N80])('%s is in the reviewed registry', (n) => {
    expect(REVIEWED_MIGRATION_FILES).toContain(n);
  });

  it.each([[N79, sql79], [N80, sql80]] as const)('%s is MANUAL APPLY ONLY', (_n, s) => {
    expect(s).toContain('MANUAL APPLY ONLY');
    expect(s).toMatch(/DO NOT use `supabase db push`/);
  });

  it.each([[N79, sql79], [N80, sql80]] as const)('%s is a single transaction', (_n, s) => {
    expect(s).toMatch(/^BEGIN;/m);
    expect(s).toMatch(/^COMMIT;/m);
  });
});

describe('079 makes the guard fail closed', () => {
  it('rejects a NULL expected generation in BOTH guarded RPCs', () => {
    expect((code79.match(/expected_generation_required/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code79.match(/p_expected_generation IS NULL/g) ?? []).length).toBe(2);
  });

  it('uses a check-violation code for the refusal, not the conflict code', () => {
    const block = code79.slice(code79.indexOf('expected_generation_required'));
    expect(block.slice(0, 300)).toContain("ERRCODE = '23514'");
    expect(block.slice(0, 300)).not.toContain('40001');
  });

  it('keeps the EXACT signatures, so CREATE OR REPLACE replaces and adds no overload', () => {
    // Same parameter list as 078, p_expected_generation still DEFAULT NULL —
    // the DEFAULT is what preserves function identity; the body is what refuses.
    expect(code79).toContain('p_expected_generation    bigint  DEFAULT NULL');
    expect(code79).toContain('p_expected_generation    bigint DEFAULT NULL');
    expect(code79).not.toMatch(/DROP FUNCTION/);
  });

  it('an absent lot is still explicitly generation 0, so a FIRST receipt works', () => {
    expect(code79).toContain('v_seq := COALESCE(v_seq, 0)');
  });

  it('still checks REPLAY before the generation, keeping retries idempotent', () => {
    const replay = code79.indexOf('reference_id   = p_request_id');
    const conflict = code79.indexOf('warehouse_receipt_generation_conflict');
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(conflict);
  });

  it('leaves the legacy RPCs untouched, so it is safe under a live client', () => {
    expect(code79).not.toMatch(/REVOKE/);
    expect(code79).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_stock\s*\(/);
  });

  it('keeps SECURITY DEFINER and a pinned search_path on both', () => {
    expect((code79.match(/SECURITY DEFINER\s+SET search_path = public, pg_temp/g) ?? []).length).toBe(2);
  });

  it('aborts if 078 is not applied', () => {
    expect(code79).toContain("column_name='movement_seq'");
    expect(code79).toMatch(/precondition failed/);
  });
});

describe('080 is the cutover that makes the boundary real', () => {
  it('revokes EXECUTE on BOTH unguarded writers from authenticated', () => {
    expect(code80).toMatch(/REVOKE EXECUTE ON FUNCTION public\.phoenix_receive_warehouse_stock\(/);
    expect(code80).toMatch(/REVOKE EXECUTE ON FUNCTION public\.phoenix_apply_warehouse_stock_movement\(/);
    expect((code80.match(/FROM authenticated;/g) ?? []).length).toBe(2);
  });

  it('does NOT drop them — the guarded RPCs delegate to those bodies', () => {
    expect(code80).not.toMatch(/DROP FUNCTION/);
  });

  it('does not touch the guarded RPCs', () => {
    expect(code80).not.toMatch(/REVOKE[^;]*_guarded/);
  });

  it('refuses to run unless 079 is already applied', () => {
    // Revoking the legacy path while the guarded path still tolerated a NULL
    // generation would leave NO effective guard at all.
    expect(code80).toContain('expected_generation_required');
    expect(code80).toMatch(/079 not applied/);
  });

  it('refuses to run unless 078 is applied', () => {
    expect(code80).toMatch(/078 not applied/);
  });

  it('is explicitly ordered last and warns against premature apply', () => {
    expect(sql80).toContain('CUTOVER');
    expect(sql80).toMatch(/DO NOT APPLY THIS UNTIL CLIENT PARITY IS PROVEN/);
    expect(sql80).toMatch(/078 -> 079 -> .* -> 080/);
  });

  it('documents that a client-side name choice is not a security control', () => {
    expect(sql80).toMatch(/is NOT a security control/);
  });

  it('ships an instant, lossless rollback (grants only)', () => {
    expect(sql80).toContain('ROLLBACK / CONTAINMENT');
    expect(sql80).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_receive_warehouse_stock\(/);
  });
});

describe('both ship operational SQL', () => {
  it.each([[N79, sql79], [N80, sql80]] as const)('%s has post-conditions', (_n, s) => {
    expect(s).toContain('POST-CONDITIONS');
  });

  it('079 records that it WAS executed, unlike 078 at authoring time', () => {
    expect(sql79).toMatch(/HAS been\s*\n?-- executed/);
    expect(sql79).toContain('PostgreSQL 18.4');
  });
});
