/**
 * INVENTORY-DERIVED-AVAILABILITY-083 — static SQL contract tests.
 *
 * The dynamic proof (real outlet_stock → phoenix_available_stock across the
 * Blocker-3 case matrix, plus a real dispatch→receive chain) is in
 * 083-availability-projection.dynamic.test.ts (gated on a live Postgres) and
 * recorded in docs/phoenix/migration-083-availability-validation.md. These pin
 * the properties that must not regress in review:
 *
 *   Part A — the outlet projection WRITER repair is exactly an ON-CONFLICT /
 *            SUM identity fix (8 columns incl. internal_batch_reference), stays
 *            server-only, and drops nothing.
 *   Part B — the READ projection derives ONLY from canonical outlet_stock, never
 *            trusts a manually written quantity, excludes expired from usable,
 *            is least-granted and RLS-scoped so forbidden == nonexistent, and is
 *            independent of catalogue visibility.
 *
 * It is a staged step: it applies NO REVOKE of the manual availability writers
 * and drops item_availability nothing — the parity-gated cutover is separate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { stripSqlComments, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '083_phoenix_inventory_derived_availability.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const active = stripSqlComments(sql);
const exec = executableSql(sql);

const partA = sqlFunctionSource(sql, 'phoenix_project_outlet_availability');
const partB = sqlFunctionSource(sql, 'phoenix_available_stock');

describe('registration and apply discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
  it('aborts fail-closed if canonical stock or the audited condition policy is missing', () => {
    expect(active).toMatch(/to_regclass\('public\.outlet_stock'\) IS NULL/);
    expect(active).toMatch(/to_regprocedure\('public\.phoenix_derive_outlet_availability_condition\(integer, date\)'\) IS NULL/);
  });
  it('refuses to apply Part A blindly if the 8-column identity index is not present as audited', () => {
    expect(active).toContain('item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq');
    expect(active).toMatch(/internal_batch_reference[\s\S]*would be wrong|re-audit before applying/);
  });
});

describe('this is a staged, additive step — it retires nothing yet', () => {
  it('drops no table and no function', () => {
    expect(exec).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(exec).not.toMatch(/\bDROP\s+FUNCTION\b/i);
  });
  it('does not revoke the manual availability writer (cutover is a separate migration)', () => {
    expect(exec).not.toMatch(/REVOKE[\s\S]*phoenix_upsert_availability/i);
  });
  it('does not make item_availability read-only or otherwise lock it down here', () => {
    expect(exec).not.toMatch(/ALTER\s+TABLE\s+public\.item_availability/i);
  });
});

describe('Part A — the outlet projection writer repair', () => {
  it('exists', () => expect(partA).not.toBeNull());
  it('aligns the ON CONFLICT to the real 8-column identity (adds internal_batch_reference)', () => {
    // The whole point of the repair: internal_batch_reference is the 8th column.
    expect(partA!).toMatch(/ON CONFLICT[\s\S]*internal_batch_reference[\s\S]*DO UPDATE/i);
  });
  it('also sums the projection over the same 8-part identity', () => {
    expect(partA!).toMatch(/COALESCE\(s\.internal_batch_reference, ''\)\s*\n?\s*=\s*COALESCE\(v_stock\.internal_batch_reference, ''\)/);
  });
  it('stays server-only — no client role may execute it', () => {
    expect(active).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_project_outlet_availability\(uuid\)\s*\n?\s*FROM PUBLIC, anon, authenticated/);
    expect(active).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_project_outlet_availability\(uuid\) TO (authenticated|anon)/);
  });
});

describe('Part B — the read-only, server-authoritative availability projection', () => {
  it('exists', () => expect(partB).not.toBeNull());
  it('is a STABLE SECURITY DEFINER function with a pinned search_path', () => {
    expect(partB!).toMatch(/LANGUAGE plpgsql/);
    expect(partB!).toMatch(/\bSTABLE\b/);
    expect(partB!).toMatch(/SECURITY DEFINER/);
    expect(partB!).toMatch(/SET search_path = public, pg_temp/);
  });
  it('derives availability ONLY from canonical outlet_stock', () => {
    expect(partB!).toMatch(/FROM public\.outlet_stock\b/);
  });
  it('never trusts a manually written item_availability quantity (does not read or write it)', () => {
    const b = executableSql(partB!);
    expect(b).not.toMatch(/\bFROM\s+public\.item_availability\b/i);
    expect(b).not.toMatch(/\bINSERT\s+INTO\s+public\.item_availability\b/i);
    expect(b).not.toMatch(/\bUPDATE\s+public\.item_availability\b/i);
  });
  it('excludes expired/missing from the usable figure', () => {
    expect(partB!).toMatch(/usable_quantity[\s\S]*CASE WHEN[\s\S]*IN \('expired','missing'\)[\s\S]*THEN 0/);
  });
  it('derives condition through the audited 067 policy, inventing no new rule', () => {
    expect(partB!).toMatch(/phoenix_derive_outlet_availability_condition\(/);
  });
  it('is RLS-scoped so forbidden and nonexistent are indistinguishable (both empty)', () => {
    // super_admin OR same-org; anything else falls through to the empty result.
    expect(partB!).toMatch(/v_role = 'super_admin'\s+OR\s+\(v_org IS NOT NULL AND v_dp_org = v_org\)/);
    expect(partB!).toMatch(/RETURN v_empty/);
  });
  it('is least-granted: revoked from PUBLIC, executable only by authenticated', () => {
    expect(active).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_available_stock\(uuid\) FROM PUBLIC/);
    expect(active).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_available_stock\(uuid\) TO authenticated/);
    expect(active).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_available_stock\(uuid\) TO anon/);
  });
});
